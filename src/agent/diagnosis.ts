import type { Finding, FindingCode } from "../checks/findings.ts";

/** Structured output every investigation must end with (agent or offline). */
export interface Diagnosis {
  status: "root_cause_found" | "no_issue_found" | "needs_human";
  root_causes: Array<{ code: FindingCode | "OTHER"; summary: string; fix: string }>;
  confidence: number; // 0..1
  customer_reply: string;
  internal_notes: string;
}

export const diagnosisSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "root_causes", "confidence", "customer_reply", "internal_notes"],
  properties: {
    status: { type: "string", enum: ["root_cause_found", "no_issue_found", "needs_human"] },
    root_causes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "summary", "fix"],
        properties: {
          code: {
            type: "string",
            enum: [
              "CUSTOMER_NOT_RESOLVED", "EVENT_TYPE_NOT_MATCHED", "PROPERTY_FILTER_EXCLUDED",
              "AGGREGATION_KEY_INVALID", "DUPLICATE_TRANSACTION_ID", "TIMESTAMP_INVALID",
              "INVOICE_PRICE_MISMATCH", "INVOICE_QUANTITY_MISMATCH", "EVENTS_NOT_FOUND",
              "PRICING_OVERRIDE_DATE_MISMATCH", "PRICING_OVERRIDE_MISSING", "PRICING_NO_CONTRACT", "PRICING_UNEXPLAINED", "OTHER",
            ],
          },
          summary: { type: "string" },
          fix: { type: "string" },
        },
      },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    customer_reply: { type: "string", description: "Ready-to-send reply to the customer. Plain, specific, no internal jargon." },
    internal_notes: { type: "string", description: "Evidence trail for the support engineer." },
  },
} as const;

/** Validate model output rather than trusting it. Returns an error string or null. */
export function validateDiagnosis(d: unknown): string | null {
  if (!d || typeof d !== "object") return "diagnosis must be an object";
  const x = d as Record<string, unknown>;
  if (!["root_cause_found", "no_issue_found", "needs_human"].includes(String(x.status))) return "invalid status";
  if (!Array.isArray(x.root_causes)) return "root_causes must be an array";
  if (x.status === "root_cause_found" && x.root_causes.length === 0) return "root_cause_found requires at least one root cause";
  if (typeof x.confidence !== "number" || x.confidence < 0 || x.confidence > 1) return "confidence must be 0..1";
  if (typeof x.customer_reply !== "string" || x.customer_reply.length < 20) return "customer_reply too short";
  return null;
}

const EVENT_CODES = new Set([
  "EVENTS_NOT_FOUND", "CUSTOMER_NOT_RESOLVED", "EVENT_TYPE_NOT_MATCHED", "PROPERTY_FILTER_EXCLUDED",
  "AGGREGATION_KEY_INVALID", "DUPLICATE_TRANSACTION_ID", "TIMESTAMP_INVALID",
]);
const isPricing = (f: Finding) => f.code.startsWith("PRICING_");
const affected = (f: Finding) => Number(f.evidence.affected_events ?? 0);

/** Engineer-facing summary: adds the event count. */
function internalSummary(f: Finding): string {
  const n = affected(f);
  return n > 1 ? `${f.summary} [${n} events]` : f.summary;
}

