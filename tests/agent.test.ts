import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { getScenario } from "../src/scenarios/index.ts";
import { MockMetronomeClient } from "../src/metronome/mock.ts";
import { investigate } from "../src/agent/loop.ts";
import { createHooks, denyAll } from "../src/agent/hooks.ts";

/** Scripted fake model: replays a fixed sequence of assistant turns. */
function fakeClient(turns: Anthropic.ContentBlock[][]) {
  const seen: Anthropic.MessageCreateParamsNonStreaming[] = [];
  let i = 0;
  return {
    seen,
    messages: {
      async create(body: Anthropic.MessageCreateParamsNonStreaming) {
        seen.push(structuredClone(body));
        const content = turns[i++] ?? [];
        return {
          id: `m${i}`, type: "message", role: "assistant", model: "fake", content,
          stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 },
        } as unknown as Anthropic.Message;
      },
    },
  };
}
const use = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input }) as Anthropic.ContentBlock;

const goodDiagnosis = {
  status: "root_cause_found",
  root_causes: [{ code: "EVENT_TYPE_NOT_MATCHED", summary: "event_type typo", fix: "rename to api_request" }],
  confidence: 0.9,
  customer_reply: "Your emitter sends api_requests; the metric expects api_request. Rename it and usage will flow.",
  internal_notes: "run_event_checks",
};

test("loop runs tools, blocks unapproved writes, and stops on a valid diagnosis", async () => {
  const s = getScenario("event-type-typo");
  const mc = new MockMetronomeClient(s.world);
  const hooks = createHooks({ approver: denyAll });
  const client = fakeClient([
    [use("t1", "run_event_checks", { transaction_ids: ["et1"] })],
    [use("t2", "replay_events", { events: [{ transaction_id: "n1", customer_id: "acme-123", event_type: "api_request", timestamp: s.now }] })],
    [use("t3", "submit_diagnosis", { ...goodDiagnosis, customer_reply: "short" })], // invalid → must retry
    [use("t4", "submit_diagnosis", goodDiagnosis)],
  ]);

  const r = await investigate(s.ticket, mc, hooks, new Date(s.now), { client });

  assert.equal(r.stop, "diagnosis_submitted");
  assert.equal(r.turns, 4);
  assert.equal(r.diagnosis?.root_causes[0]?.code, "EVENT_TYPE_NOT_MATCHED");
  assert.equal(mc.ingested.length, 0, "write was blocked by hook");
  assert.ok(hooks.trace.find((t) => t.name === "replay_events")?.blocked);
  assert.equal(r.usage.input_tokens, 400);

  // The tool result fed back to the model contains real findings.
  const secondCall = client.seen[1]!;
  const toolResult = JSON.stringify(secondCall.messages.at(-1));
  assert.match(toolResult, /EVENT_TYPE_NOT_MATCHED/);
  // System prompt is cached.
  assert.ok(JSON.stringify(secondCall.system).includes("ephemeral"));
});

test("approved writes execute", async () => {
  const s = getScenario("unregistered-alias");
  const mc = new MockMetronomeClient(s.world);
  const hooks = createHooks({ approver: async () => true });
  const client = fakeClient([
    [use("t1", "replay_events", { events: [{ transaction_id: "fix1", customer_id: "acme-123", event_type: "api_request", timestamp: s.now }] })],
    [use("t2", "submit_diagnosis", { ...goodDiagnosis, root_causes: [{ code: "CUSTOMER_NOT_RESOLVED", summary: "alias", fix: "add alias" }] })],
  ]);
  const r = await investigate(s.ticket, mc, hooks, new Date(s.now), { client });
  assert.equal(r.stop, "diagnosis_submitted");
  assert.equal(mc.ingested.length, 1);
});

