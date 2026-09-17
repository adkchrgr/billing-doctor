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
  const causes = findings.map((f) => ({ code: f.code, summary: f.summary, fix: f.fix }));
  const bullets = causes.map((c) => `• ${c.summary}\n  Fix: ${c.fix}`).join("\n");
  return {
    status: unexplained ? "needs_human" : "root_cause_found",
    root_causes: causes,
    confidence: unexplained ? 0.4 : 0.85,
    customer_reply:
      `Hi ${customerName} team — thanks for the details. We traced the issue to the following:\n\n${bullets}\n\n` +
      `Once that's updated, new events will be picked up normally. Events inside Metronome's 34-day backdating window can be re-sent with new transaction IDs if you need to recover the missed usage.`,
    internal_notes: findings.map((f) => `${f.code}: ${JSON.stringify(f.evidence)}`).join("\n"),
  };
}
