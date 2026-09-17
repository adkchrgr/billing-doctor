import type { MetronomeClient } from "../metronome/client.ts";
import type { UsageEvent } from "../metronome/types.ts";
import { checkEvents, checkInvoice } from "../checks/findings.ts";
import { diagnosisSchema } from "./diagnosis.ts";
import { lookupAndExplainPrice } from "../checks/pricing.ts";

/**
 * Tool design principles (CCAR-F): each tool does one thing, has a
 * description that says WHEN to use it, returns compact JSON, and
 * reports errors as data (is_error) instead of throwing into the loop.
 */
export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  mutating: boolean;
  run(input: any): Promise<unknown>;
}

export function buildTools(mc: MetronomeClient, now: Date): ToolDef[] {
  return [
    {
      name: "get_customer",
      description: "Look up a Metronome customer by Metronome customer ID. Use first to learn the customer's name, external_id, and ingest aliases.",
      input_schema: obj({ customer_id: str("Metronome customer ID") }, ["customer_id"]),
      mutating: false,
      run: async ({ customer_id }) => (await mc.getCustomer(customer_id)) ?? { error: "customer not found" },
    },
    {
      name: "list_billable_metrics",
      description: "List the account's billable metrics (event_type filters, property filters, aggregation). Use when you need to reason about why events did or did not count.",
      input_schema: obj({}, []),
      mutating: false,
      run: async () => mc.listBillableMetrics(),
    },
    {
      name: "search_events",
      description: "Fetch ingested events by transaction_id, including which customer and billable metrics each matched and whether it was a duplicate.",
      input_schema: obj({ transaction_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100 } }, ["transaction_ids"]),
      mutating: false,
      run: async ({ transaction_ids }) => mc.searchEvents(transaction_ids),
    },
    {
      name: "run_event_checks",
      description:
        "Run Billing Doctor's deterministic diagnostics on events (customer resolution, event_type, property filters, aggregation key, duplicates, timestamps). Prefer this over manual reasoning; it returns findings with evidence and fixes.",
      input_schema: obj({ transaction_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100 } }, ["transaction_ids"]),
      mutating: false,
      run: async ({ transaction_ids }) => {
        const [events, customers, metrics] = await Promise.all([
          mc.searchEvents(transaction_ids), mc.listCustomers(), mc.listBillableMetrics(),
        ]);
        if (events.length === 0) return { findings: [], note: "No events found for those transaction IDs — they may never have been sent." };
        return { findings: checkEvents(events, customers, metrics, now) };
      },
    },
    {
      name: "list_invoices",
      description: "List a customer's invoices (id, period, status, line items). Use for billing-amount or price complaints.",
      input_schema: obj({ customer_id: str("Metronome customer ID") }, ["customer_id"]),
      mutating: false,
      run: async ({ customer_id }) => mc.listInvoices(customer_id),
    },
    {
      name: "check_invoice",
      description: "Compare one invoice line item against what the customer expected (unit price and/or quantity).",
      input_schema: obj(
        {
          customer_id: str("Metronome customer ID"),
          invoice_id: str("Invoice ID"),
          line_item_name: str("Exact line item name, e.g. 'Tokens'"),
          expected_unit_price: { type: "number" },
          expected_quantity: { type: "number" },
        },
        ["customer_id", "invoice_id", "line_item_name"],
      ),
      mutating: false,
      run: async ({ customer_id, invoice_id, ...exp }) => {
        const inv = (await mc.listInvoices(customer_id)).find((i) => i.id === invoice_id);
        if (!inv) return { error: `invoice ${invoice_id} not found for ${customer_id}` };
        return { findings: checkInvoice(inv, exp) };
      },
    },
    {
      name: "list_contracts",
      description: "List a customer's contracts (rate card, start/end dates, pricing overrides). Use only if explain_price leaves a question open.",
      input_schema: obj({ customer_id: str("Metronome customer ID"), covering_date: str("Optional RFC 3339 date the contract must cover") }, ["customer_id"]),
      mutating: false,
      run: async ({ customer_id, covering_date }) => mc.listContracts(customer_id, covering_date),
    },
    {
      name: "explain_price",
      description:
        "For price complaints: rebuild an invoice line item's unit price from the contract's rate card and overrides, and explain why it differs from what the customer expected (e.g. an override with the wrong start date, or no override at all). Prefer this over check_invoice for price questions.",
      input_schema: obj(
        {
          customer_id: str("Metronome customer ID"),
          invoice_id: str("Invoice ID from list_invoices"),
          line_item_name: str("Exact line item name, e.g. 'Tokens'"),
          expected_unit_price: { type: "number", description: "Price the customer believes they agreed to" },
        },
        ["customer_id", "invoice_id", "line_item_name"],
      ),
      mutating: false,
      run: async ({ customer_id, invoice_id, line_item_name, expected_unit_price }) => {
        const inv = (await mc.listInvoices(customer_id)).find((i) => i.id === invoice_id);
        if (!inv) return { error: `invoice ${invoice_id} not found for ${customer_id}` };
        return lookupAndExplainPrice(mc, inv, line_item_name, expected_unit_price);
      },
    },
    {
      name: "replay_events",
      description:
        "WRITE ACTION. Re-send corrected usage events to Metronome (e.g. with a fixed customer alias or event_type). Requires human approval; only use when the ticket explicitly asks you to recover usage. Each event needs a NEW transaction_id.",
      input_schema: obj(
        {
          events: {
            type: "array", maxItems: 100,
            items: obj(
              { transaction_id: str(""), customer_id: str(""), event_type: str(""), timestamp: str("RFC 3339"), properties: { type: "object" } },
              ["transaction_id", "customer_id", "event_type", "timestamp"],
            ),
          },
        },
        ["events"],
      ),
      mutating: true,
      run: async ({ events }: { events: UsageEvent[] }) => {
        await mc.ingestEvents(events);
        return { ingested: events.length };
      },
    },
    {
      name: "submit_diagnosis",
      description: "Finish the investigation. Call exactly once when you know the root cause, found no issue, or need a human.",
      input_schema: diagnosisSchema as unknown as Record<string, unknown>,
      mutating: false,
      run: async (d) => d, // handled by the loop
    },
  ];
}

function obj(properties: Record<string, unknown>, required: string[]) {
  return { type: "object", properties, required };
}
function str(description: string) {
  return { type: "string", description };
}
