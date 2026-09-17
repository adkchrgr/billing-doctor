import { test } from "node:test";
import assert from "node:assert/strict";
import { explainPrice } from "../src/checks/pricing.ts";
import { HttpMetronomeClient } from "../src/metronome/client.ts";
import type { Contract, Invoice, RateSchedule } from "../src/metronome/types.ts";

const invoice = (unit_price: number): Invoice => ({
  id: "inv_1", customer_id: "c1", status: "FINALIZED",
  start_timestamp: "2026-08-01T00:00:00Z", end_timestamp: "2026-09-01T00:00:00Z", total: 0,
  line_items: [{ name: "Tokens", product_id: "p_tok", unit_price, quantity: 1, total: unit_price }],
});
const rates: RateSchedule[] = [
  { product_id: "p_tok", product_name: "Tokens", starting_at: "2026-01-01T00:00:00Z", entitled: true, rate: { rate_type: "FLAT", price: 0.001 } },
];
const contract = (overrides: Contract["overrides"]): Contract =>
  ({ id: "k1", customer_id: "c1", rate_card_id: "rc", starting_at: "2026-01-01T00:00:00Z", overrides });
const prod = { id: "p_tok", name: "Tokens" };

test("expired override is identified", () => {
  const { findings } = explainPrice(invoice(0.001), "Tokens", 0.0008, contract([
    { id: "o1", type: "OVERWRITE", product: prod, starting_at: "2026-01-01T00:00:00Z", ending_before: "2026-07-01T00:00:00Z", overwrite_rate: { rate_type: "FLAT", price: 0.0008 } },
  ]), rates);
  assert.equal(findings[0]?.code, "PRICING_OVERRIDE_DATE_MISMATCH");
  assert.match(findings[0]!.summary, /ended 2026-07-01/);
});

test("overwrite with the lowest priority number wins, then multipliers apply", () => {
  const { breakdown, findings } = explainPrice(invoice(0.00045), "Tokens", 0.00045, contract([
    { id: "a", type: "OVERWRITE", priority: 2, product: prod, starting_at: "2026-01-01T00:00:00Z", overwrite_rate: { rate_type: "FLAT", price: 0.0009 } },
    { id: "b", type: "OVERWRITE", priority: 1, product: prod, starting_at: "2026-01-01T00:00:00Z", overwrite_rate: { rate_type: "FLAT", price: 0.0005 } },
    { id: "m", type: "MULTIPLIER", multiplier: 0.9, product: prod, starting_at: "2026-01-01T00:00:00Z" },
  ]), rates);
  assert.ok(Math.abs(breakdown.computed_price! - 0.00045) < 1e-12);
  assert.equal(findings.length, 0, "billed matches expected → nothing to report");
});

test("no covering contract", () => {
  const { findings } = explainPrice(invoice(0.001), "Tokens", 0.0008, undefined, rates);
  assert.equal(findings[0]?.code, "PRICING_NO_CONTRACT");
});

test("unexplainable price goes to a human", () => {
  const { findings } = explainPrice(invoice(0.0013), "Tokens", 0.0008, contract([]), rates);
  assert.equal(findings[0]?.code, "PRICING_UNEXPLAINED");
});

test("HTTP client sends the documented request shapes", async () => {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : undefined });
    const body = url.includes("/v2/contracts/list") ? { data: [], cursor: null } : { data: [], next_page: null };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  try {
    const mc = new HttpMetronomeClient("k", "https://example.test");
    await mc.listContracts("c1", "2026-08-01T00:00:00Z");
    await mc.getRates("rc", "2026-08-01T00:00:00Z", "p_tok");
  } finally {
    globalThis.fetch = orig;
  }
  assert.deepEqual(calls[0], { url: "https://example.test/v2/contracts/list", method: "POST", body: { customer_id: "c1", covering_date: "2026-08-01T00:00:00Z" } });
  assert.equal(calls[1]!.url, "https://example.test/v1/contract-pricing/rate-cards/getRates?limit=100");
  assert.deepEqual(calls[1]!.body, { rate_card_id: "rc", at: "2026-08-01T00:00:00Z", selectors: [{ product_id: "p_tok" }] });
});
