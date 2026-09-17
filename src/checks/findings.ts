import type { BillableMetric, Customer, Invoice, SearchedEvent } from "../metronome/types.ts";
import { closest, eventTypeMatches, failingPropertyFilter, resolveCustomer } from "./matching.ts";

export type FindingCode =
  | "CUSTOMER_NOT_RESOLVED"
  | "EVENT_TYPE_NOT_MATCHED"
  | "PROPERTY_FILTER_EXCLUDED"
  | "AGGREGATION_KEY_INVALID"
  | "DUPLICATE_TRANSACTION_ID"
  | "TIMESTAMP_INVALID"
  | "INVOICE_PRICE_MISMATCH"
  | "INVOICE_QUANTITY_MISMATCH"
  | "PRICING_OVERRIDE_DATE_MISMATCH"
  | "PRICING_OVERRIDE_MISSING"
  | "PRICING_NO_CONTRACT"
  | "PRICING_UNEXPLAINED";

export interface Finding {
  code: FindingCode;
  severity: "high" | "medium" | "low";
  summary: string;
  fix: string;
  evidence: Record<string, unknown>;
}

const BACKDATE_DAYS = 34; // Metronome ingest backdating + dedupe window
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Checks that only need the searched events + account config. */
export function checkEvents(
  events: SearchedEvent[],
  customers: Customer[],
  metrics: BillableMetric[],
  now: Date = new Date(),
): Finding[] {
  const findings: Finding[] = [];
  const active = metrics.filter((m) => !m.archived_at);

  for (const ev of events) {
    const ref = { transaction_id: ev.transaction_id };

    // 1. Timestamp sanity
    if (!RFC3339.test(ev.timestamp)) {
      findings.push({
        code: "TIMESTAMP_INVALID", severity: "high",
        summary: `Timestamp "${ev.timestamp}" is not RFC 3339.`,
        fix: "Send ISO-8601/RFC 3339 strings with a timezone, e.g. new Date().toISOString().",
        evidence: { ...ref, timestamp: ev.timestamp },
      });
    } else {
      const ageDays = (now.getTime() - Date.parse(ev.timestamp)) / 86_400_000;
      if (ageDays > BACKDATE_DAYS || ageDays < -1) {
        findings.push({
          code: "TIMESTAMP_INVALID", severity: "high",
          summary: ageDays > 0
            ? `Event is ${Math.round(ageDays)} days old — outside the ${BACKDATE_DAYS}-day backdating window.`
            : `Event timestamp is ${Math.round(-ageDays)} days in the future.`,
          fix: "Check clock/timezone handling and seconds-vs-milliseconds conversion in the emitter.",
          evidence: { ...ref, timestamp: ev.timestamp, age_days: Math.round(ageDays) },
        });
      }
    }

    // 2. Duplicates (swallowed by idempotency)
    if (ev.is_duplicate) {
      findings.push({
        code: "DUPLICATE_TRANSACTION_ID", severity: "high",
        summary: `transaction_id "${ev.transaction_id}" was reused, so later events were dropped as duplicates.`,
        fix: "Generate a unique transaction_id per real usage occurrence (e.g. request ID), not per customer/session/day.",
        evidence: { ...ref },
      });
      continue;
    }

    // 3. Customer resolution
    if (!ev.matched_customer) {
      const byExternal = customers.find((c) => c.external_id === ev.customer_id);
      findings.push({
        code: "CUSTOMER_NOT_RESOLVED", severity: "high",
        summary: byExternal
          ? `customer_id "${ev.customer_id}" is ${byExternal.name}'s external_id, but it is not registered as an ingest alias.`
          : `customer_id "${ev.customer_id}" does not match any Metronome customer ID or ingest alias.`,
        fix: byExternal
          ? `Add "${ev.customer_id}" to ingest_aliases for customer ${byExternal.id}, or send the Metronome customer ID.`
          : "Create the customer or add the value as an ingest alias; events for unknown customers are not billed.",
        evidence: { ...ref, customer_id: ev.customer_id, suggested_customer: byExternal?.id },
      });
      continue;
    }
    if (!resolveCustomer(ev.customer_id, customers)) continue; // defensive

    if ((ev.matched_billable_metrics ?? []).length > 0) {
      // Matched — still validate aggregation value type.
      for (const mm of ev.matched_billable_metrics!) {
        const m = metrics.find((x) => x.id === mm.id);
        if (m?.aggregation_key && (m.aggregation_type === "sum" || m.aggregation_type === "max")) {
          const v = ev.properties?.[m.aggregation_key];
          if (typeof v !== "number" && !(typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)))) {
            findings.push({
              code: "AGGREGATION_KEY_INVALID", severity: "high",
              summary: `Metric "${m.name}" sums "${m.aggregation_key}" but the value is ${JSON.stringify(v)} (not numeric).`,
              fix: `Send "${m.aggregation_key}" as a number.`,
              evidence: { ...ref, metric_id: m.id, value: v },
            });
          }
        }
      }
      continue;
    }

    // 4. Unmatched — explain why.
    const typeMatched = active.filter((m) => eventTypeMatches(m, ev.event_type));
    if (typeMatched.length === 0) {
      const known = active.flatMap((m) => m.event_type_filter?.in_values ?? []);
      const hint = closest(ev.event_type, known);
      findings.push({
        code: "EVENT_TYPE_NOT_MATCHED", severity: "high",
        summary: `No active billable metric accepts event_type "${ev.event_type}".` + (hint ? ` Closest configured: "${hint}".` : ""),
        fix: hint
          ? `Rename the emitted event_type to "${hint}" (or add "${ev.event_type}" to the metric's event_type_filter).`
          : "Create a billable metric for this event type or fix the emitter.",
        evidence: { ...ref, event_type: ev.event_type, closest_configured: hint },
      });
      continue;
    }
    for (const m of typeMatched) {
      const fail = failingPropertyFilter(m, ev);
      if (!fail) continue;
      const isAggKey = fail.filter === m.aggregation_key && fail.reason === "missing";
      if (isAggKey) {
        const keys = Object.keys(ev.properties ?? {});
        const k = fail.filter.toLowerCase();
        // Prefer renames that contain the key ("tokens" → "token_count"), then fall back to edit distance.
        const hint = keys.find((x) => x.toLowerCase().includes(k) || k.includes(x.toLowerCase()) || x.toLowerCase().startsWith(k.replace(/s$/, "")))
          ?? closest(fail.filter, keys, 3);
        findings.push({
          code: "AGGREGATION_KEY_INVALID", severity: "high",
          summary: `Metric "${m.name}" aggregates on "${fail.filter}", but the event has no such property` + (hint ? ` (it sends "${hint}").` : "."),
          fix: hint ? `Rename property "${hint}" to "${fail.filter}" in the emitter.` : `Include "${fail.filter}" on every event.`,
          evidence: { ...ref, metric_id: m.id, aggregation_key: fail.filter, event_properties: Object.keys(ev.properties ?? {}) },
        });
        continue;
      }
      const caseHint = fail.allowed?.find((a) => a.toLowerCase() === String(fail.actual).toLowerCase());
      findings.push({
        code: "PROPERTY_FILTER_EXCLUDED", severity: "high",
        summary: `Metric "${m.name}" excluded the event: property "${fail.filter}" ${describe(fail)}.` +
          (caseHint ? ` Values are case-sensitive — expected "${caseHint}".` : ""),
        fix: caseHint
          ? `Normalize "${fail.filter}" to "${caseHint}" before sending (or widen the filter).`
          : `Send a value for "${fail.filter}" that satisfies the metric's filter, or adjust the filter.`,
        evidence: { ...ref, metric_id: m.id, ...fail },
      });
    }
  }
  return dedupe(findings);
}

