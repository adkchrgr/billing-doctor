import type { MetronomeClient } from "./client.ts";
import type { BillableMetric, Contract, Customer, Invoice, RateSchedule, SearchedEvent, UsageEvent } from "./types.ts";
import { metricMatches, resolveCustomer } from "../checks/matching.ts";

export interface MockWorld {
  customers: Customer[];
  metrics: BillableMetric[];
  /** Raw events exactly as the integrating app sent them, in send order. */
  events: UsageEvent[];
  invoices: Invoice[];
  contracts?: Contract[];
  /** Keyed by rate_card_id. */
  rateCards?: Record<string, RateSchedule[]>;
  /** When set, listInvoices also returns a DRAFT invoice computed from ingested events. */
  liveDraft?: { now: () => Date };
}

/** In-memory Metronome that derives matched_* fields the way the real platform would. */
export class MockMetronomeClient implements MetronomeClient {
  readonly ingested: UsageEvent[] = [];
  constructor(private world: MockWorld) {}

  async getCustomer(id: string) {
    return this.world.customers.find((c) => c.id === id) ?? null;
  }
  async listCustomers() {
    return this.world.customers;
  }
  async listBillableMetrics() {
    return this.world.metrics;
  }
  async getBillableMetric(id: string) {
    return this.world.metrics.find((m) => m.id === id) ?? null;
  }
  async searchEvents(transactionIds: string[]): Promise<SearchedEvent[]> {
    const seen = new Set<string>();
    const out: SearchedEvent[] = [];
    this.world.events.forEach((ev, i) => {
      const isDuplicate = seen.has(ev.transaction_id);
      seen.add(ev.transaction_id);
      if (!transactionIds.includes(ev.transaction_id)) return;
      const cust = resolveCustomer(ev.customer_id, this.world.customers);
      out.push({
        ...ev,
        id: `evt_${i}`,
        is_duplicate: isDuplicate,
        matched_customer: cust ? { id: cust.id, name: cust.name } : null,
        matched_billable_metrics:
          cust && !isDuplicate
            ? this.world.metrics
                .filter((m) => metricMatches(m, ev))
                .map((m) => ({ id: m.id, name: m.name, aggregation_type: m.aggregation_type }))
            : [],
      });
    });
    return out;
  }
  async listInvoices(customerId: string, opts: { status?: Invoice["status"] } = {}) {
    const all = [...this.world.invoices];
    if (this.world.liveDraft) all.push(this.draftInvoice(customerId, this.world.liveDraft.now()));
    return all.filter((i) => i.customer_id === customerId && (!opts.status || i.status === opts.status));
  }

  /** Current-month draft: aggregates matched, non-duplicate events per metric, priced from the rate card. */
  draftInvoice(customerId: string, now: Date): Invoice {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const seen = new Set<string>();
    const qty = new Map<string, number>();
    for (const ev of this.world.events) {
      if (seen.has(ev.transaction_id)) continue;
      seen.add(ev.transaction_id);
      const cust = resolveCustomer(ev.customer_id, this.world.customers);
      const t = Date.parse(ev.timestamp);
      if (cust?.id !== customerId || !(t >= start.getTime() && t < end.getTime())) continue;
      for (const m of this.world.metrics.filter((m) => metricMatches(m, ev))) {
        const add = m.aggregation_type === "sum" ? Number(ev.properties?.[m.aggregation_key ?? ""]) || 0 : 1;
        qty.set(m.name, (qty.get(m.name) ?? 0) + add);
      }
    }
    const contract = (this.world.contracts ?? []).find((c) => c.customer_id === customerId);
    const rates = contract ? this.world.rateCards?.[contract.rate_card_id] ?? [] : [];
    const line_items = this.world.metrics.map((m) => {
      const rate = rates.find((r) => r.product_name === m.name);
      const quantity = qty.get(m.name) ?? 0;
      const unit_price = rate?.rate.price ?? 0;
      return { name: m.name, product_id: rate?.product_id, quantity, unit_price, total: +(quantity * unit_price).toFixed(6) };
    });
    return {
      id: "inv_draft_current", customer_id: customerId, status: "DRAFT",
      start_timestamp: start.toISOString(), end_timestamp: end.toISOString(),
      total: +line_items.reduce((n, l) => n + l.total, 0).toFixed(6), line_items,
    };
  }

  // ---- setup endpoints (used by the fake server so setup scripts work locally) ----
  createCustomer(c: Omit<Customer, "id">): Customer {
    const existing = this.world.customers.find((x) => x.name === c.name);
    if (existing) return existing;
    const created = { id: `cust_${this.world.customers.length + 1}_${Date.now().toString(36)}`, ...c };
    this.world.customers.push(created);
    return created;
  }
  createBillableMetric(m: Omit<BillableMetric, "id">): BillableMetric {
    const existing = this.world.metrics.find((x) => x.name === m.name);
    if (existing) return existing;
    const created = { id: `bm_${this.world.metrics.length + 1}_${Date.now().toString(36)}`, ...m };
    this.world.metrics.push(created);
    return created;
  }
  async listContracts(customerId: string, coveringDate?: string) {
    return (this.world.contracts ?? []).filter((c) =>
      c.customer_id === customerId && (!coveringDate || covers(c.starting_at, c.ending_before, coveringDate)));
  }
  async getRates(rateCardId: string, at: string, productId?: string) {
    return (this.world.rateCards?.[rateCardId] ?? []).filter((r) =>
      (!productId || r.product_id === productId) && (!r.ending_before || r.ending_before > at));
  }
  async ingestEvents(events: UsageEvent[]) {
    this.ingested.push(...events);
    if (this.world.liveDraft) this.world.events.push(...events); // fake server: ingested events become searchable
  }
}

function covers(start: string, end: string | null | undefined, at: string) {
  return Date.parse(start) <= Date.parse(at) && (!end || Date.parse(at) < Date.parse(end));
}
