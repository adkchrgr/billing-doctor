import type { Scenario } from "../scenarios/index.ts";
import type { MetronomeClient } from "../metronome/client.ts";
import { checkEvents, checkInvoice, type Finding } from "../checks/findings.ts";
import { diagnosisFromFindings, type Diagnosis } from "./diagnosis.ts";
import { lookupAndExplainPrice } from "../checks/pricing.ts";

/**
 * No-LLM triage: a fixed pipeline over the same checks the agent uses.
 * Cheap, deterministic — powers the free tier and CI evals.
 */
export async function triageOffline(ticket: Scenario["ticket"], mc: MetronomeClient, now: Date): Promise<{ diagnosis: Diagnosis; findings: Finding[] }> {
  const findings: Finding[] = [];
  const customer = await mc.getCustomer(ticket.customer_id);

  if (ticket.transaction_ids.length > 0) {
    const [events, customers, metrics] = await Promise.all([
      mc.searchEvents(ticket.transaction_ids), mc.listCustomers(), mc.listBillableMetrics(),
    ]);
    findings.push(...checkEvents(events, customers, metrics, now));
  }
  if (ticket.invoice) {
    const invoices = await mc.listInvoices(ticket.customer_id, { status: "FINALIZED" });
    const latest = invoices.sort((a, b) => b.end_timestamp.localeCompare(a.end_timestamp))[0];
    if (latest) {
      findings.push(...checkInvoice(latest, ticket.invoice));
      if (ticket.invoice.expected_unit_price !== undefined) {
        const { findings: pf } = await lookupAndExplainPrice(mc, latest, ticket.invoice.line_item_name, ticket.invoice.expected_unit_price);
        findings.push(...pf);
      }
    }
  }
  return { diagnosis: diagnosisFromFindings(findings, customer?.name ?? "there"), findings };
}
