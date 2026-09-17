import type { BillableMetric, Contract, Customer, Invoice, RateSchedule, SearchedEvent, UsageEvent } from "./types.ts";

/**
 * Everything Billing Doctor needs from Metronome. Read methods are safe;
 * `ingestEvents` mutates and is gated by the approval hook in the agent.
 */
export interface MetronomeClient {
  getCustomer(customerId: string): Promise<Customer | null>;
  listCustomers(): Promise<Customer[]>;
  listBillableMetrics(): Promise<BillableMetric[]>;
  getBillableMetric(id: string): Promise<BillableMetric | null>;
  searchEvents(transactionIds: string[]): Promise<SearchedEvent[]>;
  listInvoices(customerId: string, opts?: { status?: Invoice["status"] }): Promise<Invoice[]>;
  ingestEvents(events: UsageEvent[]): Promise<void>;
  /** Contracts for a customer, optionally only those covering a date. */
  listContracts(customerId: string, coveringDate?: string): Promise<Contract[]>;
  /** Rate card schedule in effect from `at`, optionally for one product. */
  getRates(rateCardId: string, at: string, productId?: string): Promise<RateSchedule[]>;
}

const BASE_URL = "https://api.metronome.com";

export class MetronomeApiError extends Error {
  constructor(public status: number, public path: string, body: string) {
    super(`Metronome ${status} on ${path}: ${body.slice(0, 300)}`);
  }
}

/** Thin fetch-based client. Metronome wraps most responses in `{ data }`. */
export class HttpMetronomeClient implements MetronomeClient {
  constructor(private apiKey: string, private baseUrl = BASE_URL) {
    if (!apiKey) throw new Error("METRONOME_API_KEY is required for live mode");
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 404) return null;
    const text = await res.text();
    if (!res.ok) throw new MetronomeApiError(res.status, path, text);
    return text ? (JSON.parse(text) as T) : null;
  }

  /** Follows `next_page` cursors. */
  private async paginate<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | null = null;
    do {
      const sep = path.includes("?") ? "&" : "?";
      const url: string = cursor ? `${path}${sep}next_page=${encodeURIComponent(cursor)}` : path;
      const page: { data: T[]; next_page: string | null } | null = await this.req<{ data: T[]; next_page: string | null }>("GET", url);
      if (!page) break;
      out.push(...page.data);
      cursor = page.next_page;
    } while (cursor);
    return out;
  }

  async getCustomer(id: string) {
    return (await this.req<{ data: Customer }>("GET", `/v1/customers/${encodeURIComponent(id)}`))?.data ?? null;
  }
  listCustomers() {
    return this.paginate<Customer>("/v1/customers?limit=100");
  }
  listBillableMetrics() {
    return this.paginate<BillableMetric>("/v1/billable-metrics?limit=100");
  }
  async getBillableMetric(id: string) {
    return (await this.req<{ data: BillableMetric }>("GET", `/v1/billable-metrics/${encodeURIComponent(id)}`))?.data ?? null;
  }
  async searchEvents(transactionIds: string[]) {
    return (await this.req<SearchedEvent[]>("POST", "/v1/events/search", { transactionIds })) ?? [];
  }
  listInvoices(customerId: string, opts: { status?: Invoice["status"] } = {}) {
    const q = opts.status ? `&status=${opts.status}` : "";
    return this.paginate<Invoice>(`/v1/customers/${encodeURIComponent(customerId)}/invoices?limit=100${q}`);
  }
  async listContracts(customerId: string, coveringDate?: string) {
    const out: Contract[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await this.req<{ data: Contract[]; cursor?: string | null }>("POST", "/v2/contracts/list", {
        customer_id: customerId,
        ...(coveringDate ? { covering_date: coveringDate } : {}),
        ...(cursor ? { cursor } : {}),
      });
      if (!page) break;
      out.push(...page.data);
      cursor = page.cursor;
    } while (cursor);
    return out;
  }
  async getRates(rateCardId: string, at: string, productId?: string) {
    const out: RateSchedule[] = [];
    let cursor: string | null = null;
    do {
      const q: string = cursor ? `&next_page=${encodeURIComponent(cursor)}` : "";
      const page: { data: RateSchedule[]; next_page: string | null } | null = await this.req("POST", `/v1/contract-pricing/rate-cards/getRates?limit=100${q}`, {
        rate_card_id: rateCardId,
        at,
        ...(productId ? { selectors: [{ product_id: productId }] } : {}),
      });
      if (!page) break;
      out.push(...page.data);
      cursor = page.next_page;
    } while (cursor);
    return out;
  }
  async ingestEvents(events: UsageEvent[]) {
    for (let i = 0; i < events.length; i += 100) {
      await this.req("POST", "/v1/ingest", events.slice(i, i + 100)); // API max 100 per request
    }
  }
}