function describe(f: ReturnType<typeof failingPropertyFilter> & object): string {
  switch (f.reason) {
    case "missing": return "is missing";
    case "should_not_exist": return "must not be present";
    case "not_in_allowed": return `= ${JSON.stringify(f.actual)}, allowed ${JSON.stringify(f.allowed)}`;
    case "in_excluded": return `= ${JSON.stringify(f.actual)}, which is excluded`;
  }
}

/** Same root cause across many events → one finding. Values that vary per event don't split it. */
function dedupeKey(f: Finding): string {
  const e = f.evidence;
  switch (f.code) {
    case "DUPLICATE_TRANSACTION_ID":
      return f.code;
    case "AGGREGATION_KEY_INVALID":
      return `${f.code}|${e.metric_id}|${"value" in e ? "type" : "missing"}`;
    case "TIMESTAMP_INVALID":
      return `${f.code}|${e.age_days === undefined ? "format" : Number(e.age_days) > 0 ? "old" : "future"}`;
    default:
      return `${f.code}|${f.summary}`;
  }
}

function dedupe(findings: Finding[]): Finding[] {
  const map = new Map<string, Finding>();
  for (const f of findings) {
    const key = dedupeKey(f);
    const existing = map.get(key);
    if (existing) {
      (existing.evidence.transaction_ids as string[]).push(String(f.evidence.transaction_id));
    } else {
      const { transaction_id, ...rest } = f.evidence;
      map.set(key, { ...f, evidence: { ...rest, transaction_ids: [String(transaction_id)] } });
    }
  }
  return [...map.values()].map((f) => {
    const n = (f.evidence.transaction_ids as string[]).length;
    return n > 1 ? { ...f, summary: `${f.summary} (${n} events affected; example shown)` } : f;
  });
}

export interface InvoiceExpectation {
  line_item_name: string;
  expected_unit_price?: number;
  expected_quantity?: number;
}

export function checkInvoice(invoice: Invoice, exp: InvoiceExpectation): Finding[] {
  const li = invoice.line_items.find((l) => l.name === exp.line_item_name);
  const out: Finding[] = [];
  if (!li) {
    return [{
      code: "INVOICE_QUANTITY_MISMATCH", severity: "high",
      summary: `Invoice ${invoice.id} has no line item named "${exp.line_item_name}".`,
      fix: "Confirm the product is on the customer's contract/rate card for this period.",
      evidence: { invoice_id: invoice.id, line_items: invoice.line_items.map((l) => l.name) },
    }];
  }
  if (exp.expected_unit_price !== undefined && li.unit_price !== exp.expected_unit_price) {
    out.push({
      code: "INVOICE_PRICE_MISMATCH", severity: "high",
      summary: `"${li.name}" billed at ${li.unit_price} per unit; customer expected ${exp.expected_unit_price}.`,
      fix: "See the pricing root cause for why this price applied.",
      evidence: { invoice_id: invoice.id, billed_unit_price: li.unit_price, expected_unit_price: exp.expected_unit_price },
    });
  }
  if (exp.expected_quantity !== undefined && li.quantity !== exp.expected_quantity) {
    out.push({
      code: "INVOICE_QUANTITY_MISMATCH", severity: "medium",
      summary: `"${li.name}" quantity is ${li.quantity}; customer's own records show ${exp.expected_quantity}.`,
      fix: "Run the event checks for this period — dropped, duplicate, or unmatched events usually explain the gap.",
      evidence: { invoice_id: invoice.id, billed_quantity: li.quantity, expected_quantity: exp.expected_quantity },
    });
  }
  return out;
}
