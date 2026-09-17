import type { Contract, ContractOverride, Invoice, RateSchedule } from "../metronome/types.ts";
import type { Finding } from "./findings.ts";

/**
 * Explains WHY an invoice line item has the unit price it has, by rebuilding
 * the price from the contract's rate card + overrides.
 *
 * Simplified model (good enough to diagnose, not to bill):
 *   list price from the rate card schedule covering the period start
 *   → an active OVERWRITE override replaces it (lowest `priority` number first)
 *   → active MULTIPLIER overrides multiply it
 */
export interface PriceBreakdown {
  product_id?: string;
  period_start: string;
  contract_id?: string;
  rate_card_id?: string;
  list_price?: number;
  active_overrides: Array<Pick<ContractOverride, "id" | "type" | "starting_at" | "ending_before" | "multiplier" | "priority"> & { price?: number }>;
  inactive_overrides: Array<Pick<ContractOverride, "id" | "type" | "starting_at" | "ending_before" | "multiplier" | "priority"> & { price?: number }>;
  computed_price?: number;
  billed_price?: number;
}

const covers = (start: string, end: string | null | undefined, at: string) =>
  Date.parse(start) <= Date.parse(at) && (!end || Date.parse(at) < Date.parse(end));

const same = (a: number | undefined, b: number | undefined) =>
  a !== undefined && b !== undefined && Math.abs(a - b) < 1e-9;

const day = (iso: string) => iso.slice(0, 10);

export function contractCovering(contracts: Contract[], at: string): Contract | undefined {
  return contracts.find((c) => covers(c.starting_at, c.ending_before, at));
}

export function explainPrice(
  invoice: Invoice,
  lineItemName: string,
  expectedPrice: number | undefined,
  contract: Contract | undefined,
  rates: RateSchedule[],
): { breakdown: PriceBreakdown; findings: Finding[] } {
  const at = invoice.start_timestamp;
  const li = invoice.line_items.find((l) => l.name === lineItemName);
  const breakdown: PriceBreakdown = {
    product_id: li?.product_id, period_start: at, billed_price: li?.unit_price,
    active_overrides: [], inactive_overrides: [],
  };
  const findings: Finding[] = [];
  if (!li?.product_id) return { breakdown, findings };

  if (!contract) {
    findings.push({
      code: "PRICING_NO_CONTRACT", severity: "high",
      summary: `No contract covers ${day(at)}, the start of invoice ${invoice.id}.`,
      fix: "Check the contract's start/end dates; the customer may have been billed off an expired or not-yet-started contract.",
      evidence: { invoice_id: invoice.id, period_start: at },
    });
    return { breakdown, findings };
  }
  breakdown.contract_id = contract.id;
  breakdown.rate_card_id = contract.rate_card_id;

  const schedule = rates.find((r) => r.product_id === li.product_id && covers(r.starting_at, r.ending_before, at));
  const list = schedule?.rate.price;
  breakdown.list_price = list;

  const forProduct = (contract.overrides ?? []).filter((o) => o.product?.id === li.product_id);
  const priceOf = (o: ContractOverride) =>
    o.type === "OVERWRITE" ? o.overwrite_rate?.price : o.type === "MULTIPLIER" && list !== undefined && o.multiplier !== undefined ? list * o.multiplier : undefined;
  const view = (o: ContractOverride) => ({
    id: o.id, type: o.type, starting_at: o.starting_at, ending_before: o.ending_before,
    multiplier: o.multiplier, priority: o.priority, price: priceOf(o),
  });
  const active = forProduct.filter((o) => covers(o.starting_at, o.ending_before, at));
  const inactive = forProduct.filter((o) => !covers(o.starting_at, o.ending_before, at));
  breakdown.active_overrides = active.map(view);
  breakdown.inactive_overrides = inactive.map(view);

  let price = list;
  const overwrite = active.filter((o) => o.type === "OVERWRITE")
    .sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity))[0];
  if (overwrite?.overwrite_rate?.price !== undefined) price = overwrite.overwrite_rate.price;
  for (const m of active.filter((o) => o.type === "MULTIPLIER")) {
    if (price !== undefined && m.multiplier !== undefined) price *= m.multiplier;
  }
  breakdown.computed_price = price;

  if (expectedPrice === undefined || same(li.unit_price, expectedPrice)) return { breakdown, findings };

  // Root cause 1: the right override exists but isn't in effect for this period.
  const misdated = inactive.find((o) => same(priceOf(o), expectedPrice));
  if (misdated) {
    const late = Date.parse(misdated.starting_at) > Date.parse(at);
    findings.push({
      code: "PRICING_OVERRIDE_DATE_MISMATCH", severity: "high",
      summary: late
        ? `The contract has the ${expectedPrice} override for "${lineItemName}", but it starts ${day(misdated.starting_at)} — after this invoice period began (${day(at)}), so the list price ${list} applied.`
        : `The ${expectedPrice} override for "${lineItemName}" ended ${day(String(misdated.ending_before))}, before this invoice period (${day(at)}).`,
      fix: late
        ? `Move override ${misdated.id} to start ${day(at)} (or the negotiated date), then regenerate or credit the affected invoice.`
        : `Extend override ${misdated.id}'s end date if the discount should still apply, then credit the affected invoice.`,
      evidence: { invoice_id: invoice.id, override_id: misdated.id, override_starting_at: misdated.starting_at, override_ending_before: misdated.ending_before, period_start: at },
    });
    return { breakdown, findings };
  }

  // Root cause 2: nothing on the contract gives the quoted price; list price was billed.
  if (active.length === 0 && same(li.unit_price, list)) {
    findings.push({
      code: "PRICING_OVERRIDE_MISSING", severity: "high",
      summary: `Contract ${contract.id} has no override for "${lineItemName}", so the rate card list price ${list} was billed instead of the quoted ${expectedPrice}.`,
      fix: `If ${expectedPrice} was agreed, add an OVERWRITE override for product ${li.product_id} on the contract (check the signed order form first), then credit the difference.`,
      evidence: { invoice_id: invoice.id, contract_id: contract.id, rate_card_id: contract.rate_card_id, list_price: list },
    });
    return { breakdown, findings };
  }

  // Otherwise: can't explain it with the simplified model — hand to a human with the breakdown.
  findings.push({
    code: "PRICING_UNEXPLAINED", severity: "medium",
    summary: `Billed ${li.unit_price}, expected ${expectedPrice}, and the contract model computes ${price}. Needs a human look.`,
    fix: "Review tiered rates, credit-type conversions, and override specifiers in the Metronome UI.",
    evidence: { invoice_id: invoice.id, breakdown },
  });
  return { breakdown, findings };
}

/** Fetches what explainPrice needs. Shared by the agent tool and offline triage. */
export async function lookupAndExplainPrice(
  mc: import("../metronome/client.ts").MetronomeClient,
  invoice: Invoice,
  lineItemName: string,
  expectedPrice?: number,
) {
  const contract = contractCovering(await mc.listContracts(invoice.customer_id, invoice.start_timestamp), invoice.start_timestamp);
  const productId = invoice.line_items.find((l) => l.name === lineItemName)?.product_id;
  const rates = contract ? await mc.getRates(contract.rate_card_id, invoice.start_timestamp, productId) : [];
  return explainPrice(invoice, lineItemName, expectedPrice, contract, rates);
}
