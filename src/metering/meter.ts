import { appendFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { UsageEvent } from "../metronome/types.ts";
import { HttpMetronomeClient } from "../metronome/client.ts";
import type { Usage } from "../agent/loop.ts";

/**
 * Billing Doctor bills ITSELF through Metronome. After every investigation
 * we emit one event to our own Metronome account. Billable metrics we
 * define over these events (see docs/BUSINESS.md):
 *   - "Resolved investigations"  count, filter outcome in [root_cause_found, no_issue_found]
 *   - "Deep investigations"      count, filter mode in [agent]
 *   - "AI tokens"                sum of total_tokens   (cost-plus / internal margin tracking)
 *   - "Replays executed"         sum of replayed_events
 */
export interface InvestigationMeter {
  tenant: string; // Billing Doctor customer (ingest alias in our Metronome)
  mode: "agent" | "offline";
  outcome: string;
  ticket_ref: string;
  tool_calls: number;
  findings: number;
  replayed_events: number;
  usage?: Usage;
}

export function toUsageEvent(m: InvestigationMeter, runId: string = randomUUID()): UsageEvent {
  const u = m.usage;
  return {
    transaction_id: `bd_inv_${runId}`, // one per investigation → safe retries, no double billing
    customer_id: m.tenant,
    event_type: "billing_doctor_investigation",
    timestamp: new Date().toISOString(),
    properties: {
      mode: m.mode,
      outcome: m.outcome,
      ticket_ref: m.ticket_ref,
      tool_calls: m.tool_calls,
      findings: m.findings,
      replayed_events: m.replayed_events,
      input_tokens: u?.input_tokens ?? 0,
      output_tokens: u?.output_tokens ?? 0,
      cache_read_tokens: u?.cache_read_tokens ?? 0,
      total_tokens: (u?.input_tokens ?? 0) + (u?.output_tokens ?? 0),
    },
  };
}

/** Sends to Metronome if BILLING_DOCTOR_METERING_KEY is set, else appends to runs/metering.jsonl. */
export async function recordUsage(event: UsageEvent): Promise<"sent" | "dry_run"> {
  const key = process.env.BILLING_DOCTOR_METERING_KEY;
  if (key) {
    await new HttpMetronomeClient(key).ingestEvents([event]);
    return "sent";
  }
  await mkdir("runs", { recursive: true });
  await appendFile("runs/metering.jsonl", JSON.stringify(event) + "\n");
  return "dry_run";
}
