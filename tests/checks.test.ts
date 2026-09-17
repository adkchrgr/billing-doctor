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
