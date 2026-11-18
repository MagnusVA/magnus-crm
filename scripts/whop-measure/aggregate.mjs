import { crmRecordPerson, dealAt, groupBy } from "./crm.mjs";
import { assessPayment, buildMembershipIndex, identifyPayments, membershipAmbiguity } from "./match.mjs";
import { DAY, formatMinorUnits, reportCurrency, scaleMinorUnits } from "./normalize.mjs";
import { compareScans } from "./paging.mjs";

export const HARD_CASES = {
  unknown: "Unknown payer",
  phoneOnly: "Phone only",
  conflicting: "Conflicting identity",
  noEmail: "No usable email",
  severalOpen: "Several open deals",
  severalWon: "Several won deals",
  unboundMembership: "Unbound membership history",
  renewal: "Renewal",
  financing: "Financing",
  refund: "Refund",
  dispute: "Dispute",
  mismatch: "Amount or currency mismatch",
};

function increment(counts, key) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function countsBy(rows, keyOf) {
  const counts = new Map();
  for (const row of rows) increment(counts, keyOf(row));
  return counts;
}

const inWindow = (at, { from, to }) => from <= at && at < to;

export function compareAmount(total, record) {
  if (!total || !Number.isSafeInteger(record.amountMinor) || typeof record.currency !== "string") {
    return "unavailable";
  }
  if (total.currency !== record.currency.toUpperCase()) return "differentCurrency";
  const scale = Math.max(total.decimals, 2);
  const whop = scaleMinorUnits(total.minor, total.decimals, scale);
  const crm = scaleMinorUnits(BigInt(record.amountMinor), 2, scale);
  if (whop === crm) return "equal";
  const difference = whop > crm ? whop - crm : crm - whop;
  const reference = whop < 0n ? -whop : whop;
  return difference * 100n < reference * 3n ? "underThree" : "threeOrMore";
}

function countCounterparts(crm, entries, window) {
  const records = crm.allRecords.filter((record) => inWindow(record.recordedAt, window));
  const byCrmPerson = groupBy(records, (record) => crmRecordPerson(crm, record));
  const byWhopPerson = groupBy(entries, (entry) => entry.person);
  const amounts = new Map();
  let repeatedCharges = 0;
  let repeatedExcess = 0;
  for (const [person, whop] of byWhopPerson) {
    const crmRows = byCrmPerson.get(person) ?? [];
    const repeated = whop.filter((entry) => entry.repeatedMembership).length;
    repeatedCharges += repeated;
    repeatedExcess += Math.max(0, repeated - crmRows.length);
    if (whop.length !== 1 || crmRows.length !== 1) continue;
    const [entry] = whop;
    const [record] = crmRows;
    // The same-person window comparison is for measurement. Provider-created
    // rows carry the imported amount and aren't amounts typed by closers.
    if (typeof record.origin === "string" && record.origin.startsWith("provider")) continue;
    entry.comparison = compareAmount(entry.payment.total, record);
    increment(amounts, entry.comparison);
  }
  const crmUnknown = records.filter((record) => !crmRecordPerson(crm, record)).length;
  const whopUnknown = entries.filter((entry) => !entry.person).length;
  const crmNoWhop = records.filter((record) => !byWhopPerson.has(crmRecordPerson(crm, record))).length;
  const whopNoCrm = entries.filter((entry) => !byCrmPerson.has(entry.person)).length;
  return {
    crmCount: records.length, crmUnknown, whopUnknown, crmNoWhop, whopNoCrm,
    crmKnownNoWhop: crmNoWhop - crmUnknown, whopKnownNoCrm: whopNoCrm - whopUnknown,
    pairs: [...amounts.values()].reduce((total, count) => total + count, 0),
    amounts,
    repeatedCharges, repeatedExcess,
  };
}