/** Customer-facing wording: no internal jargon, and actions phrased for the customer. */
function customerBullet(f: Finding, all: Finding[]): string | null {
  const hasEventCause = all.some((x) => EVENT_CODES.has(x.code));
  const hasPricingCause = all.some((x) => isPricing(x) && x.code !== "PRICING_UNEXPLAINED");
  let fix: string;
  let summary = f.summary;
  let label = "How to fix";
  const e = f.evidence;
  switch (f.code) {
    case "INVOICE_PRICE_MISMATCH":
      if (hasPricingCause) return null; // symptom; the pricing cause explains it
      fix = "We're reviewing the pricing on your contract for this period and will follow up.";
      break;
    case "INVOICE_QUANTITY_MISMATCH":
      fix = hasEventCause
        ? "The event issue described here explains the gap. Usage sent after the fix will be billed normally."
        : "We're reconciling the usage for this period and will follow up.";
      break;
    case "PRICING_OVERRIDE_DATE_MISMATCH":
      summary = e.starts_late
        ? `Your discounted ${e.line_item} rate of ${e.expected_price} per unit is on your contract, but it was set to start on ${String(e.override_starting_at).slice(0, 10)} instead of ${String(e.period_start).slice(0, 10)}. That's why this invoice used the standard rate of ${e.list_price}.`
        : `Your discounted ${e.line_item} rate of ${e.expected_price} per unit ended on ${String(e.override_ending_before).slice(0, 10)}, before this billing period started, so the standard rate of ${e.list_price} applied.`;
      label = "Next step";
      fix = "We're correcting the dates on our side and will follow up about adjusting the affected invoice.";
      break;
    case "PRICING_OVERRIDE_MISSING":
      summary = `We don't see a discounted ${e.line_item} rate of ${e.expected_price} on your contract, so the standard rate of ${e.list_price} was billed.`;
      label = "Next step";
      fix = "We're checking this against your signed agreement and will follow up.";
      break;
    case "PRICING_NO_CONTRACT":
      label = "Next step";
      fix = "We're checking your contract dates and will follow up about the affected invoice.";
      break;
    case "PRICING_UNEXPLAINED":
      return null; // handled by the needs-human reply
    default:
      fix = f.fix
        .replace(/ in the emitter/g, " in the code that sends your usage events")
        .replace(/fix the emitter/g, "update the code that sends your usage events")
        .replace(/the sender's logs/g, "your sender's logs");
  }
  const n = affected(f);
  const scope = n > 1 ? ` This affected ${n} of the events you shared.` : "";
  return `• ${summary}${scope}\n  ${label}: ${fix}`;
}

/** Deterministic diagnosis used by offline mode (and as a fallback). */
export function diagnosisFromFindings(findings: Finding[], customerName: string): Diagnosis {
  if (findings.length === 0) {
    return {
      status: "no_issue_found",
      root_causes: [],
      confidence: 0.7,
      customer_reply:
        `Hi ${customerName} team — we checked the events you shared and they were accepted, attributed to your account, and matched to your billable metrics. ` +
        `If you're still seeing a discrepancy, send over a few more transaction IDs from the affected window and we'll dig further.`,
      internal_notes: "All automated checks passed.",
    };
  }
  const unexplained = findings.some((f) => f.code === "PRICING_UNEXPLAINED");
  const causes = findings.map((f) => ({ code: f.code, summary: internalSummary(f), fix: f.fix }));
  const internal_notes = findings.map((f) => `${f.code}: ${JSON.stringify(f.evidence)}`).join("\n");

  if (unexplained) {
    return {
      status: "needs_human", root_causes: causes, confidence: 0.4, internal_notes,
      customer_reply:
        `Hi ${customerName} team, thanks for flagging this. The price on your invoice doesn't match what we expected either, ` +
        `so we're reviewing it with our billing team and will follow up shortly.`,
    };
  }

  const bullets = findings.map((f) => customerBullet(f, findings)).filter(Boolean).join("\n\n");
  const closing: string[] = [];
  if (findings.some((f) => EVENT_CODES.has(f.code) && f.code !== "EVENTS_NOT_FOUND")) {
    closing.push("Once that's updated, new usage will be counted normally. If you need to recover usage that was missed, events up to 34 days old can be re-sent with new transaction IDs.");
  }
  if (findings.some((f) => f.code === "EVENTS_NOT_FOUND")) {
    closing.push("If you can share any errors your sender logged, we're happy to take a look.");
  }
  return {
    status: "root_cause_found",
    root_causes: causes,
    confidence: 0.85,
    internal_notes,
    customer_reply:
      `Hi ${customerName} team, thanks for the details. Here's what we found:\n\n${bullets}` +
      (closing.length ? `\n\n${closing.join(" ")}` : ""),
  };
}
