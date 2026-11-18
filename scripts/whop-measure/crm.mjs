import { usableEmail, usablePhone } from "./normalize.mjs";

export const REQUIRED_TABLES = [
  "leads", "leadIdentifiers", "opportunities", "paymentRecords", "leadMergeHistory", "meetings",
];

export const OPTIONAL_TABLES = [
  "domainEvents", "tenantPaymentConnections", "paymentProviderBindings", "providerPayments", "tenantPrograms",
];

export const IDENTITY_LIMIT = 16;
export const OPEN_STAGES = ["qualified", "booked", "call_held", "follow_up"];

export function groupBy(rows, keyOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (key == null) continue;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

function indexById(rows) {
  return new Map(rows.map((row) => [row._id, row]));
}

function mergeResolver(leads, history) {
  const targets = groupBy(history, (row) => row.sourceLeadId);
  return (id) => {
    let lead = leads.get(id);
    // Convex rejects unresolved chains and any chain that takes five hops.
    for (let depth = 0; lead && depth < 5; depth++) {
      if (lead.status !== "merged" && !lead.mergedIntoLeadId) return lead._id;
      const historical = new Set((targets.get(lead._id) ?? []).map((row) => row.targetLeadId));
      if (!lead.mergedIntoLeadId && historical.size !== 1) return undefined;
      lead = leads.get(lead.mergedIntoLeadId ?? historical.values().next().value);
    }
    return undefined;
  };
}

function peopleForIdentifier(crm, type, value) {
  if (!value) return [];
  const canonical = type === "email" ? crm.canonicalEmails.get(value) ?? [] : [];
  const identifiers = crm.identifiers.get(`${type}:${value}`) ?? [];
  if (canonical.length > IDENTITY_LIMIT || identifiers.length > IDENTITY_LIMIT) return null;
  const ids = new Set(canonical.map((lead) => lead._id));
  for (const identifier of identifiers) {
    if (identifier.confidence !== "suggested") ids.add(identifier.leadId);
  }
  const people = new Set();
  for (const id of ids) {
    const survivor = crm.survivor(id);
    if (!survivor) return null;
    people.add(survivor);
  }
  return [...people];
}

export function matchIdentity(crm, payment) {
  const emailPeople = peopleForIdentifier(crm, "email", payment.email);
  const exactEmail = emailPeople?.length === 1 ? emailPeople[0] : undefined;
  if (!emailPeople || emailPeople.length > 1) {
    return { bucket: "conflicting", reason: "ambiguous_person", people: emailPeople ?? [] };
  }

  const phonePeople = peopleForIdentifier(crm, "phone", payment.phone);
  const people = [...new Set([...emailPeople, ...(phonePeople ?? [])])];
  if (!phonePeople || (!exactEmail && phonePeople.length > 1)) {
    return { bucket: "conflicting", reason: "ambiguous_person", people, exactEmail };
  }
  if (exactEmail && phonePeople.some((person) => person !== exactEmail)) {
    return { bucket: "conflicting", reason: "phone_conflict", people, exactEmail };
  }
  if (exactEmail) return { bucket: "email", people, exactEmail };
  if (phonePeople.length === 1) return { bucket: "phoneOnly", reason: "phone_only", people };
  return payment.email
    ? { bucket: "unknown", reason: "unknown_payer", people }
    : { bucket: "noEmail", reason: "no_payer_email", people };
}

function oldPosition(status, source) {
  switch (status) {
    case "qualified_pending": return { stage: "qualified", outcome: "open" };
    case "scheduled": return { stage: source === "side_deal" ? "call_held" : "booked", outcome: "open" };
    case "follow_up_scheduled":
    case "reschedule_link_sent": return { stage: "follow_up", outcome: "open" };
    case "payment_received": return { stage: "closed", outcome: "won" };
    case "canceled":
    case "no_show":
    case "lost": return { stage: "closed", outcome: "lost" };
    default: return undefined;
  }
}

function position(stage, outcome, source) {
  if (OPEN_STAGES.includes(stage)) return { stage, outcome: "open" };
  if (stage === "closed" && ["won", "lost"].includes(outcome)) return { stage, outcome };
  return oldPosition(stage, source);
}

function eventMetadata(raw) {
  if (typeof raw !== "string") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function indexDealHistory(events, deals) {
  const changes = events.flatMap((event) => {
    if (event.entityType !== "opportunity" || ![
      "opportunity.marked_lost", "opportunity.stage_changed",
    ].includes(event.eventType)) return [];
    if (!Number.isFinite(event.occurredAt)) return [];
    const deal = deals.get(event.entityId);
    if (!deal) return [];
    const metadata = eventMetadata(event.metadata);
    const before = position(event.fromStatus, metadata?.fromOutcome, deal.source);
    const after = position(event.toStatus, metadata?.toOutcome, deal.source);
    return before && after ? [{ dealId: deal._id, at: event.occurredAt, before, after }] : [];
  });
  return groupBy(changes.sort((a, b) => a.at - b.at), (row) => row.dealId);
}

export function dealAt(crm, deal, at) {
  if (!Number.isFinite(deal.createdAt) || deal.createdAt > at) return undefined;
  const history = crm.history.get(deal._id) ?? [];
  const next = history.findIndex((change) => change.at > at);
  if (next >= 0) return { ...history[next].before, fromHistory: true };
  if (history.length > 0) return { ...history.at(-1).after, fromHistory: true };

  const closedAt = deal.outcome === "won" ? deal.paymentReceivedAt : deal.lostAt;
  if (deal.outcome !== "open" && (at < closedAt || (closedAt === undefined && at < deal.updatedAt))) {
    // A later closure shows the deal could have been open. Its old stage is unknown.
    return closedAt === undefined ? { stage: "unknown", outcome: "unknown" }
      : { stage: "unknown", outcome: "open" };
  }
  const current = position(deal.stage ?? deal.status, deal.outcome, deal.source);
  if (!current) return { stage: "unknown", outcome: "unknown" };
  if (current.outcome === "open" && deal.firstBookedAt > at) {
    return { stage: "qualified", outcome: "open" };
  }
  return current;
}

function tenantScope(tables, account, sandbox) {
  const environment = sandbox ? "sandbox" : "live";
  const connections = (tables.tenantPaymentConnections ?? []).filter((row) =>
    row.provider === "whop" && row.accountId === account && row.environment === environment);
  if (connections.length > 1) throw new Error("The CRM export has more than one Whop connection for this account and environment.");
  const [connection] = connections;
  if (connection) return { tenant: connection.tenantId, connection };
  const tenants = new Set(REQUIRED_TABLES.flatMap((table) => tables[table].map((row) => row.tenantId)));
  if (tenants.size > 1) {
    throw new Error("The CRM export contains multiple tenants. Supply a single-tenant extract or include the matching Whop connection table.");
  }
  return { tenant: tenants.values().next().value };
}

export function buildCrm(tables, { account, sandbox = false }) {
  const { tenant, connection } = tenantScope(tables, account, sandbox);
  const rows = (table) => (tables[table] ?? []).filter((row) => row.tenantId === tenant);
  const connectionRows = (table) => connection
    ? rows(table).filter((row) => row.connectionId === connection._id)
    : [];

  const leads = indexById(rows("leads"));
  const survivor = mergeResolver(leads, rows("leadMergeHistory"));
  const deals = indexById(rows("opportunities"));
  const allRecords = rows("paymentRecords");
  const recordsByDeal = groupBy(allRecords, (row) => row.opportunityId);
  const meetings = indexById(rows("meetings"));
  const history = indexDealHistory(rows("domainEvents"), deals);
  const identifiers = rows("leadIdentifiers");
  const providerPayments = connectionRows("providerPayments");
  return {
    survivor, connection, deals, meetings, history, recordsByDeal, allRecords,
    hasHistory: tables.domainEvents !== undefined,
    hasProviderContext: Boolean(connection && Array.isArray(tables.paymentProviderBindings) &&
      Array.isArray(tables.providerPayments) && Array.isArray(tables.tenantPrograms)),
    records: indexById(allRecords),
    programs: indexById(rows("tenantPrograms")),
    canonicalEmails: groupBy([...leads.values()], (lead) => usableEmail(lead.email)),
    leadAliases: groupBy([...leads.values()], (lead) => survivor(lead._id)),
    identifiersByLead: groupBy(identifiers, (identifier) => identifier.leadId),
    identifiers: groupBy(identifiers, (identifier) => {
      const value = identifier.type === "email" ? usableEmail(identifier.value)
        : identifier.type === "phone" ? usablePhone(identifier.value) : undefined;
      return value && `${identifier.type}:${value}`;
    }),
    currentDealsByPerson: groupBy([...deals.values()], (deal) => deal.leadId),
    historicalDealsByPerson: groupBy([...deals.values()], (deal) => survivor(deal.leadId)),
    meetingsByPerson: groupBy(
      [...meetings.values()].filter((row) => row.status === "held" && Number.isFinite(row.scheduledAt))
        .sort((a, b) => b.scheduledAt - a.scheduledAt),
      (row) => survivor(deals.get(row.opportunityId)?.leadId),
    ),
    providerPayments,
    providerById: indexById(providerPayments),
    providerByExternal: groupBy(providerPayments, (row) => row.externalPaymentId),
    bindings: groupBy(connectionRows("paymentProviderBindings").sort((a, b) =>
      (b._creationTime ?? b.version) - (a._creationTime ?? a.version)),
    (row) => `${row.kind}:${row.externalId}`),
  };
}

export function crmRecordPerson(crm, record) {
  const meeting = crm.meetings.get(record.meetingId);
  const opportunityId = record.opportunityId ?? meeting?.opportunityId;
  return crm.survivor(crm.deals.get(opportunityId)?.leadId);
}