function nearestMeetingDelay(crm, entry) {
  const { paidAt } = entry.payment;
  const meetings = crm.meetingsByPerson.get(entry.person) ?? [];
  const previous = meetings.find((meeting) => meeting.scheduledAt <= paidAt);
  if (!previous) return "noMeeting";
  const ago = paidAt - previous.scheduledAt;
  if (ago < 15 * 60_000) return "under15";
  if (ago < 60 * 60_000) return "underHour";
  if (ago < DAY) return "sameDay";
  return ago <= 7 * DAY ? "upToSevenDays" : "later";
}

function grossByCurrency(observed, paid) {
  const groups = new Map();
  function currencyGroup(currency) {
    const label = reportCurrency(currency);
    if (!groups.has(label)) groups.set(label, { observed: 0, count: 0, withTotal: 0, decimals: new Set(), totals: [] });
    return groups.get(label);
  }
  for (const payment of observed) {
    const group = currencyGroup(payment.currency);
    group.observed++;
    if (Number.isInteger(payment.decimals)) group.decimals.add(payment.decimals);
  }
  for (const payment of paid) {
    const group = currencyGroup(payment.currency);
    group.count++;
    if (!payment.total) continue;
    group.withTotal++;
    group.totals.push(payment.total);
  }

  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([label, group]) => {
    const scale = group.totals.reduce((max, total) => Math.max(max, total.decimals), 0);
    const total = group.totals.reduce((sum, money) => sum + scaleMinorUnits(money.minor, money.decimals, scale), 0n);
    return {
      label,
      observed: group.observed,
      count: group.count,
      withTotal: group.withTotal,
      decimals: [...group.decimals].sort((a, b) => a - b),
      gross: group.withTotal && label !== "Unrecognized or missing currency" ? formatMinorUnits(total, scale) : "Unavailable",
    };
  });
}

function rankCatalog(observed, paid, field) {
  const unique = new Set(observed.map((payment) => payment[field]).filter(Boolean)).size;
  const counts = countsBy(paid, (payment) => payment[field] || undefined);
  const missing = counts.get(undefined) ?? 0;
  counts.delete(undefined);
  return { unique, missing, top: [...counts.values()].sort((a, b) => b - a).slice(0, 10) };
}

function countDealHistory(crm, entries) {
  const openCounts = new Map();
  const wonCounts = new Map();
  const stages = new Map();
  const stageTotals = new Map();
  let snapshotFallback = 0;
  for (const entry of entries) {
    if (!entry.person) continue;
    const deals = crm.historicalDealsByPerson.get(entry.person) ?? [];
    const positions = deals.map((deal) => ({ deal, position: dealAt(crm, deal, entry.payment.paidAt) }))
      .filter(({ position }) => position);
    entry.open = positions.filter(({ position }) => position.outcome === "open");
    entry.won = positions.filter(({ position }) => position.outcome === "won").length;
    const unknown = positions.some(({ position }) => position.outcome === "unknown");
    if (positions.some(({ position }) => !position.fromHistory)) snapshotFallback++;

    const openBucket = entry.open.length >= 2 ? "2+" : unknown ? "Unknown" : String(entry.open.length);
    const wonBucket = entry.won >= 2 ? "2+" : unknown ? "Unknown" : String(entry.won);
    increment(openCounts, openBucket);
    increment(wonCounts, wonBucket);
    const stageCounts = stages.get(openBucket) ?? new Map();
    for (const { position } of entry.open) {
      increment(stageCounts, position.stage);
      increment(stageTotals, openBucket);
    }
    stages.set(openBucket, stageCounts);
  }
  return { openCounts, wonCounts, stages, stageTotals, snapshotFallback };
}

