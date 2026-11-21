import { HARD_CASES } from "./aggregate.mjs";
import { OPEN_STAGES } from "./crm.mjs";
import { DAY } from "./normalize.mjs";
import { API_VERSION_DATE } from "./paging.mjs";

const IDENTITY_LABELS = {
  email: "Unique email with no phone conflict",
  phoneOnly: "Phone only",
  conflicting: "Conflicting or ambiguous identity",
  unknown: "Usable email with no CRM match",
  noEmail: "No usable email or phone match",
};

const HOLD_LABELS = {
  ambiguous_person: "Ambiguous or unresolved identity",
  phone_only: "Phone only",
  phone_conflict: "Phone names another person",
  unknown_payer: "Unknown payer",
  no_payer_email: "No usable payer email",
  several_open_deals: "Several open deals",
  qualified_only: "Qualified deal",
  side_deal: "Side deal or Call held without binding",
  won_deal_no_membership: "Won deal with no membership binding",
  lost_by_person: "Deal marked lost by a person",
  system_loss: "System loss",
  no_open_deal: "No eligible open deal",
  deal_newer_than_payment: "Deal created after collection",
  stale_payment: "Before import cutoff or older than 7 days",
  multi_item: "Line item count differs from one",
  missing_provider_context: "Provider setup missing from the CRM export",
  unmapped_product: "Product or variant mapping missing or invalid",
  financing: "Financing",
  renewal_unbound: "Unbound renewal",
  unknown_billing_reason: "Unknown billing reason",
  unbound_membership: "Unbound membership history or payment scan limit",
  unsupported_currency: "Total unavailable or unsupported for automatic import",
  unlinked_manual_payment: "Unlinked counting CRM payment",
  capacity_hold: "Capacity, allocation, or binding hold",
  no_closer: "No assigned closer",
  dispute: "Dispute",
  refund: "Refund",
};

const STAGES = {
  qualified: "Qualified",
  booked: "Booked",
  call_held: "Call held",
  follow_up: "Follow-up",
  unknown: "Stage unknown",
};

const AMOUNT_LABELS = {
  equal: "Equal",
  underThree: "Differs by under 3%",
  threeOrMore: "Differs by 3% or more",
  differentCurrency: "Different currencies",
  unavailable: "Amount unavailable",
};

const DELAY_LABELS = {
  under15: "Under 15 minutes",
  underHour: "15 minutes to under 1 hour",
  sameDay: "Same day (1 hour to under 24 hours)",
  upToSevenDays: "1 to 7 days",
  later: "More than 7 days",
  noMeeting: "No earlier held meeting",
};

function ratio(numerator, denominator) {
  const percent = denominator ? `${(100 * numerator / denominator).toFixed(2)}%` : "n/a";
  return `${numerator}/${denominator} (${percent})`;
}

function date(at) {
  return new Date(at).toISOString();
}

function count(map, key) {
  return map.get(key) ?? 0;
}

function labeledRows(counts, labels, denominator, omitZero = false) {
  return Object.entries(labels).flatMap(([key, label]) => {
    const value = count(counts, key);
    return omitZero && !value ? [] : [`| ${label} | ${ratio(value, denominator)} |`];
  });
}

function observedRows(counts, denominator) {
  return [...counts.entries()].sort(([a], [b]) => typeof a === "number" && typeof b === "number"
    ? a - b : String(a).localeCompare(String(b), "en", { numeric: true }))
    .map(([label, value]) => `| ${String(label).replaceAll("_", " ")} | ${ratio(value, denominator)} |`);
}

function coverageRows(catalog, label, paid) {
  let cumulative = 0;
  return catalog.top.map((count, index) => {
    cumulative += count;
    return `| ${label} ${index + 1} | ${ratio(count, paid)} | ${ratio(cumulative, paid)} |`;
  });
}

