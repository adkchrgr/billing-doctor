import { test } from "node:test";
import assert from "node:assert/strict";
import { scenarios } from "../src/scenarios/index.ts";
import { MockMetronomeClient } from "../src/metronome/mock.ts";
import { triageOffline } from "../src/agent/offline.ts";
import { toUsageEvent } from "../src/metering/meter.ts";
import { closest } from "../src/checks/matching.ts";

for (const s of scenarios) {
  test(`offline triage finds exactly the planted bugs: ${s.id}`, async () => {
    const { findings } = await triageOffline(s.ticket, new MockMetronomeClient(s.world), new Date(s.now));
    assert.deepEqual([...new Set(findings.map((f) => f.code))].sort(), [...s.planted].sort());
  });
}

test("mock marks reused transaction_ids as duplicates", async () => {
  const s = scenarios.find((x) => x.id === "reused-txn-id")!;
  const evs = await new MockMetronomeClient(s.world).searchEvents(["acme-2026-09-14"]);
  assert.deepEqual(evs.map((e) => e.is_duplicate), [false, true, true]);
});

test("closest() suggests near-miss event types", () => {
  assert.equal(closest("api_requests", ["api_request", "llm_completion"]), "api_request");
  assert.equal(closest("totally_different", ["api_request"]), undefined);
});

test("metering event is idempotent per run and carries token totals", () => {
  const e = toUsageEvent({
    tenant: "t1", mode: "agent", outcome: "root_cause_found", ticket_ref: "x",
    tool_calls: 3, findings: 1, replayed_events: 0,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 80, cache_write_tokens: 0 },
  }, "run-1");
  assert.equal(e.transaction_id, "bd_inv_run-1");
  assert.equal(e.properties?.total_tokens, 150);
  assert.equal(e.event_type, "billing_doctor_investigation");
});

test("transaction IDs Metronome never received are reported, not treated as healthy", async () => {
  const s = scenarios.find((x) => x.id === "healthy")!;
  const ticket = { ...s.ticket, transaction_ids: ["h1", "never-sent-1", "never-sent-2"] };
  const { findings, diagnosis } = await triageOffline(ticket, new MockMetronomeClient(s.world), new Date(s.now));
  assert.deepEqual(findings.map((f) => f.code), ["EVENTS_NOT_FOUND"]);
  assert.match(findings[0]!.summary, /2 of 3/);
  assert.equal(diagnosis.status, "root_cause_found");
});

test("customer reply is written for the customer, not the engineer", async () => {
  const s = scenarios.find((x) => x.id === "wrong-agg-key")!;
  const world = structuredClone(s.world);
  world.events.push({ ...world.events[0]!, transaction_id: "ak2" });
  const { diagnosis } = await triageOffline({ ...s.ticket, transaction_ids: ["ak1", "ak2"] }, new MockMetronomeClient(world), new Date(s.now));
  const reply = diagnosis.customer_reply;
  assert.match(reply, /This affected 2 of the events you shared/);
  assert.match(reply, /How to fix:/);
  assert.doesNotMatch(reply, /emitter|example shown|\[\d+ events\]/);
  assert.match(diagnosis.root_causes[0]!.summary, /\[2 events\]/, "engineers still see the count");
});

test("pricing reply explains the cause without the internal symptom line or event advice", async () => {
  const s = scenarios.find((x) => x.id === "price-override")!;
  const { diagnosis } = await triageOffline(s.ticket, new MockMetronomeClient(s.world), new Date(s.now));
  const reply = diagnosis.customer_reply;
  assert.match(reply, /set to start on 2026-09-01 instead of 2026-08-01/);
  assert.match(reply, /Next step: We're correcting the dates/);
  assert.doesNotMatch(reply, /override/i);
  assert.doesNotMatch(reply, /See the pricing root cause|re-sent|transaction IDs/);
  assert.equal(diagnosis.root_causes.length, 2, "engineers still get both findings");
});