function dealCapacity(crm, entries) {
  const stored = countsBy(crm.allRecords, (row) =>
    row.opportunityId ?? crm.meetings.get(row.meetingId)?.opportunityId);
  const membershipTargets = new Map();
  for (const entry of entries) {
    const { payment, assessment } = entry;
    const deal = assessment.targetDeal ??
      (entry.open?.length === 1 && assessment.kind !== "resolved" ? entry.open[0].deal : undefined);
    if (!deal) continue;
    entry.capacityDeal = deal._id;
    if (!payment.membershipId || !entry.person) continue;
    const targets = membershipTargets.get(payment.membershipId) ?? new Map();
    targets.set(deal._id, entry.person);
    membershipTargets.set(payment.membershipId, targets);
  }

  const projected = new Map(stored);
  let additions = 0;
  let unresolved = 0;
  for (const entry of entries) {
    if (["resolved", "not_actionable"].includes(entry.assessment.kind)) continue;
    const targets = membershipTargets.get(entry.payment.membershipId);
    const [membershipDeal, membershipPerson] = targets?.size === 1 ? targets.entries().next().value : [];
    const candidate = entry.capacityDeal ?? (membershipPerson === entry.person ? membershipDeal : undefined);
    if (!candidate) {
      unresolved++;
      continue;
    }
    increment(projected, candidate);
    additions++;
  }
  let existingMax = 0;
  let projectedMax = 0;
  for (const deal of crm.deals.keys()) {
    existingMax = Math.max(existingMax, stored.get(deal) ?? 0);
    projectedMax = Math.max(projectedMax, projected.get(deal) ?? 0);
  }
  return { existingMax, projectedMax, additions, unresolved, deals: crm.deals.size };
}

function tagsFor(entry) {
  const { payment, identity, assessment } = entry;
  const tags = [];
  if (identity.bucket !== "email") tags.push(identity.bucket);
  if (entry.open?.length > 1 || assessment.reason === "several_open_deals") tags.push("severalOpen");
  if (entry.won > 1) tags.push("severalWon");
  if (entry.unboundMembership) tags.push("unboundMembership");
  if (payment.billingReason === "subscription_cycle") tags.push("renewal");
  if (payment.financing) tags.push("financing");
  if (entry.refund) tags.push("refund");
  if (entry.dispute) tags.push("dispute");
  if (entry.comparison && !["equal", "unavailable"].includes(entry.comparison)) tags.push("mismatch");
  return tags;
}

function buildSample(entries, window) {
  const selected = new Set();
  const found = new Set();
  for (const [index, entry] of entries.entries()) {
    entry.tags = tagsFor(entry);
    for (const tag of entry.tags) {
      if (!found.has(tag)) selected.add(index);
      found.add(tag);
    }
  }
  const size = Math.min(entries.length, 60);
  for (let index = 0; index < size && selected.size < size; index++) {
    selected.add(Math.floor(index * entries.length / size));
  }
  for (let index = 0; selected.size < size; index++) selected.add(index);
  return {
    found,
    sample: {
      warning: "Contains personal data. Keep local. Do not commit or share.",
      from: new Date(window.from).toISOString(),
      toExclusive: new Date(window.to).toISOString(),
      payments: [...selected].sort((a, b) => a - b).map((index) => {
        const { payment, identity, assessment, tags } = entries[index];
        return {
          whopPaymentId: payment.id,
          crmPersonIds: [...new Set([assessment.person, ...identity.people].filter(Boolean))],
          crmDealIds: [...new Set([
            ...assessment.deals.map((deal) => deal._id),
            ...(entries[index].open ?? []).map(({ deal }) => deal._id),
          ])],
          targetCrmDealId: assessment.targetDeal?._id ?? null,
          hardCases: tags.map((tag) => HARD_CASES[tag]),
        };
      }),
    },
  };
}

export function rolloutDecisions(exactEmail, paid, mostPayments) {
  return { belowIdentityTarget: paid > 0 && exactEmail * 100 < paid * 85, atCapacity: mostPayments >= 40 };
}

function scanSummary({ payments, ...counts }) {
  return { ...counts, unique: payments.size };
}

