#!/usr/bin/env -S npx tsx
/**
 * Local fake Metronome API. Speaks the same HTTP paths/shapes as the real API
 * (checked against the official metronome-sdk), so the Python demo app and
 * Billing Doctor can point at it with METRONOME_BASE_URL=http://localhost:4010
 * and later switch to the real sandbox by changing only that variable.
 *
 * Seeded with: Acme Robotics (alias acme-123, external_id acme-prod), Globex,
 * metrics "API Requests" (count) and "Tokens" (sum of tokens, region US|EU),
 * a rate card, a contract whose token discount starts a month late, a finalized
 * August invoice, and a live DRAFT invoice built from whatever you ingest.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { MockMetronomeClient } from "./metronome/mock.ts";
import { acmeContract, baseWorld } from "./scenarios/index.ts";
import type { BillableMetric, UsageEvent } from "./metronome/types.ts";

import { pathToFileURL } from "node:url";

const PORT = Number(process.env.FAKE_PORT ?? 4010);

function freshWorld() {
  return baseWorld([], {
    contracts: acmeContract([{
      id: "ovr_tokens_discount", type: "OVERWRITE", product: { id: "prod_tokens", name: "Tokens" },
      starting_at: "2026-09-01T00:00:00Z", overwrite_rate: { rate_type: "FLAT", price: 0.0008 },
    }]),
    liveDraft: { now: () => new Date() },
  });
}

const upper = <T extends { aggregation_type?: string }>(m: T) => ({ ...m, aggregation_type: m.aggregation_type?.toUpperCase() });

async function body(req: IncomingMessage): Promise<any> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : undefined;
}
function send(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}
const err = (res: ServerResponse, status: number, message: string) => send(res, status, { message });

function validateEvents(events: unknown): string | null {
  if (!Array.isArray(events) || events.length < 1 || events.length > 100) return "body must be an array of 1-100 events";
  for (const [i, e] of events.entries()) {
    for (const f of ["transaction_id", "customer_id", "event_type", "timestamp"]) {
      if (typeof e?.[f] !== "string" || e[f].length === 0) return `event[${i}].${f} is required and must be a non-empty string`;
    }
  }
  return null;
}

export function createFakeMetronome() {
let world = freshWorld();
let mc = new MockMetronomeClient(world);
return createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;
  const m = req.method ?? "GET";
  try {
    // Debug helpers (not part of the real API)
    if (p === "/__fake/state") return send(res, 200, { events: world.events.length, customers: world.customers, metrics: world.metrics.map((x) => x.name) });
    if (p === "/__fake/reset" && m === "POST") { world = freshWorld(); mc = new MockMetronomeClient(world); return send(res, 200, { ok: true }); }

    if (!/^Bearer \S+/.test(req.headers.authorization ?? "")) return err(res, 401, "Missing bearer token");
    let mt: RegExpMatchArray | null;

    if (p === "/v1/ingest" && m === "POST") {
      const events = await body(req);
      const bad = validateEvents(events);
      if (bad) return err(res, 400, bad);
      await mc.ingestEvents(events as UsageEvent[]);
      console.log(`ingest: ${events.length} event(s)`);
      return send(res, 200, {});
    }
    if (p === "/v1/events/search" && m === "POST") {
      const b = await body(req);
      const ids = b?.transactionIds;
      if (!Array.isArray(ids)) return err(res, 400, "transactionIds is required");
      const found = await mc.searchEvents(ids);
      return send(res, 200, found.map((e) => ({ ...e, matched_billable_metrics: e.matched_billable_metrics?.map(upper) })));
    }
    if (p === "/v1/customers" && m === "GET") return send(res, 200, { data: await mc.listCustomers(), next_page: null });
    if (p === "/v1/customers" && m === "POST") {
      const b = await body(req);
      if (!b?.name) return err(res, 400, "name is required");
      return send(res, 200, { data: mc.createCustomer({ name: b.name, external_id: b.external_id, ingest_aliases: b.ingest_aliases ?? [] }) });
    }
    if ((mt = p.match(/^\/v1\/customers\/([^/]+)\/invoices$/)) && m === "GET") {
      const status = url.searchParams.get("status") as "DRAFT" | "FINALIZED" | "VOID" | null;
      return send(res, 200, { data: await mc.listInvoices(decodeURIComponent(mt[1]!), status ? { status } : {}), next_page: null });
    }
    if ((mt = p.match(/^\/v1\/customers\/([^/]+)$/)) && m === "GET") {
      const c = await mc.getCustomer(decodeURIComponent(mt[1]!));
      return c ? send(res, 200, { data: c }) : err(res, 404, "customer not found");
    }
    if (p === "/v1/billable-metrics" && m === "GET") return send(res, 200, { data: (await mc.listBillableMetrics()).map(upper), next_page: null });
    if (p === "/v1/billable-metrics/create" && m === "POST") {
      const b = await body(req);
      if (!b?.name) return err(res, 400, "name is required");
      const created = mc.createBillableMetric({
        ...b, aggregation_type: String(b.aggregation_type ?? "COUNT").toLowerCase(),
      } as Omit<BillableMetric, "id">);
      return send(res, 200, { data: { id: created.id } });
    }
    if ((mt = p.match(/^\/v1\/billable-metrics\/([^/]+)$/)) && m === "GET") {
      const bm = await mc.getBillableMetric(decodeURIComponent(mt[1]!));
      return bm ? send(res, 200, { data: upper(bm) }) : err(res, 404, "billable metric not found");
    }
    if (p === "/v2/contracts/list" && m === "POST") {
      const b = await body(req);
      if (!b?.customer_id) return err(res, 400, "customer_id is required");
      return send(res, 200, { data: await mc.listContracts(b.customer_id, b.covering_date), cursor: null });
    }
    if (p === "/v1/contract-pricing/rate-cards/getRates" && m === "POST") {
      const b = await body(req);
      if (!b?.rate_card_id || !b?.at) return err(res, 400, "rate_card_id and at are required");
      const productId = b.selectors?.[0]?.product_id;
      return send(res, 200, { data: await mc.getRates(b.rate_card_id, b.at, productId), next_page: null });
    }
    return err(res, 404, `fake Metronome has no route for ${m} ${p}`);
  } catch (e) {
    return err(res, 400, e instanceof Error ? e.message : String(e));
  }
});

}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  createFakeMetronome().listen(PORT, () => {
    console.log(`Fake Metronome listening on http://localhost:${PORT}`);
    console.log(`  export METRONOME_BASE_URL=http://localhost:${PORT}  (any bearer token works)`);
  });
}
