import type { MockWorld } from "../metronome/mock.ts";
import type { UsageEvent } from "../metronome/types.ts";
import type { FindingCode, InvoiceExpectation } from "../checks/findings.ts";

/**
 * Sandbox scenarios with deliberately planted integration bugs.
 * Each one is a support ticket + the account state behind it + the
 * answer key (`planted`). These double as the agent's eval set.
 */
export interface Scenario {
  id: string;
  title: string;
  now: string; // frozen clock so timestamp checks are deterministic
  ticket: {
    subject: string;
    body: string;
    customer_id: string; // Metronome customer the ticket is about
    transaction_ids: string[]; // sample IDs the customer shared
    invoice?: InvoiceExpectation;
  };
  world: MockWorld;
  planted: FindingCode[];
}

const NOW = "2026-09-15T12:00:00Z";
const T = (d: number) => new Date(Date.parse(NOW) - d * 86_400_000).toISOString();

export function baseWorld(events: UsageEvent[], overrides: Partial<MockWorld> = {}): MockWorld {
  return {
    customers: [
      { id: "cust_acme", name: "Acme Robotics", external_id: "acme-prod", ingest_aliases: ["acme-123"] },
      { id: "cust_globex", name: "Globex", external_id: "globex", ingest_aliases: ["globex"] },
    ],
    metrics: [
      { id: "bm_requests", name: "API Requests", aggregation_type: "count", event_type_filter: { in_values: ["api_request"] } },
      {
        id: "bm_tokens", name: "Tokens", aggregation_type: "sum", aggregation_key: "tokens",
        event_type_filter: { in_values: ["llm_completion"] },
        property_filters: [{ name: "region", exists: true, in_values: ["US", "EU"] }],
        group_keys: [["region"]],
      },
    ],
    events,
    invoices: [
      {
        id: "inv_aug", customer_id: "cust_acme", status: "FINALIZED",
        start_timestamp: "2026-08-01T00:00:00Z", end_timestamp: "2026-09-01T00:00:00Z", total: 150,
        line_items: [
          { name: "API Requests", product_id: "prod_requests", quantity: 50000, unit_price: 0.001, total: 50 },
          { name: "Tokens", product_id: "prod_tokens", quantity: 100000, unit_price: 0.001, total: 100 },
        ],
      },
    ],
    contracts: [{ id: "con_acme_2026", customer_id: "cust_acme", rate_card_id: "rc_standard", starting_at: "2026-01-01T00:00:00Z", overrides: [] }],
    rateCards: {
      rc_standard: [
        { product_id: "prod_requests", product_name: "API Requests", starting_at: "2026-01-01T00:00:00Z", entitled: true, rate: { rate_type: "FLAT", price: 0.001 } },
        { product_id: "prod_tokens", product_name: "Tokens", starting_at: "2026-01-01T00:00:00Z", entitled: true, rate: { rate_type: "FLAT", price: 0.001 } },
      ],
    },
    ...overrides,
  };
}

export const acmeContract = (overrides: NonNullable<MockWorld["contracts"]>[number]["overrides"]) =>
  [{ id: "con_acme_2026", customer_id: "cust_acme", rate_card_id: "rc_standard", starting_at: "2026-01-01T00:00:00Z", overrides }];

const ev = (id: string, customer_id: string, event_type: string, timestamp: string, properties?: Record<string, unknown>): UsageEvent =>
  ({ transaction_id: id, customer_id, event_type, timestamp, properties });