export function measure({ crm, scans, window, asOf }) {
  const observed = [...scans.second.payments.values()];
  const paid = observed.filter((payment) => payment.status === "paid" && inWindow(payment.paidAt, window))
    .sort((a, b) => a.paidAt - b.paidAt || a.id.localeCompare(b.id));
  const identities = identifyPayments(crm, observed);
  const membershipIndex = buildMembershipIndex(crm, observed, identities);
  const byMembership = groupBy(paid, (payment) => payment.membershipId);
  const entries = paid.map((observedPayment) => {
    const refundRead = scans.refunds.payments.get(observedPayment.id);
    const disputeRead = scans.disputes.payments.get(observedPayment.id);
    const payment = {
      ...observedPayment,
      refunded: observedPayment.refunded || Boolean(refundRead),
      disputeHold: observedPayment.disputeHold || Boolean(disputeRead?.disputeHold),
      disputed: observedPayment.disputed || Boolean(disputeRead),
    };
    const identity = identities.get(payment.id);
    const assessment = assessPayment(crm, payment, identity, membershipIndex, asOf);
    // Same-person coverage uses verified allocations/bindings or uncontested email.
    const person = assessment.targetDeal || assessment.kind === "resolved"
      ? assessment.person : identity.bucket === "email" ? identity.exactEmail : undefined;
    const repeatCount = byMembership.get(payment.membershipId)?.length ?? 0;
    return {
      payment, identity, assessment, person,
      unboundMembership: Boolean(person && membershipAmbiguity(crm, membershipIndex, payment, person) === "unbound_membership"),
      repeatedMembership: repeatCount > 1,
      refund: payment.refunded,
      dispute: payment.disputed,
    };
  });

  const historical = countDealHistory(crm, entries);
  const comparison = countCounterparts(crm, entries, window);
  const capacity = dealCapacity(crm, entries);
  const { found, sample } = buildSample(entries, window);
  const outcomes = countsBy(entries, ({ assessment }) => assessment.kind);
  const exactEmail = entries.filter(({ identity }) => identity.exactEmail !== undefined).length;
  return {
    sample,
    report: {
      scans: Object.fromEntries(Object.entries(scans).map(([key, scan]) => [key, scanSummary(scan)])),
      difference: compareScans(scans.first.payments, scans.second.payments),
      observed: observed.length,
      statuses: countsBy(observed, (payment) => payment.status),
      paid: paid.length,
      paidOutsideWindow: observed.filter((payment) => payment.status === "paid" &&
        payment.paidAt !== undefined && !inWindow(payment.paidAt, window)).length,
      paidMissingDate: observed.filter((payment) => payment.status === "paid" && payment.paidAt === undefined).length,
      totals: grossByCurrency(observed, paid),
      identities: countsBy(entries, ({ identity }) => identity.bucket),
      exactEmail,
      people: entries.filter((entry) => entry.person).length,
      historical,
      outcomes,
      holds: countsBy(entries.filter(({ assessment }) => assessment.kind === "needs_person"),
        ({ assessment }) => assessment.reason),
      hasProviderContext: crm.hasProviderContext,
      hasHistory: crm.hasHistory,
      comparison,
      delays: countsBy(entries.filter((entry) => entry.person), (entry) => nearestMeetingDelay(crm, entry)),
      affected: {
        refunds: entries.filter((entry) => entry.refund).length,
        disputes: entries.filter((entry) => entry.dispute).length,
      },
      billing: countsBy(paid, (payment) => payment.billingReason ?? "Other or missing"),
      methods: countsBy(paid, (payment) => payment.paymentMethod),
      financing: paid.filter((payment) => payment.financing).length,
      installmentCounts: countsBy(paid, (payment) => payment.installments ?? "Missing"),
      financingBreakdown: countsBy(
        paid.filter((payment) => payment.financing),
        (payment) => `${payment.paymentMethod} / ${payment.installments ?? "Missing"}`,
      ),
      catalog: { products: rankCatalog(observed, paid, "productId"), variants: rankCatalog(observed, paid, "variantId") },
      membership: {
        count: byMembership.size,
        payments: paid.filter((payment) => payment.membershipId).length,
        max: [...byMembership.values()].reduce((max, rows) => Math.max(max, rows.length), 0),
        distribution: countsBy(byMembership.values(), (rows) => rows.length),
        unbound: entries.filter((entry) => entry.unboundMembership).length,
      },
      capacity,
      sampleSize: sample.payments.length,
      hardCases: found,
      decisions: rolloutDecisions(exactEmail, paid.length, capacity.projectedMax),
    },
  };
}
