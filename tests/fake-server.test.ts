import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createFakeMetronome } from "../src/fake-server.ts";
import { HttpMetronomeClient } from "../src/metronome/client.ts";
import { triageOffline } from "../src/agent/offline.ts";

test("end to end: ingest over HTTP → Billing Doctor diagnoses via the real HTTP client", async (t) => {
  const server = createFakeMetronome().listen(0);
  t.after(() => server.close());
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Unauthenticated requests are rejected like the real API.
  assert.equal((await fetch(`${base}/v1/customers`)).status, 401);
  // Bad batches are rejected.
  const bad = await fetch(`${base}/v1/ingest`, { method: "POST", headers: { Authorization: "Bearer t" }, body: JSON.stringify([{ customer_id: "x" }]) });
  assert.equal(bad.status, 400);

  const mc = new HttpMetronomeClient("t", base);
  const now = new Date().toISOString();
  await mc.ingestEvents([
    { transaction_id: "e2e-1", customer_id: "acme-123", event_type: "llm_completion", timestamp: now, properties: { region: "us", tokens: 10 } },
    { transaction_id: "e2e-2", customer_id: "acme-123", event_type: "llm_completion", timestamp: now, properties: { region: "US", tokens: 25 } },
  ]);

  // Search returns UPPERCASE aggregation types like the real API; the client normalizes them.
  const [, ok] = await mc.searchEvents(["e2e-1", "e2e-2"]);
  assert.equal(ok?.matched_billable_metrics?.[0]?.aggregation_type, "sum");

  const { findings } = await triageOffline(
    { subject: "tokens missing", body: "", customer_id: "cust_acme", transaction_ids: ["e2e-1", "e2e-2"] }, mc, new Date());
  assert.deepEqual(findings.map((f) => f.code), ["PROPERTY_FILTER_EXCLUDED"]);

  // The live draft invoice only bills the event that matched.
  const draft = (await mc.listInvoices("cust_acme", { status: "DRAFT" }))[0]!;
  assert.equal(draft.line_items.find((l) => l.name === "Tokens")?.quantity, 25);
});
