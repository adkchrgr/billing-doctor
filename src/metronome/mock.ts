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
    return this.world.invoices.filter((i) => i.customer_id === customerId && (!opts.status || i.status === opts.status));
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
  }
}

function covers(start: string, end: string | null | undefined, at: string) {
  return Date.parse(start) <= Date.parse(at) && (!end || Date.parse(at) < Date.parse(end));
}