test("model that never submits is nudged once then stops", async () => {
  const s = getScenario("healthy");
  const text = [{ type: "text", text: "Looks fine.", citations: null }] as unknown as Anthropic.ContentBlock[];
  const client = fakeClient([text, text]);
  const r = await investigate(s.ticket, new MockMetronomeClient(s.world), createHooks({ approver: denyAll }), new Date(s.now), { client });
  assert.equal(r.stop, "no_diagnosis");
  assert.equal(r.turns, 2);
});

test("max turns guard", async () => {
  const s = getScenario("healthy");
  const loopy = Array.from({ length: 5 }, (_, i) => [use(`x${i}`, "list_billable_metrics", {})]);
  const r = await investigate(s.ticket, new MockMetronomeClient(s.world), createHooks({ approver: denyAll }), new Date(s.now), { client: fakeClient(loopy), maxTurns: 3 });
  assert.equal(r.stop, "max_turns");
});

test("identical read-only calls are served from cache, not re-executed", async () => {
  const s = getScenario("region-case");
  const mc = new MockMetronomeClient(s.world);
  let searches = 0;
  const orig = mc.searchEvents.bind(mc);
  mc.searchEvents = async (ids) => { searches++; return orig(ids); };
  const checks = { transaction_ids: ["rc1", "rc2"] };
  const client = fakeClient([
    // A "wasteful" model: repeats the same check twice in one turn and again next turn.
    [use("a", "run_event_checks", checks), use("b", "run_event_checks", checks)],
    [use("c", "run_event_checks", checks)],
    [use("d", "submit_diagnosis", { ...goodDiagnosis, root_causes: [{ code: "PROPERTY_FILTER_EXCLUDED", summary: "case", fix: "US" }] })],
  ]);
  const r = await investigate(s.ticket, mc, createHooks({ approver: denyAll }), new Date(s.now), { client });
  assert.equal(r.stats.tool_calls, 1);
  assert.equal(r.stats.duplicate_calls, 2);
  assert.equal(searches, 1, "Metronome was queried once instead of three times");
  assert.match(JSON.stringify(client.seen[1]!.messages.at(-1)), /already made this exact call/);
});

test("low-confidence diagnosis is routed to a human by the loop", async () => {
  const s = getScenario("event-type-typo");
  const client = fakeClient([[use("d", "submit_diagnosis", { ...goodDiagnosis, confidence: 0.4 })]]);
  const r = await investigate(s.ticket, new MockMetronomeClient(s.world), createHooks({ approver: denyAll }), new Date(s.now), { client });
  assert.equal(r.diagnosis?.status, "needs_human");
  assert.ok(r.stats.confidence_override);
  assert.match(r.diagnosis!.internal_notes, /routed to a human/);
});

test("invalid diagnosis attempts are counted", async () => {
  const s = getScenario("event-type-typo");
  const client = fakeClient([
    [use("x", "submit_diagnosis", { ...goodDiagnosis, confidence: 7 })],
    [use("y", "submit_diagnosis", goodDiagnosis)],
  ]);
  const r = await investigate(s.ticket, new MockMetronomeClient(s.world), createHooks({ approver: denyAll }), new Date(s.now), { client });
  assert.equal(r.stats.invalid_diagnoses, 1);
  assert.equal(r.turns, 2);
});

test("explain_price tool is wired through the loop", async () => {
  const s = getScenario("missing-override");
  const client = fakeClient([
    [use("p", "explain_price", { customer_id: "cust_acme", invoice_id: "inv_aug", line_item_name: "API Requests", expected_unit_price: 0.0007 })],
    [use("d", "submit_diagnosis", { ...goodDiagnosis, root_causes: [{ code: "PRICING_OVERRIDE_MISSING", summary: "no override", fix: "add one" }] })],
  ]);
  const r = await investigate(s.ticket, new MockMetronomeClient(s.world), createHooks({ approver: denyAll }), new Date(s.now), { client });
  assert.equal(r.stop, "diagnosis_submitted");
  const fed = JSON.stringify(client.seen[1]!.messages.at(-1));
  assert.match(fed, /PRICING_OVERRIDE_MISSING/);
  assert.match(fed, /list_price/);
});