export const scenarios: Scenario[] = [
  {
    id: "healthy",
    title: "Control: everything is configured correctly",
    now: NOW,
    ticket: {
      subject: "Just confirming usage is flowing",
      body: "Can you confirm our last few events landed? IDs attached.",
      customer_id: "cust_acme",
      transaction_ids: ["h1", "h2"],
    },
    world: baseWorld([
      ev("h1", "acme-123", "api_request", T(1)),
      ev("h2", "acme-123", "llm_completion", T(1), { region: "US", tokens: 1200 }),
    ]),
    planted: [],
  },
  {
    id: "unregistered-alias",
    title: "Events sent with external_id that isn't an ingest alias",
    now: NOW,
    ticket: {
      subject: "Usage dashboard shows zero since our deploy",
      body: "We switched our emitter to use our internal account key yesterday and now Metronome shows no usage for Acme.",
      customer_id: "cust_acme",
      transaction_ids: ["ua1", "ua2"],
    },
    world: baseWorld([
      ev("ua1", "acme-prod", "api_request", T(1)),
      ev("ua2", "acme-prod", "api_request", T(1)),
    ]),
    planted: ["CUSTOMER_NOT_RESOLVED"],
  },
  {
    id: "event-type-typo",
    title: "Emitter pluralized the event_type",
    now: NOW,
    ticket: {
      subject: "API request count stuck",
      body: "Our request counts stopped increasing after a refactor. Nothing errors on ingest — we get 200s.",
      customer_id: "cust_acme",
      transaction_ids: ["et1", "et2"],
    },
    world: baseWorld([
      ev("et1", "acme-123", "api_requests", T(2)),
      ev("et2", "acme-123", "api_requests", T(2)),
    ]),
    planted: ["EVENT_TYPE_NOT_MATCHED"],
  },
  {
    id: "region-case",
    title: "Property filter is case-sensitive; emitter sends lowercase",
    now: NOW,
    ticket: {
      subject: "Token usage missing for some requests",
      body: "Tokens from our new US cluster aren't showing up. The EU cluster is fine.",
      customer_id: "cust_acme",
      transaction_ids: ["rc1", "rc2"],
    },
    world: baseWorld([
      ev("rc1", "acme-123", "llm_completion", T(1), { region: "us", tokens: 900 }),
      ev("rc2", "acme-123", "llm_completion", T(1), { region: "EU", tokens: 400 }),
    ]),
    planted: ["PROPERTY_FILTER_EXCLUDED"],
  },
  {
    id: "wrong-agg-key",
    title: "Aggregation key renamed in the emitter",
    now: NOW,
    ticket: {
      subject: "Token totals are zero",
      body: "We upgraded our SDK wrapper and token usage dropped to zero overnight.",
      customer_id: "cust_acme",
      transaction_ids: ["ak1"],
    },
    world: baseWorld([ev("ak1", "acme-123", "llm_completion", T(1), { region: "US", token_count: 5000 })]),
    planted: ["AGGREGATION_KEY_INVALID"],
  },
  {
    id: "reused-txn-id",
    title: "transaction_id reused per day → dedupe swallows usage",
    now: NOW,
    ticket: {
      subject: "Invoice shows far fewer API requests than our logs",
      body: "Our logs show 180,000 requests in August but the invoice bills 50,000. Sample IDs attached.",
      customer_id: "cust_acme",
      transaction_ids: ["acme-2026-09-14"],
      invoice: { line_item_name: "API Requests", expected_quantity: 180000 },
    },
    world: baseWorld([
      ev("acme-2026-09-14", "acme-123", "api_request", T(1)),
      ev("acme-2026-09-14", "acme-123", "api_request", T(1)),
      ev("acme-2026-09-14", "acme-123", "api_request", T(1)),
    ]),
    planted: ["DUPLICATE_TRANSACTION_ID", "INVOICE_QUANTITY_MISMATCH"],
  },
  {
    id: "bad-timestamps",
    title: "Seconds treated as milliseconds + non-RFC3339 strings",
    now: NOW,
    ticket: {
      subject: "Some events rejected / missing",
      body: "A batch job backfilled events and most of them never appeared.",
      customer_id: "cust_acme",
      transaction_ids: ["ts1", "ts2"],
    },
    world: baseWorld([
      ev("ts1", "acme-123", "api_request", "1970-01-21T12:21:00.000Z"),
      ev("ts2", "acme-123", "api_request", "2026-09-14 10:00:00"),
    ]),
    planted: ["TIMESTAMP_INVALID"],
  },
  {
    id: "price-override",
    title: "Negotiated override was entered with the wrong start date",
    now: NOW,
    ticket: {
      subject: "Overcharged on tokens",
      body: "Our contract says tokens are $0.0008/unit starting August, but the August invoice used $0.001.",
      customer_id: "cust_acme",
      transaction_ids: [],
      invoice: { line_item_name: "Tokens", expected_unit_price: 0.0008 },
    },
    world: baseWorld([], {
      contracts: acmeContract([{
        id: "ovr_tokens_discount", type: "OVERWRITE", product: { id: "prod_tokens", name: "Tokens" },
        starting_at: "2026-09-01T00:00:00Z", overwrite_rate: { rate_type: "FLAT", price: 0.0008 },
      }]),
    }),
    planted: ["INVOICE_PRICE_MISMATCH", "PRICING_OVERRIDE_DATE_MISMATCH"],
  },
  {
    id: "missing-override",
    title: "Sales promised a discount that never made it onto the contract",
    now: NOW,
    ticket: {
      subject: "Where is our volume discount?",
      body: "We signed for $0.0007 per API request back in July. August still shows $0.001.",
      customer_id: "cust_acme",
      transaction_ids: [],
      invoice: { line_item_name: "API Requests", expected_unit_price: 0.0007 },
    },
    world: baseWorld([]),
    planted: ["INVOICE_PRICE_MISMATCH", "PRICING_OVERRIDE_MISSING"],
  },
  {
    id: "discount-applied",
    title: "Control: multiplier discount is active and billed correctly",
    now: NOW,
    ticket: {
      subject: "Is our 20% token discount applied?",
      body: "We have a 20% discount on tokens. Can you confirm August reflects it?",
      customer_id: "cust_acme",
      transaction_ids: [],
      invoice: { line_item_name: "Tokens", expected_unit_price: 0.0008 },
    },
    world: (() => {
      const w = baseWorld([], {
        contracts: acmeContract([{
          id: "ovr_tokens_20off", type: "MULTIPLIER", multiplier: 0.8, product: { id: "prod_tokens", name: "Tokens" },
          starting_at: "2026-07-01T00:00:00Z",
        }]),
      });
      const li = w.invoices[0]!.line_items.find((l) => l.name === "Tokens")!;
      li.unit_price = 0.0008;
      li.total = 80;
      return w;
    })(),
    planted: [],
  },
];

export function getScenario(id: string): Scenario {
  const s = scenarios.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown scenario "${id}". Options: ${scenarios.map((x) => x.id).join(", ")}`);
  return s;
}