export function renderReport(report, { account, window, times, dryRun, sandbox }) {
  const {
    scans, difference, observed, paid, identities, exactEmail, historical, people, outcomes, holds,
    comparison, catalog, membership, capacity, decisions, hardCases,
  } = report;
  const days = (window.to - window.from) / DAY;
  const needsPerson = count(outcomes, "needs_person");
  const first = scans.first;
  const second = scans.second;
  const createdPaid = count(report.statuses, "paid");
  const currencyRows = report.totals.map(({ label, observed: n, count: paidCount, withTotal, decimals, gross }) =>
    `| ${label} | ${decimals.join(", ") || "Unknown"} | ${ratio(n, observed)} | ${ratio(paidCount, paid)} | ${gross} | ${ratio(withTotal, paidCount)} |`);
  return [
    "# Whop payment measurement",
    "",
    `- Window ${date(window.from).slice(0, 10)} through ${date(window.to).slice(0, 10)} (exclusive), UTC`,
    `- Account ending in \`${account.slice(-4)}\``,
    `- API version date ${API_VERSION_DATE}`,
    `- Source ${dryRun ? "fixture replay" : sandbox ? "Whop sandbox" : "Whop live"}`,
    `- First scan ${date(times.first.started)} to ${date(times.first.finished)}`,
    `- Second scan ${date(times.second.started)} to ${date(times.second.finished)}`,
    "",
    "## Scan agreement",
    "",
    "Both scans use the same creation window and include all statuses. The second scan supplies the measurement cohort.",
    "",
    "| Scan | Pages | Unique in scope / rows returned | Wrong account | Outside creation window | Duplicate rows in scope |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...[["First", first], ["Second", second], ["Refund filter", scans.refunds], ["Dispute filter", scans.disputes]].map(
      ([label, scan]) => `| ${label} | ${scan.pages} | ${ratio(scan.unique, scan.returned)} | ${ratio(scan.wrongAccount, scan.returned)} | ${ratio(scan.outsideFilter, scan.returned)} | ${ratio(scan.duplicates, scan.returned)} |`,
    ),
    "",
    `- Payment IDs differing in presence or gross total across scans. ${ratio(difference.different, difference.unique)} across both scans.`,
    `- First scan only. ${ratio(difference.firstOnly, difference.unique)}. Second scan only. ${ratio(difference.secondOnly, difference.unique)}.`,
    `- Gross total changed. ${ratio(difference.amountChanged, difference.shared)} shared IDs. Status changed. ${ratio(difference.statusChanged, difference.shared)} shared IDs.`,
    "",
    "## Gross collected",
    "",
    `The paid cohort contains ${ratio(paid, observed)} second-scan payments. Among ${createdPaid} payments with paid status, ${ratio(report.paidOutsideWindow, createdPaid)} show collection outside the window and ${ratio(report.paidMissingDate, createdPaid)} have no usable collection time.`,
    "",
    "Compare the gross totals with Whop's gross collected view for the same UTC dates and account. Gross uses the payment total before subtracting refunds and excludes buyer fees. The creation filter misses a payment created before the window and collected during it.",
    "",
    "| Currency | Observed decimals | Observed / all | Paid / all paid | Gross collected | With total / paid in currency |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
    ...currencyRows,
    "",
    "| Payment status | Payments / second scan |",
    "| --- | ---: |",
    ...observedRows(report.statuses, observed),
    "",
    "## Matching and deal history",
    "",
    `- Email names exactly one surviving person. ${ratio(exactEmail, paid)}. This count includes unique emails with a phone conflict.`,
    `- Person established by a trusted allocation, binding, or uncontested email. ${ratio(people, paid)}.`,
    "",
    "| Payer evidence | Payments / all paid |",
    "| --- | ---: |",
    ...labeledRows(identities, IDENTITY_LABELS, paid),
    "",
    `Open and won counts are for the ${people} paid payments with an established person, as of collection. Exported stage transitions ${report.hasHistory ? "were available" : "were absent"}. ${ratio(historical.snapshotFallback, people)} used the CRM snapshot or closure dates for at least one deal. Reopens or stage changes missing from the export can affect the counts.`,
    "",
    "| Deals per payment | Open / payments with person | Won / payments with person |",
    "| --- | ---: | ---: |",
    ...["0", "1", "2+", "Unknown"].map((bucket) =>
      `| ${bucket} | ${ratio(count(historical.openCounts, bucket), people)} | ${ratio(count(historical.wonCounts, bucket), people)} |`,
    ),
    "",
    "| Stage | Stage occurrences / open deals in 1-deal bucket | Stage occurrences / open deals in 2+ bucket | Stage occurrences / known open deals in unknown-count bucket |",
    "| --- | ---: | ---: | ---: |",
    ...[...OPEN_STAGES, "unknown"].map((stage) => {
      const stageShare = (bucket) => ratio(historical.stages.get(bucket)?.get(stage) ?? 0, count(historical.stageTotals, bucket));
      return `| ${STAGES[stage]} | ${stageShare("1")} | ${stageShare("2+")} | ${stageShare("Unknown")} |`;
    }),
    "",
    `Readiness uses the current CRM snapshot and the start time of the second scan. Provider mappings, allocations, and import cutoff ${report.hasProviderContext ? "were available in the export" : "were incomplete or absent from the export"}. The seven-day age rule applies to the full window.`,
    "",
    "| Full matching rule | Payments / all paid |",
    "| --- | ---: |",
    ...labeledRows(outcomes, {
      ready: "Ready", resolved: "Existing allocation", needs_person: "Needs a person", not_actionable: "Nonpositive total in a two-decimal currency",
    }, paid),
    "",
    `Expected exceptions at this window's rate. ${needsPerson} payments over ${days} days, or ${(needsPerson / days).toFixed(2)} per day. The owner assigns the Billing reviewer.`,
    "",
    "| First hold reason | Payments / needs a person |",
    "| --- | ---: |",
    ...labeledRows(holds, HOLD_LABELS, needsPerson, true),
    "",
    "## Whop and CRM payment coverage",
    "",
    `CRM records use recorded time. This is same-person coverage within the window. It does not establish which charge a CRM record represents. The product never links by amount or time.`,
    "",
    "| Coverage | Count / records on that side |",
    "| --- | ---: |",
    `| CRM records with no identified Whop counterpart | ${ratio(comparison.crmNoWhop, comparison.crmCount)} |`,
    `| CRM records with a known person and no identified Whop counterpart | ${ratio(comparison.crmKnownNoWhop, comparison.crmCount)} |`,
    `| CRM records whose person is unresolved | ${ratio(comparison.crmUnknown, comparison.crmCount)} |`,
    `| Paid Whop payments with no identified CRM counterpart | ${ratio(comparison.whopNoCrm, paid)} |`,
    `| Paid Whop payments with a known person and no identified CRM counterpart | ${ratio(comparison.whopKnownNoCrm, paid)} |`,
    `| Paid Whop payments whose person is unresolved | ${ratio(comparison.whopUnknown, paid)} |`,
    `| Excess paid Whop charges over CRM records, among repeat-membership charges with an identified person | ${ratio(comparison.repeatedExcess, comparison.repeatedCharges)} |`,
    "",
    "The repeat-membership comparison assumes one CRM row per charge for the count. A manual row can cover several charges.",
    "",
    "Amounts use the people with exactly one paid Whop payment and one CRM record entered by staff. The Whop gross total is the base for the 3% test. CRM stores its entered amounts in hundredths.",
    "",
    "| Amount comparison | People / one-to-one pairs |",
    "| --- | ---: |",
    ...labeledRows(comparison.amounts, AMOUNT_LABELS, comparison.pairs),
    "",
    "## Timing, refunds, and disputes",
    "",
    "Delay uses the scheduled start of the nearest earlier CRM meeting marked held.",
    "",
    "| Collection delay | Payments / paid with known person |",
    "| --- | ---: |",
    ...labeledRows(report.delays, DELAY_LABELS, people),
    "",
    `- Refund filter. ${ratio(scans.refunds.unique, scans.refunds.returned)} distinct in-scope payments from the refund-time filter.`,
    `- Dispute filter. ${ratio(scans.disputes.unique, scans.disputes.returned)} distinct in-scope payments from the dispute-opened-time filter.`,
    `- Paid cohort with refund evidence. ${ratio(report.affected.refunds, paid)}. Paid cohort with dispute or dispute-alert evidence. ${ratio(report.affected.disputes, paid)}.`,
    "",
    "The date filters count affected payments, including charges created before the window. One payment can have several refund or dispute events. In the paid cohort, the payment's current state can also show a refund or dispute outside the window.",
    "",
    "## Billing and financing",
    "",
    "| Billing reason | Payments / all paid |",
    "| --- | ---: |",
    ...observedRows(report.billing, paid),
    "",
    "| Payment method | Payments / all paid |",
    "| --- | ---: |",
    ...observedRows(report.methods, paid),
    "",
    "| Reported instalment count | Payments / all paid |",
    "| --- | ---: |",
    ...observedRows(report.installmentCounts, paid),
    "",
    `Financing. ${ratio(report.financing, paid)} based on the method or an instalment count above one.`,
    "",
    "| Financing method / instalment count | Payments / financed |",
    "| --- | ---: |",
    ...observedRows(report.financingBreakdown, report.financing),
    "",
    "## Products, variants, and memberships",
    "",
    `The second scan shows ${catalog.products.unique} distinct products and ${catalog.variants.unique} distinct variants across ${observed} payments. Paid payments missing a product. ${ratio(catalog.products.missing, paid)}. Paid payments missing a variant. ${ratio(catalog.variants.missing, paid)}.`,
    "",
    "Coverage ranks up to ten products and ten variants by paid payment count. It covers only products and variants seen on payments.",
    "",
    "| Rank | Payments / all paid | Cumulative / all paid |",
    "| --- | ---: | ---: |",
    ...coverageRows(catalog.products, "Product", paid),
    ...coverageRows(catalog.variants, "Variant", paid),
    "",
    `There are ${membership.count} memberships across ${ratio(membership.payments, paid)} paid payments. The largest has ${membership.max} payments. Unbound membership history was detected for ${ratio(membership.unbound, people)} paid payments with an established person.`,
    "",
    "| Paid payments per membership | Memberships / observed paid memberships |",
    "| --- | ---: |",
    ...observedRows(membership.distribution, membership.count),
    "",
    "## Deal capacity",
    "",
    `Across ${capacity.deals} CRM deals, the largest stored payment count is ${capacity.existingMax} and the largest projected count is ${capacity.projectedMax}. The estimate adds ${ratio(capacity.additions, paid)} observed charges to candidate deals. It could place no candidate for ${ratio(capacity.unresolved, paid)} charges.`,
    "",
    "The projection starts with all stored rows, disputed rows included. It places unallocated charges with a trusted target, a single known open deal at collection, or the one deal the membership points to in the cohort for that same person. Manual records may already cover some charges. Unplaced charges could raise the maximum after review.",
    "",
    "## Rollout decisions",
    "",
    `- Fewer than 85% of paid payments match exactly one person by email? **${decisions.belowIdentityTarget ? "Yes" : "No"}**. ${ratio(exactEmail, paid)}. A Yes moves CRM-made links ahead of automatic wins.`,
    `- Does any deal approach 40 payments? **${decisions.atCapacity ? "Yes" : "No"}**. Projected maximum ${capacity.projectedMax} of the 40-payment threshold, across ${capacity.deals} deals. A Yes moves the shared payment summary ahead of later payment recording.`,
    "",
    "An empty paid cohort has no identity rate. Its No cannot clear the rollout gate.",
    "",
    "## Hand-check sample",
    "",
    `The separate local file contains ${ratio(report.sampleSize, paid)} paid payments. The target is at least 60 when the window contains enough. It contains personal data and must stay local.`,
    "",
    "| Hard case | Present in window |",
    "| --- | --- |",
    ...Object.entries(HARD_CASES).map(([key, label]) => `| ${label} | ${hardCases.has(key) ? "Yes" : "No"} |`),
    "",
    "## Not measured",
    "",
    "- Whose email Whop puts on a payment. Test the payer and beneficiary roles with a sandbox purchase.",
    "- Webhook signature format and verification. Exercise the sandbox webhook separately.",
    "- Collection inside the window for charges created before its start, complete Whop catalog or membership lifetime history, and the true ownership of ambiguous or third-party payments.",
    "",
  ].join("\n");
}
