#!/usr/bin/env -S npx tsx
import { createInterface } from "node:readline/promises";
import { scenarios, getScenario } from "./scenarios/index.ts";
import { MockMetronomeClient } from "./metronome/mock.ts";
import { HttpMetronomeClient, type MetronomeClient } from "./metronome/client.ts";
import { triageOffline } from "./agent/offline.ts";
import { investigate } from "./agent/loop.ts";
import { createHooks, denyAll, type Approver } from "./agent/hooks.ts";
import { recordUsage, toUsageEvent } from "./metering/meter.ts";
import type { Diagnosis } from "./agent/diagnosis.ts";
import { mkdirSync, writeFileSync } from "node:fs";

interface RunReport { id: string; stop?: string; turns?: number; tokens?: number; cache_read?: number; tool_calls: number; duplicate_calls?: number; blocked_calls?: number; override?: boolean }

const HELP = `billing-doctor — diagnose Metronome usage-billing issues

Usage:
  billing-doctor scenarios                         List sandbox scenarios
  billing-doctor triage  --scenario <id>           Offline deterministic triage (no API keys)
  billing-doctor agent   --scenario <id> [--yes]   Claude agent investigation (needs ANTHROPIC_API_KEY)
  billing-doctor eval    [--agent] [--label name]  Score every scenario; saves runs/eval-*.json for comparison

Live account (instead of --scenario): --live --customer <id> --txn id1,id2 --subject "..." --body "..."
  (needs METRONOME_API_KEY; use a sandbox key)`;

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const tenant = process.env.BILLING_DOCTOR_TENANT ?? "demo-tenant";

const cliApprover: Approver = async (tool, input) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(`\n⚠️  Agent wants to run ${tool}:\n${JSON.stringify(input, null, 2)}\nApprove? [y/N] `);
  rl.close();
  return a.trim().toLowerCase() === "y";
};

function loadCase() {
  if (flag("live")) {
    const mc = new HttpMetronomeClient(process.env.METRONOME_API_KEY ?? "");
    const ticket = {
      subject: opt("subject") ?? "(no subject)",
      body: opt("body") ?? "",
      customer_id: opt("customer") ?? "",
      transaction_ids: (opt("txn") ?? "").split(",").filter(Boolean),
    };
    return { mc: mc as MetronomeClient, ticket, now: new Date(), planted: undefined, id: "live" };
  }
  const s = getScenario(opt("scenario") ?? "");
  return { mc: new MockMetronomeClient(s.world) as MetronomeClient, ticket: s.ticket, now: new Date(s.now), planted: s.planted, id: s.id };
}

function print(d: Diagnosis) {
  console.log(`\nStatus: ${d.status}   Confidence: ${d.confidence}`);
  for (const c of d.root_causes) console.log(`  • [${c.code}] ${c.summary}\n    fix: ${c.fix}`);
  console.log(`\n--- Draft reply ---\n${d.customer_reply}\n`);
}

async function runOne(mode: "offline" | "agent", c: ReturnType<typeof loadCase>, quiet = false) {
  const hooks = createHooks({ approver: flag("yes") ? async () => true : process.stdin.isTTY ? cliApprover : denyAll });
  let diagnosis: Diagnosis | null;
  let usage;
  let outcome: string;
  const report: RunReport = { id: c.id, tool_calls: 0 };
  if (mode === "offline") {
    const r = await triageOffline(c.ticket, c.mc, c.now);
    diagnosis = r.diagnosis;
    outcome = diagnosis.status;
  } else {
    const r = await investigate(c.ticket, c.mc, hooks, c.now, { onEvent: quiet ? undefined : console.log });
    diagnosis = r.diagnosis;
    usage = r.usage;
    outcome = diagnosis?.status ?? `failed:${r.stop}`;
    Object.assign(report, {
      stop: r.stop, turns: r.turns, tokens: usage.input_tokens + usage.output_tokens, cache_read: usage.cache_read_tokens,
      tool_calls: r.stats.tool_calls, duplicate_calls: r.stats.duplicate_calls, blocked_calls: r.stats.blocked_calls, override: r.stats.confidence_override,
    });
    if (!quiet) console.log(`\nstop=${r.stop} turns=${r.turns} tokens in/out=${usage.input_tokens}/${usage.output_tokens} cache_read=${usage.cache_read_tokens} tools=${r.stats.tool_calls} dup=${r.stats.duplicate_calls} blocked=${r.stats.blocked_calls}${r.stats.confidence_override ? " (low confidence → human)" : ""}`);
  }
  const replayed = hooks.trace.filter((t) => t.name === "replay_events" && t.ok)
    .reduce((n, t) => n + ((t.input as { events: unknown[] }).events?.length ?? 0), 0);
  const sent = await recordUsage(toUsageEvent({
    tenant, mode, outcome, ticket_ref: c.id,
    tool_calls: hooks.trace.length, findings: diagnosis?.root_causes.length ?? 0, replayed_events: replayed, usage,
  }));
  if (!quiet) console.log(`metering: ${sent}`);
  return { diagnosis, report };
}

async function main() {
  switch (cmd) {
    case "scenarios":
      for (const s of scenarios) console.log(`${s.id.padEnd(20)} ${s.title}`);
      return;
    case "triage":
    case "agent": {
      const c = loadCase();
      console.log(`Ticket: ${c.ticket.subject}`);
      const { diagnosis: d } = await runOne(cmd === "triage" ? "offline" : "agent", c);
      if (d) print(d); else { console.log("No diagnosis produced — escalate to a human."); process.exitCode = 1; }
      return;
    }
    case "eval": {
      const mode = flag("agent") ? "agent" : "offline";
      let pass = 0;
      const reports: Array<RunReport & { pass: boolean }> = [];
      for (const s of scenarios) {
        const { diagnosis: d, report } = await runOne(mode, { mc: new MockMetronomeClient(s.world), ticket: s.ticket, now: new Date(s.now), planted: s.planted, id: s.id }, true);
        const got = new Set((d?.root_causes ?? []).map((r) => r.code));
        const ok = s.planted.every((p) => got.has(p)) && [...got].every((g) => (s.planted as string[]).includes(g));
        if (ok) pass++;
        reports.push({ ...report, pass: ok });
        const extra = mode === "agent" ? `  turns=${report.turns} tools=${report.tool_calls} dup=${report.duplicate_calls} tokens=${report.tokens} stop=${report.stop}` : "";
        console.log(`${ok ? "PASS" : "FAIL"}  ${s.id.padEnd(20)} expected=[${s.planted}] got=[${[...got]}]${extra}`);
      }
      console.log(`\n${pass}/${scenarios.length} scenarios diagnosed correctly (${mode})`);
      if (mode === "agent") {
        const sum = (k: keyof RunReport) => reports.reduce((n, r) => n + (Number(r[k]) || 0), 0);
        console.log(`totals: turns=${sum("turns")} tool_calls=${sum("tool_calls")} duplicates=${sum("duplicate_calls")} tokens=${sum("tokens")}`);
      }
      // Save for before/after comparisons: git stash a change, re-run, diff the files.
      mkdirSync("runs", { recursive: true });
      const file = `runs/eval-${mode}-${opt("label") ?? new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      writeFileSync(file, JSON.stringify({ mode, pass, total: scenarios.length, reports }, null, 2));
      console.log(`saved ${file}`);
      if (pass !== scenarios.length) process.exitCode = 1;
      return;
    }
    default:
      console.log(HELP);
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
