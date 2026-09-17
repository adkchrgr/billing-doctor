import Anthropic from "@anthropic-ai/sdk";
import type { Scenario } from "../scenarios/index.ts";
import type { MetronomeClient } from "../metronome/client.ts";
import { buildTools } from "./tools.ts";
import type { Hooks } from "./hooks.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";
import { type Diagnosis, validateDiagnosis } from "./diagnosis.ts";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface LoopStats {
  tool_calls: number; // tools actually executed
  duplicate_calls: number; // identical calls answered from cache
  blocked_calls: number; // refused by hooks
  invalid_diagnoses: number; // submit_diagnosis rejected by validation
  nudges: number;
  confidence_override: boolean; // loop downgraded a low-confidence diagnosis
}

export interface InvestigationResult {
  diagnosis: Diagnosis | null;
  stop: "diagnosis_submitted" | "max_turns" | "token_budget" | "no_diagnosis";
  turns: number;
  usage: Usage;
  stats: LoopStats;
}

export interface LoopOptions {
  model?: string;
  maxTurns?: number;
  tokenBudget?: number; // input+output tokens cap per investigation
  /** Below this, the LOOP (not the model) routes the ticket to a human. */
  minConfidence?: number;
  onEvent?: (msg: string) => void;
  /** Injectable for tests; defaults to a real client using ANTHROPIC_API_KEY. */
  client?: { messages: { create(body: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> } };
}

/**
 * The agentic loop, written by hand (no framework) so every decision is visible:
 *   model → tool_use? → hooks → run tool → tool_result → repeat
 * Stop conditions: submit_diagnosis, end_turn without tools (nudged once),
 * max turns, or token budget.
 */
export async function investigate(
  ticket: Scenario["ticket"],
  mc: MetronomeClient,
  hooks: Hooks,
  now: Date,
  opts: LoopOptions = {},
): Promise<InvestigationResult> {
  const anthropic = opts.client ?? new Anthropic();
  const model = opts.model ?? process.env.BILLING_DOCTOR_MODEL ?? "claude-sonnet-4-5";
  const maxTurns = opts.maxTurns ?? 12;
  const budget = opts.tokenBudget ?? 150_000;
  const log = opts.onEvent ?? (() => {});
  const minConfidence = opts.minConfidence ?? 0.6;
  const stats: LoopStats = { tool_calls: 0, duplicate_calls: 0, blocked_calls: 0, invalid_diagnoses: 0, nudges: 0, confidence_override: false };
  // Read-only tool results are deterministic within one investigation, so
  // identical repeat calls are served from cache instead of re-executed.
  const cache = new Map<string, string>();
  const done = (r: Omit<InvestigationResult, "usage" | "stats">): InvestigationResult => ({ ...r, usage, stats });

  const tools = buildTools(mc, now);
  const apiTools: Anthropic.Tool[] = tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool["input_schema"],
    // Cache breakpoint after the last tool: system + tools are reused every turn.
    ...(i === tools.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));

  const usage: Usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content:
        `New ticket\nSubject: ${ticket.subject}\nCustomer (Metronome ID): ${ticket.customer_id}\n` +
        `Transaction IDs shared: ${ticket.transaction_ids.join(", ") || "(none)"}\n` +
        (ticket.invoice ? `Invoice concern: ${JSON.stringify(ticket.invoice)}\n` : "") +
        `\n${ticket.body}`,
    },
  ];
  let nudged = false;

  for (let turn = 1; turn <= maxTurns; turn++) {
    const res = await anthropic.messages.create({
      model,
      max_tokens: 4096,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: apiTools,
      messages,
    });
    usage.input_tokens += res.usage.input_tokens;
    usage.output_tokens += res.usage.output_tokens;
    usage.cache_read_tokens += res.usage.cache_read_input_tokens ?? 0;
    usage.cache_write_tokens += res.usage.cache_creation_input_tokens ?? 0;
    messages.push({ role: "assistant", content: res.content });
    log(`turn ${turn}: stop_reason=${res.stop_reason}`);

    const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) {
      // Model stopped talking without finishing: nudge once, then give up.
      if (nudged) return done({ diagnosis: null, stop: "no_diagnosis", turns: turn });
      nudged = true;
      stats.nudges++;
      messages.push({ role: "user", content: "Please call submit_diagnosis now with your conclusion." });
      continue;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const def = tools.find((t) => t.name === tu.name);
      if (!def) {
        results.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: `Unknown tool ${tu.name}` });
        continue;
      }

      if (def.name === "submit_diagnosis") {
        const err = validateDiagnosis(tu.input);
        if (!err) {
          hooks.postToolUse({ name: def.name, input: tu.input, ok: true, ms: 0 });
          const d = structuredClone(tu.input) as Diagnosis;
          if (d.status === "root_cause_found" && d.confidence < minConfidence) {
            // Deterministic policy beats model self-assessment: low confidence → human.
            d.status = "needs_human";
            d.internal_notes = `[loop] confidence ${d.confidence} < ${minConfidence}; routed to a human.\n` + d.internal_notes;
            stats.confidence_override = true;
          }
          return done({ diagnosis: d, stop: "diagnosis_submitted", turns: turn });
        }
        stats.invalid_diagnoses++;
        results.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: `Invalid diagnosis: ${err}. Fix and resubmit.` });
        continue;
      }

      const gate = await hooks.preToolUse(def, tu.input);
      if (!gate.allow) {
        stats.blocked_calls++;
        hooks.postToolUse({ name: def.name, input: tu.input, ok: false, ms: 0, blocked: gate.reason });
        log(`  ✋ ${def.name} blocked: ${gate.reason}`);
        results.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: gate.reason });
        continue;
      }

      const key = def.name + JSON.stringify(tu.input);
      const cached = def.mutating ? undefined : cache.get(key);
      if (cached !== undefined) {
        stats.duplicate_calls++;
        log(`  ♻️  ${def.name} (duplicate — served from cache)`);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: `(You already made this exact call; same result.) ${cached}` });
        continue;
      }

      const t0 = Date.now();
      try {
        const out = await def.run(tu.input);
        stats.tool_calls++;
        const text = JSON.stringify(out).slice(0, 20_000);
        if (!def.mutating) cache.set(key, text);
        hooks.postToolUse({ name: def.name, input: tu.input, ok: true, ms: Date.now() - t0 });
        log(`  🔧 ${def.name}(${JSON.stringify(tu.input).slice(0, 80)})`);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: text });
      } catch (e) {
        hooks.postToolUse({ name: def.name, input: tu.input, ok: false, ms: Date.now() - t0 });
        results.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: String(e) });
      }
    }
    messages.push({ role: "user", content: results });

    if (usage.input_tokens + usage.output_tokens > budget) {
      return done({ diagnosis: null, stop: "token_budget", turns: turn });
    }
  }
  return done({ diagnosis: null, stop: "max_turns", turns: maxTurns });
}
