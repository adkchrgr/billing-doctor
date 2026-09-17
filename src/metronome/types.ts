// Shapes mirror the Metronome REST API (docs.metronome.com/api-reference).
// Only the fields Billing Doctor reads are modeled.

export interface UsageEvent {
  transaction_id: string; // idempotency key, 34-day dedupe window
  customer_id: string; // Metronome customer ID or an ingest alias
  event_type: string;
  timestamp: string; // RFC 3339
  properties?: Record<string, unknown>;
}

export type AggregationType = "count" | "latest" | "max" | "sum" | "unique";

export interface BillableMetric {
  id: string;
  name: string;
  event_type_filter?: { in_values?: string[]; not_in_values?: string[] };
  property_filters?: Array<{
    name: string;
    exists?: boolean;
    in_values?: string[];
    not_in_values?: string[];
  }>;
  aggregation_type: AggregationType;
  aggregation_key?: string;
  group_keys?: string[][];
  archived_at?: string;
}

/** Result of POST /v1/events/search */
export interface SearchedEvent extends UsageEvent {
  id: string;
  processed_at?: string;
  is_duplicate?: boolean;
  matched_customer?: { id: string; name: string } | null;
  matched_billable_metrics?: Array<{ id: string; name: string; aggregation_type: AggregationType }>;
}

export interface Customer {
  id: string;
  name: string;
  external_id?: string;
  ingest_aliases?: string[];
}

export interface InvoiceLineItem {
  name: string;
  type?: string;
  quantity?: number;
  unit_price?: number;
  total: number;
  product_id?: string;
}

export interface Invoice {
  id: string;
  customer_id: string;
  status: "DRAFT" | "FINALIZED" | "VOID";
  start_timestamp: string;
  end_timestamp: string;
  total: number;
  line_items: InvoiceLineItem[];
}

// ---- Contracts & pricing (v2 contracts, contract-pricing rate cards) ----

export interface Rate {
  rate_type: "FLAT" | "PERCENTAGE" | "SUBSCRIPTION" | "TIERED" | "CUSTOM";
  price?: number;
}

/** POST /v1/contract-pricing/rate-cards/getRates → data[] */
export interface RateSchedule {
  product_id: string;
  product_name: string;
  starting_at: string;
  ending_before?: string | null;
  entitled: boolean;
  rate: Rate;
}

export interface ContractOverride {
  id: string;
  starting_at: string;
  ending_before?: string | null;
  product?: { id: string; name: string };
  entitled?: boolean;
  type: "OVERWRITE" | "MULTIPLIER" | "TIERED";
  priority?: number;
  multiplier?: number;
  overwrite_rate?: Rate;
}

/** POST /v2/contracts/list → data[] */
export interface Contract {
  id: string;
  customer_id: string;
  rate_card_id: string;
  starting_at: string;
  ending_before?: string | null;
  overrides?: ContractOverride[];
}
