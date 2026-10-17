import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "../_generated/server";
import { rebuildLeadCustomerSearchRow } from "../leadCustomers/projection";
import { buildSocialHandles } from "../leads/merge";
import {
  moveMeetingToOpportunity,
  moveOpportunityToLead,
} from "../leads/repointLeadReferences";
import { buildLeadSearchText } from "../leads/searchTextBuilder";
import { isInternalUtm } from "../lib/attribution/resolveAttribution";
import { emitDomainEvent } from "../lib/domainEvents";
import { leadDisplayString } from "../lib/leadDisplay";
import { correctLeadLifecycle } from "../lib/leadLifecycle";
import { log } from "../lib/observability/log";
import {
  computeLatestActivityAt,
  patchOpportunityLifecycle,
  transitionOpportunity,
  type OpportunityFieldsPatch,
} from "../lib/opportunityActivity";
import { updateOpportunityMeetingRefs } from "../lib/opportunityMeetingRefs";
import { refreshOpportunitySearchForLead } from "../lib/opportunitySearch";
import type { OpportunityStatus } from "../lib/statusTransitions";
import { syncCustomerSnapshot } from "../lib/syncCustomerSnapshot";
import { syncLeadMeetingNames } from "../lib/syncLeadMeetingNames";
import {
  isActiveOpportunityStatus,
  updateTenantStats,
  type TenantStatsDelta,
} from "../lib/tenantStatsHelper";
import { requestOpportunityProjections } from "../operations/meetingStats";
import {
  rebuildQualificationRow,
  rebuildQualificationRowsForOpportunity,
} from "../operations/projections";
import {
  insertLeadAggregate,
  insertOpportunityAggregate,
  replaceMeetingAggregate,
} from "../reporting/writeHooks";
import {
  AUDIT_STEP,
  recordDelete,
  recordInsert,
  recordPatch,
  type AuditScope,
} from "./audit";
import { emailKey, identifierKey, phoneKey, socialKey } from "./identityKeys";
import { leadSplitPlanStatusValidator, type LeadSplitOpportunityPlan } from "./schema";

// Phase 5 of docs/plans/polluted-lead-split.md (§5.6). Each function handles
// one person or one plan in one transaction, and the migrations in
// convex/migrations.ts run them in order:
//
// 1. `extractPerson` (applyLeadSplitExtractions): the person's target lead,
//    and a new opportunity for each deal they leave that someone else keeps.
// 2. `movePerson` (applyLeadSplitPersons): identifiers, whole deals, kept
//    deals and Slack events move to the target lead, which is refreshed.
// 3. `finalizePlan` (finalizeLeadSplitPlans): the source lead's own fields.
//
// A split deal moves to its keeper's lead only once every other person has
// taken their meetings out, so all of a plan's extractions run first.

const PERSON_LIMIT = 1000;
const ROW_LIMIT = 200;
const AUDIT_ROW_LIMIT = 5000;

// Written onto the lead by Slack qualification or the DM portal (O5).
const SLACK_AND_PORTAL_FIELDS = [
  "country",
  "leadType",
  "initialSource",
  "selfReportedIncome",
] as const;

// What a deal's outcome carries when it moves to a new opportunity (O1).
const OUTCOME_FIELDS = [
  "cancellationReason",
  "canceledBy",
  "canceledAt",
  "noShowAt",
  "lostReason",
  "lostAt",
  "lostByUserId",
  "paymentReceivedAt",
  "soldProgramId",
  "soldProgramName",
] as const;

export type ApplyOutcome = { applied: boolean; reason?: string };

const skipped = (reason: string): ApplyOutcome => ({ applied: false, reason });

export async function readPlanPersons(ctx: MutationCtx, planId: Id<"leadSplitPlans">) {
  return await ctx.db
    .query("leadSplitPersons")
    .withIndex("by_planId_and_personKey", (q) => q.eq("planId", planId))
    .take(PERSON_LIMIT);
}

async function getLead(ctx: MutationCtx, tenantId: Id<"tenants">, leadId: Id<"leads">) {
  const lead = await ctx.db.get("leads", leadId);
  if (!lead || lead.tenantId !== tenantId) throw new Error(`Lead ${leadId} not found`);
  return lead;
}

async function getMeetings(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  meetingIds: Id<"meetings">[],
): Promise<Doc<"meetings">[]> {
  const meetings: Doc<"meetings">[] = [];
  for (const meetingId of meetingIds) {
    const meeting = await ctx.db.get("meetings", meetingId);
    if (!meeting || meeting.tenantId !== tenantId) {
      throw new Error(`Meeting ${meetingId} not found. Rebuild the plan.`);
    }
    meetings.push(meeting);
  }
  // Booking order, as the planner sorts them.
  return meetings.sort(
    (a, b) =>
      a.scheduledAt - b.scheduledAt ||
      a.createdAt - b.createdAt ||
      (a._id < b._id ? -1 : a._id > b._id ? 1 : 0),
  );
}

/**
 * The deal as the plan was built: its status hasn't moved, and its meetings
 * are the ones the plan expects. A new booking since the build stops apply.
 */
async function checkOpportunity(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  entry: LeadSplitOpportunityPlan,
  expected: { leadId: Id<"leads">; meetingIds: Id<"meetings">[] },
): Promise<Doc<"opportunities">> {
  const opportunity = await ctx.db.get("opportunities", entry.opportunityId);
  if (!opportunity || opportunity.tenantId !== tenantId) {
    throw new Error(`Opportunity ${entry.opportunityId} not found`);
  }
  if (opportunity.status !== entry.statusAtBuild) {
    throw new Error(
      `Opportunity ${opportunity._id} is ${opportunity.status}, not ${entry.statusAtBuild} as built. Rebuild the plan.`,
    );
  }
  if (opportunity.leadId !== expected.leadId) {
    throw new Error(`Opportunity ${opportunity._id} is on lead ${opportunity.leadId}, not ${expected.leadId}`);
  }
  const meetings = await ctx.db
    .query("meetings")
    .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunity._id))
    .take(ROW_LIMIT);
  const want = new Set(expected.meetingIds);
  if (meetings.length !== want.size || meetings.some((meeting) => !want.has(meeting._id))) {
    throw new Error(
      `Opportunity ${opportunity._id} has ${meetings.length} meetings, not the ${want.size} the plan expects. Rebuild the plan.`,
    );
  }
  return opportunity;
}

/** O3: the first-booking caches, from the deal's first external booking. */
function firstBookingFields(meeting: Doc<"meetings"> | undefined) {
  return {
    firstMeetingId: meeting?._id,
    firstMeetingAt: meeting?.scheduledAt,
    // The pipeline stores the booked time here too.
    firstBookedAt: meeting?.scheduledAt,
    utmParams: meeting?.utmParams,
    firstBookingProgramId: meeting?.bookingProgramId,
    firstBookingProgramName: meeting?.bookingProgramName,
    firstBookingProgramMappingStatus: meeting?.bookingProgramMappingStatus,
    attributionTeamId: meeting?.attributionTeamId,
    dmCloserId: meeting?.dmCloserId,
    attributionResolution: meeting?.attributionResolution,
    attributionResolvedAt: meeting?.attributionResolvedAt,
    attributionResolutionVersion: meeting?.attributionResolutionVersion,
  };
}

// The pipeline skips internal (ptdom) bookings when it fills the caches.
const firstExternal = (meetings: Doc<"meetings">[]) =>
  meetings.find((meeting) => !isInternalUtm(meeting.utmParams));

/** O2: the status fields a person's own latest meeting gives. */
function ownStatusFields(status: OpportunityStatus, latest: Doc<"meetings">): OpportunityFieldsPatch {
  if (status === "canceled") return { canceledAt: latest.canceledAt ?? latest.scheduledAt, noShowAt: undefined };
  if (status === "no_show") return { noShowAt: latest.noShowMarkedAt ?? latest.scheduledAt };
  return {};
}

function statsDelta(status: OpportunityStatus): TenantStatsDelta {
  return {
    totalOpportunities: 1,
    activeOpportunities: isActiveOpportunityStatus(status) ? 1 : 0,
    wonDeals: status === "payment_received" ? 1 : 0,
    lostDeals: status === "lost" ? 1 : 0,
  };
}

/** O5: the custom fields come from one meeting's form answers. */
async function customFieldsFrom(ctx: MutationCtx, meetingId: Id<"meetings"> | undefined) {
  if (!meetingId) return { customFields: undefined, customFieldLabels: undefined };
  const responses = await ctx.db
    .query("meetingFormResponses")
    .withIndex("by_meetingId", (q) => q.eq("meetingId", meetingId))
    .take(ROW_LIMIT);
  if (responses.length === 0) return { customFields: undefined, customFieldLabels: undefined };
  return {
    customFields: Object.fromEntries(responses.map((response) => [response.fieldKey, response.answerText])),
    customFieldLabels: Object.fromEntries(
      responses.map((response) => [response.fieldKey, response.questionLabelSnapshot]),
    ),
  };
}

/** O5: a person is first seen at their first booking or Slack qualification. */
async function firstSeenAt(
  ctx: MutationCtx,
  person: Doc<"leadSplitPersons">,
  meetings: Doc<"meetings">[],
  fallback: number,
) {
  const times = meetings.map((meeting) => meeting.createdAt);
  for (const eventId of person.slackEventIds) {
    const event = await ctx.db.get("slackQualificationEvents", eventId);
    if (event) times.push(event.submittedAt);
  }
  return times.length > 0 ? Math.min(...times) : fallback;
}

// The lead's copies of its identifiers must see all of them.
async function readLeadIdentifiers(ctx: MutationCtx, leadId: Id<"leads">) {
  const identifiers = await ctx.db
    .query("leadIdentifiers")
    .withIndex("by_leadId", (q) => q.eq("leadId", leadId))
    .take(ROW_LIMIT + 1);
  if (identifiers.length > ROW_LIMIT) throw new Error(`Lead ${leadId} has more than ${ROW_LIMIT} identifiers`);
  return identifiers;
}

async function lockLead(ctx: MutationCtx, scope: AuditScope, lead: Doc<"leads">) {
  if (lead.splitLockedAt !== undefined) return;
  await recordPatch(ctx, scope, AUDIT_STEP.lock, "leads", lead, { splitLockedAt: scope.now });
  await ctx.db.patch("leads", lead._id, { splitLockedAt: scope.now });
}

/** Whether this plan's own audit log holds the lock on the lead. */
async function lockedByPlan(ctx: MutationCtx, planId: Id<"leadSplitPlans">, leadId: Id<"leads">) {
  const rows = await ctx.db
    .query("leadSplitAudit")
    .withIndex("by_planId_and_revertedAt", (q) => q.eq("planId", planId).eq("revertedAt", undefined))
    .take(AUDIT_ROW_LIMIT);
  return rows.some((row) => row.step === AUDIT_STEP.lock && row.docId === leadId);
}

async function unlockLead(ctx: MutationCtx, scope: AuditScope, leadId: Id<"leads">) {
  const lead = await ctx.db.get("leads", leadId);
  if (!lead || lead.splitLockedAt === undefined) return;
  await recordPatch(ctx, scope, AUDIT_STEP.finalize, "leads", lead, { splitLockedAt: undefined });
  await ctx.db.patch("leads", lead._id, { splitLockedAt: undefined });
}

/** Step 1 for `role: "new"`: the person's own lead, with their O5 fields. */
async function createLead(
  ctx: MutationCtx,
  scope: AuditScope,
  plan: Doc<"leadSplitPlans">,
  source: Doc<"leads">,
  person: Doc<"leadSplitPersons">,
): Promise<Id<"leads">> {
  const identifiers: Doc<"leadIdentifiers">[] = [];
  for (const identifierId of person.identifierIds) {
    const identifier = await ctx.db.get("leadIdentifiers", identifierId);
    if (identifier) identifiers.push(identifier);
  }
  const meetings = await getMeetings(ctx, plan.tenantId, person.meetingIds);
  const { email, fullName, phone } = person.canonical;
  const socialHandles = buildSocialHandles(identifiers);
  const slackFields =
    plan.slackFieldsPersonKey === person.personKey
      ? Object.fromEntries(SLACK_AND_PORTAL_FIELDS.map((field) => [field, source[field]]))
      : {};
  const leadId = await ctx.db.insert("leads", {
    tenantId: plan.tenantId,
    email,
    fullName,
    phone,
    ...(await customFieldsFrom(ctx, person.canonical.customFieldsMeetingId)),
    ...slackFields,
    firstSeenAt: await firstSeenAt(ctx, person, meetings, source.firstSeenAt),
    updatedAt: scope.now,
    status: "active",
    socialHandles,
    searchText: buildLeadSearchText(
      { fullName, email, phone, socialHandles },
      identifiers.map((identifier) => identifier.value),
    ),
    splitLockedAt: scope.now,
  });
  await recordInsert(ctx, scope, AUDIT_STEP.lead, "leads", leadId, { totalLeads: 1 });
  await insertLeadAggregate(ctx, leadId);
  // `totalLeads` counts active leads.
  await updateTenantStats(ctx, plan.tenantId, { totalLeads: 1 });
  await emitDomainEvent(ctx, {
    tenantId: plan.tenantId,
    entityType: "lead",
    entityId: leadId,
    eventType: "lead.created",
    source: "system",
    toStatus: "active",
    metadata: { splitFromLeadId: source._id, planId: plan._id },
    occurredAt: scope.now,
  });
  await rebuildLeadCustomerSearchRow(ctx, plan.tenantId, leadId);
  return leadId;
}

/**
 * Step 4 for a person who doesn't keep the document: a new opportunity on
 * their target lead, and their meetings moved onto it (O2, O3, O4).
 */
async function extractOpportunity(
  ctx: MutationCtx,
  scope: AuditScope,
  args: {
    source: Doc<"leads">;
    target: Doc<"leads">;
    person: Doc<"leadSplitPersons">;
    entry: LeadSplitOpportunityPlan;
    planId: Id<"leadSplitPlans">;
  },
): Promise<Id<"opportunities">> {
  const { source, target, person, entry } = args;
  const document = await ctx.db.get("opportunities", entry.opportunityId);
  if (!document || document.tenantId !== scope.tenantId || document.leadId !== source._id) {
    throw new Error(`Opportunity ${entry.opportunityId} is no longer on lead ${source._id}`);
  }
  if (document.status !== entry.statusAtBuild) {
    throw new Error(
      `Opportunity ${document._id} is ${document.status}, not ${entry.statusAtBuild} as built. Rebuild the plan.`,
    );
  }
  const meetings = await getMeetings(ctx, scope.tenantId, entry.meetingIds);
  if (meetings.length === 0 || meetings.some((meeting) => meeting.opportunityId !== document._id)) {
    throw new Error(`Opportunity ${document._id} no longer holds the planned meetings. Rebuild the plan.`);
  }
  const first = meetings[0];
  const latest = meetings[meetings.length - 1];
  const status = entry.status;
  const outcome = entry.inheritsOutcome
    ? Object.fromEntries(OUTCOME_FIELDS.map((field) => [field, document[field]]))
    : ownStatusFields(status, latest);
  const sameCloser = document.assignedCloserId === latest.assignedCloserId;
  const fields = {
    tenantId: scope.tenantId,
    leadId: target._id,
    assignedCloserId: latest.assignedCloserId,
    hostCalendlyUserUri: sameCloser ? document.hostCalendlyUserUri : undefined,
    hostCalendlyEmail: sameCloser ? document.hostCalendlyEmail : undefined,
    hostCalendlyName: sameCloser ? document.hostCalendlyName : undefined,
    eventTypeConfigId: document.eventTypeConfigId,
    status,
    source: "calendly" as const,
    calendlyEventUri: latest.calendlyEventUri,
    ...outcome,
    ...firstBookingFields(firstExternal(meetings)),
    createdAt: first.createdAt,
    updatedAt: scope.now,
  };
  const opportunityId = await ctx.db.insert("opportunities", {
    ...fields,
    latestActivityAt: computeLatestActivityAt(fields),
  });
  const delta = statsDelta(status);
  await recordInsert(ctx, scope, AUDIT_STEP.split(document._id), "opportunities", opportunityId, delta);
  await insertOpportunityAggregate(ctx, opportunityId);
  await updateTenantStats(ctx, scope.tenantId, delta);
  await emitDomainEvent(ctx, {
    tenantId: scope.tenantId,
    entityType: "opportunity",
    entityId: opportunityId,
    eventType: "opportunity.created",
    source: "system",
    toStatus: status,
    metadata: { leadId: target._id, splitFromOpportunityId: document._id, planId: args.planId },
    occurredAt: scope.now,
  });

  const own = new Set(person.meetingIds);
  const leadName = leadDisplayString(target);
  for (const [index, meeting] of meetings.entries()) {
    const fields = {
      callClassification: index === 0 ? ("new" as const) : ("follow_up" as const),
      ...(meeting.rescheduledFromMeetingId && !own.has(meeting.rescheduledFromMeetingId)
        ? { rescheduledFromMeetingId: undefined }
        : {}),
    };
    await recordPatch(ctx, scope, AUDIT_STEP.split(document._id), "meetings", meeting, {
      opportunityId,
      leadName,
      ...fields,
    });
    await moveMeetingToOpportunity(ctx, {
      tenantId: scope.tenantId,
      meetingId: meeting._id,
      toOpportunityId: opportunityId,
      leadName,
      fields,
    });
  }
  await updateOpportunityMeetingRefs(ctx, opportunityId);
  await updateOpportunityMeetingRefs(ctx, document._id);
  await requestOpportunityProjections(ctx, opportunityId);
  await rebuildQualificationRowsForOpportunity(ctx, opportunityId);
  await rebuildQualificationRowsForOpportunity(ctx, document._id);
  return opportunityId;
}

/**
 * Pass 1 for one person: lock the leads, create the target lead if the
 * person needs one, and take their meetings out of deals someone else keeps.
 */
export async function extractPerson(
  ctx: MutationCtx,
  personId: Id<"leadSplitPersons">,
): Promise<ApplyOutcome> {
  const person = await ctx.db.get("leadSplitPersons", personId);
  if (!person) return skipped("person_missing");
  const plan = await ctx.db.get("leadSplitPlans", person.planId);
  if (!plan || (plan.status !== "approved" && plan.status !== "applying")) {
    return skipped("plan_not_approved");
  }
  if (person.planVersion !== plan.planVersion) {
    throw new Error(`Person ${person._id} is from plan version ${person.planVersion}, not ${plan.planVersion}`);
  }
  if (person.status !== "pending" || person.extractedAt !== undefined) return skipped("already_extracted");

  const now = Date.now();
  const scope: AuditScope = { tenantId: plan.tenantId, planId: plan._id, personKey: person.personKey, now };
  if (plan.status === "approved") {
    await ctx.db.patch("leadSplitPlans", plan._id, { status: "applying", updatedAt: now });
  }
  const source = await getLead(ctx, plan.tenantId, plan.sourceLeadId);
  if (source.splitLockedAt !== undefined && !(await lockedByPlan(ctx, plan._id, source._id))) {
    throw new Error(`Lead ${source._id} is locked by another split. Apply that plan first.`);
  }
  await lockLead(ctx, scope, source);

  let targetLeadId: Id<"leads">;
  if (person.role === "original") {
    targetLeadId = source._id;
  } else if (person.role === "merge_into") {
    if (!person.targetLeadId) throw new Error(`Person ${person._id} has no merge target`);
    const target = await getLead(ctx, plan.tenantId, person.targetLeadId);
    if (target.status === "merged") {
      throw new Error(`Merge target ${target._id} was merged since the build. Rebuild the plan.`);
    }
    if (target.splitLockedAt !== undefined && !(await lockedByPlan(ctx, plan._id, target._id))) {
      // Another plan's finalize would unlock it, and its rollback would
      // restore fields over this plan's writes.
      throw new Error(`Merge target ${target._id} is locked by another split. Apply that plan first.`);
    }
    await lockLead(ctx, scope, target);
    targetLeadId = target._id;
  } else {
    targetLeadId = await createLead(ctx, scope, plan, source, person);
  }
  const target = await getLead(ctx, plan.tenantId, targetLeadId);

  const opportunityPlan: LeadSplitOpportunityPlan[] = [];
  for (const entry of person.opportunityPlan) {
    if (entry.kind !== "split_new") {
      opportunityPlan.push(entry);
      continue;
    }
    const newOpportunityId = await extractOpportunity(ctx, scope, {
      source,
      target,
      person,
      entry,
      planId: plan._id,
    });
    opportunityPlan.push({ ...entry, newOpportunityId });
  }
  await ctx.db.patch("leadSplitPersons", person._id, {
    extractedAt: now,
    opportunityPlan,
    ...(person.role === "new" ? { targetLeadId } : {}),
  });
  log.info("lead_split.apply.extracted", {
    tenantId: plan.tenantId,
    planId: plan._id,
    personKey: person.personKey,
    role: person.role,
    targetLeadId,
    opportunitiesCreated: opportunityPlan.filter((entry) => entry.newOpportunityId).length,
  });
  return { applied: true };
}

/** O4 for the meetings that stay on a deal. */
async function normalizeMeetings(
  ctx: MutationCtx,
  scope: AuditScope,
  meetings: Doc<"meetings">[],
  own: Set<Id<"meetings">>,
  classify: boolean,
) {
  for (const [index, meeting] of meetings.entries()) {
    const patch: Partial<Doc<"meetings">> = {};
    const classification = index === 0 ? "new" : "follow_up";
    if (classify && meeting.callClassification !== classification) patch.callClassification = classification;
    if (meeting.rescheduledFromMeetingId && !own.has(meeting.rescheduledFromMeetingId)) {
      patch.rescheduledFromMeetingId = undefined;
    }
    if (Object.keys(patch).length === 0) continue;
    await recordPatch(ctx, scope, AUDIT_STEP.meeting, "meetings", meeting, patch);
    await ctx.db.patch("meetings", meeting._id, patch);
    await replaceMeetingAggregate(ctx, meeting, meeting._id);
  }
}

/**
 * The document a person keeps, once the others' meetings are out: its
 * status becomes the keeper's (through the `lead_split` exception), and its
 * first-booking caches and `createdAt` come from the keeper's first meeting.
 */
async function finishKeptDocument(
  ctx: MutationCtx,
  scope: AuditScope,
  document: Doc<"opportunities">,
  entry: LeadSplitOpportunityPlan,
  own: Set<Id<"meetings">>,
  planId: Id<"leadSplitPlans">,
) {
  const meetings = await getMeetings(ctx, scope.tenantId, entry.meetingIds);
  await normalizeMeetings(ctx, scope, meetings, own, true);

  if (entry.status !== document.status) {
    const fields = ownStatusFields(entry.status, meetings[meetings.length - 1]);
    await recordPatch(ctx, scope, AUDIT_STEP.keep(document._id), "opportunities", document, {
      status: entry.status,
      ...fields,
    });
    await transitionOpportunity(ctx, document._id, {
      to: entry.status,
      fields,
      source: "system",
      exception: "lead_split",
      reason: "lead_split",
      metadata: { planId },
      occurredAt: scope.now,
    });
  }

  const current = (await ctx.db.get("opportunities", document._id))!;
  const caches: OpportunityFieldsPatch = {
    ...firstBookingFields(firstExternal(meetings)),
    createdAt: meetings[0].createdAt,
  };
  const patch = Object.fromEntries(
    Object.entries(caches).filter(
      ([field, value]) =>
        JSON.stringify(value) !== JSON.stringify(current[field as keyof Doc<"opportunities">]),
    ),
  ) as OpportunityFieldsPatch;
  if (Object.keys(patch).length > 0) {
    await recordPatch(ctx, scope, AUDIT_STEP.keep(document._id), "opportunities", current, patch);
    // Re-keys the status aggregate when `createdAt` moves.
    await patchOpportunityLifecycle(ctx, document._id, patch);
  }
  await updateOpportunityMeetingRefs(ctx, document._id);
}

/**
 * O7: a Slack event goes with the person its handle names, on that person's
 * part of the deal it named, or else on their deal open at the time.
 */
async function remapSlackEvent(
  ctx: MutationCtx,
  scope: AuditScope,
  person: Doc<"leadSplitPersons">,
  eventId: Id<"slackQualificationEvents">,
  targetLeadId: Id<"leads">,
) {
  const event = await ctx.db.get("slackQualificationEvents", eventId);
  if (!event || event.tenantId !== scope.tenantId) return;

  let opportunityId = event.opportunityId;
  if (opportunityId) {
    const entry = person.opportunityPlan.find((candidate) => candidate.opportunityId === opportunityId);
    if (entry) {
      opportunityId = entry.kind === "split_new" ? entry.newOpportunityId : entry.opportunityId;
    } else {
      const resulting: Doc<"opportunities">[] = [];
      for (const candidate of person.opportunityPlan) {
        const id = candidate.kind === "split_new" ? candidate.newOpportunityId : candidate.opportunityId;
        const opportunity = id ? await ctx.db.get("opportunities", id) : null;
        if (opportunity) resulting.push(opportunity);
      }
      resulting.sort((a, b) => a.createdAt - b.createdAt);
      opportunityId =
        (
          resulting.find((opportunity) => opportunity.createdAt >= event.submittedAt) ??
          resulting[resulting.length - 1]
        )?._id ?? opportunityId;
    }
  }
  if (event.leadId !== targetLeadId || event.opportunityId !== opportunityId) {
    await recordPatch(ctx, scope, AUDIT_STEP.slackEvent, "slackQualificationEvents", event, {
      leadId: targetLeadId,
      opportunityId,
    });
    await ctx.db.patch("slackQualificationEvents", event._id, { leadId: targetLeadId, opportunityId });
  }
  await rebuildQualificationRow(ctx, event._id);
}

/**
 * Patches a lead's fields, and recomputes what it copies from its
 * identifiers: `socialHandles` and `searchText`.
 */
async function updateLeadFields(
  ctx: MutationCtx,
  scope: AuditScope,
  leadId: Id<"leads">,
  patch: Partial<Doc<"leads">> = {},
) {
  const lead = await getLead(ctx, scope.tenantId, leadId);
  const identifiers = await readLeadIdentifiers(ctx, leadId);
  const socialHandles = buildSocialHandles(identifiers);
  const searchText = buildLeadSearchText(
    { ...lead, ...patch, socialHandles },
    identifiers.map((identifier) => identifier.value),
  );
  const changed = Object.fromEntries(
    Object.entries({ ...patch, socialHandles, searchText }).filter(
      ([field, value]) => JSON.stringify(value) !== JSON.stringify(lead[field as keyof Doc<"leads">]),
    ),
  );
  if (Object.keys(changed).length > 0) {
    await recordPatch(ctx, scope, AUDIT_STEP.refresh, "leads", lead, { ...changed, updatedAt: scope.now });
    await ctx.db.patch("leads", leadId, { ...changed, updatedAt: scope.now });
  }
  return { lead: await getLead(ctx, scope.tenantId, leadId), identifiers };
}

/** Step 6: the lead's fields, then every row that copies them. */
async function refreshLead(
  ctx: MutationCtx,
  scope: AuditScope,
  leadId: Id<"leads">,
  patch: Partial<Doc<"leads">> = {},
) {
  const { lead, identifiers } = await updateLeadFields(ctx, scope, leadId, patch);
  // Also rebuilds the lead/customer search row.
  await refreshOpportunitySearchForLead(ctx, scope.tenantId, leadId);
  await syncLeadMeetingNames(ctx, scope.tenantId, leadId, leadDisplayString(lead, identifiers));
  await syncCustomerSnapshot(ctx, scope.tenantId, leadId);
  await correctLeadLifecycle(ctx, leadId, "lead_split");
}

/**
 * An identifier a person holds although another person's booking sourced
 * it: a shared email stays with its owner (§5.4). Its source becomes the
 * holder's own latest meeting whose invitee used the value, or is cleared,
 * so that every identifier's source meeting is on the identifier's lead.
 */
async function resourceIdentifiers(
  ctx: MutationCtx,
  scope: AuditScope,
  person: Doc<"leadSplitPersons">,
  leadId: Id<"leads">,
): Promise<number> {
  const own = new Set(person.meetingIds);
  let resourced = 0;
  for (const identifierId of person.identifierIds) {
    const identifier = await ctx.db.get("leadIdentifiers", identifierId);
    // Skip one that has since left the person's lead, such as in a later split.
    if (!identifier?.sourceMeetingId || identifier.leadId !== leadId || own.has(identifier.sourceMeetingId)) continue;
    const key = identifierKey(identifier);
    let sourceMeetingId: Id<"meetings"> | undefined;
    // In booking order, so the last match is the latest meeting.
    for (const meetingId of person.meetingIds) {
      const snapshot = await ctx.db
        .query("leadSplitInviteeSnapshots")
        .withIndex("by_meetingId", (q) => q.eq("meetingId", meetingId))
        .first();
      if (!key || snapshot?.outcome !== "ok") continue;
      const keys = [
        emailKey(snapshot.email),
        phoneKey(snapshot.phone),
        snapshot.social ? socialKey(snapshot.social.platform, snapshot.social.handle) : undefined,
      ];
      if (keys.includes(key)) sourceMeetingId = meetingId;
    }
    await recordPatch(ctx, scope, AUDIT_STEP.identifier, "leadIdentifiers", identifier, { sourceMeetingId });
    await ctx.db.patch("leadIdentifiers", identifier._id, { sourceMeetingId });
    resourced += 1;
  }
  return resourced;
}

/**
 * The split's own writes set `updatedAt` (and so `latestActivityAt`) on every
 * deal it creates or moves. That is bookkeeping, not activity: it sends split
 * deals to the top of activity-sorted lists, and makes the pipeline hold any
 * earlier booking for those people as historical. This puts back each deal's
 * time from before the split, or, for a deal the split created, the latest
 * time on its own record. A deal changed since the split is left alone.
 */
async function restoreActivityTimes(
  ctx: MutationCtx,
  plan: Doc<"leadSplitPlans">,
  now: number,
): Promise<number> {
  const rows = await ctx.db
    .query("leadSplitAudit")
    .withIndex("by_planId_and_revertedAt", (q) => q.eq("planId", plan._id).eq("revertedAt", undefined))
    .take(AUDIT_ROW_LIMIT + 1);
  if (rows.length > AUDIT_ROW_LIMIT) throw new Error(`Plan ${plan._id} has more than ${AUDIT_ROW_LIMIT} audit rows`);
  const byOpportunity = new Map<Id<"opportunities">, Doc<"leadSplitAudit">[]>();
  for (const row of rows) {
    if (row.table !== "opportunities" || row.step.startsWith("activity:")) continue;
    const id = row.docId as Id<"opportunities">;
    byOpportunity.set(id, [...(byOpportunity.get(id) ?? []), row]);
  }
  let restored = 0;
  for (const [opportunityId, opportunityRows] of byOpportunity) {
    const opportunity = await ctx.db.get("opportunities", opportunityId);
    if (!opportunity) continue;
    // Only a deal whose last write is still the split's.
    const splitTimes = new Set(opportunityRows.map((row) => row.createdAt));
    if (!splitTimes.has(opportunity.updatedAt)) continue;
    const firstPatch = opportunityRows.find((row) => row.op === "patch");
    const updatedAt = firstPatch
      ? (firstPatch.before as { updatedAt: number }).updatedAt
      : Math.max(
          opportunity.createdAt,
          opportunity.canceledAt ?? 0,
          opportunity.noShowAt ?? 0,
          opportunity.lostAt ?? 0,
          opportunity.paymentReceivedAt ?? 0,
        );
    if (updatedAt === opportunity.updatedAt) continue;
    const scope: AuditScope = {
      tenantId: plan.tenantId,
      planId: plan._id,
      personKey: opportunityRows[0].personKey,
      now,
    };
    await recordPatch(ctx, scope, `activity:${opportunityId}`, "opportunities", opportunity, { updatedAt });
    // Recomputes latestActivityAt and the rows that copy it.
    await patchOpportunityLifecycle(ctx, opportunityId, { updatedAt });
    restored += 1;
  }
  return restored;
}

/**
 * Restores the activity times of an applied plan's deals
 * (`restoreActivityTimes`), for plans finalized before finalize did it.
 * Recorded in the audit log, so rollback undoes it with the rest.
 */
export const restoreAppliedActivityTimes = internalMutation({
  args: { planId: v.id("leadSplitPlans") },
  returns: v.object({ planId: v.id("leadSplitPlans"), restored: v.number() }),
  handler: async (ctx, { planId }) => {
    const plan = await ctx.db.get("leadSplitPlans", planId);
    if (!plan || plan.status !== "applied") throw new Error("Only an applied plan's activity times can be restored");
    const restored = await restoreActivityTimes(ctx, plan, Date.now());
    log.info("lead_split.apply.activity_restored", { tenantId: plan.tenantId, planId, restored });
    return { planId, restored };
  },
});

/**
 * Re-sources the shared identifiers of a plan applied before apply did it
 * (`resourceIdentifiers`). Recorded in the plan's audit log, so rollback
 * undoes it with the rest.
 */
export const resourceAppliedIdentifiers = internalMutation({
  args: { planId: v.id("leadSplitPlans") },
  returns: v.object({ planId: v.id("leadSplitPlans"), resourced: v.number() }),
  handler: async (ctx, { planId }) => {
    const plan = await ctx.db.get("leadSplitPlans", planId);
    if (!plan || plan.status !== "applied") throw new Error("Only an applied plan can be re-sourced");
    const now = Date.now();
    let resourced = 0;
    for (const person of await readPlanPersons(ctx, planId)) {
      const leadId = person.role === "original" ? plan.sourceLeadId : person.targetLeadId;
      if (!leadId) continue;
      resourced += await resourceIdentifiers(
        ctx,
        { tenantId: plan.tenantId, planId, personKey: person.personKey, now },
        person,
        leadId,
      );
    }
    log.info("lead_split.apply.identifiers_resourced", { tenantId: plan.tenantId, planId, resourced });
    return { planId, resourced };
  },
});

/**
 * A lead gen match moving onto a lead that already has a match for the same
 * prospect is merged into it and deleted (`repointAuditMatch`), which
 * rollback can't undo. No current plan has one, so apply stops instead.
 */
async function checkAuditMatches(
  ctx: Pick<QueryCtx, "db">,
  tenantId: Id<"tenants">,
  opportunityId: Id<"opportunities">,
  targetLeadId: Id<"leads">,
): Promise<Id<"leadGenAuditMatches"> | undefined> {
  const matches = await ctx.db
    .query("leadGenAuditMatches")
    .withIndex("by_tenantId_and_opportunityId", (q) =>
      q.eq("tenantId", tenantId).eq("opportunityId", opportunityId),
    )
    .take(ROW_LIMIT);
  for (const match of matches) {
    const onTarget = await ctx.db
      .query("leadGenAuditMatches")
      .withIndex("by_tenantId_and_prospectId_and_leadId", (q) =>
        q.eq("tenantId", tenantId).eq("prospectId", match.prospectId).eq("leadId", targetLeadId),
      )
      .first();
    if (onTarget) return match._id;
  }
  return undefined;
}

async function requireNoAuditMatchConflict(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  opportunityId: Id<"opportunities">,
  targetLeadId: Id<"leads">,
) {
  const conflict = await checkAuditMatches(ctx, tenantId, opportunityId, targetLeadId);
  if (conflict) {
    throw new Error(`Lead gen match ${conflict} would merge into lead ${targetLeadId}'s own. Resolve it first.`);
  }
}

/**
 * Pass 2 for one person: their identifiers, whole deals and kept deals move
 * to the target lead, their Slack events follow, and the target is refreshed.
 */
export async function movePerson(
  ctx: MutationCtx,
  personId: Id<"leadSplitPersons">,
): Promise<ApplyOutcome> {
  const person = await ctx.db.get("leadSplitPersons", personId);
  if (!person) return skipped("person_missing");
  const plan = await ctx.db.get("leadSplitPlans", person.planId);
  if (!plan || plan.status !== "applying") return skipped("plan_not_applying");
  if (person.status !== "pending") return skipped("already_applied");
  const persons = await readPlanPersons(ctx, plan._id);
  if (persons.some((candidate) => candidate.status === "pending" && candidate.extractedAt === undefined)) {
    throw new Error(`Plan ${plan._id} has persons not yet extracted. Run applyLeadSplitExtractions first.`);
  }

  const now = Date.now();
  const scope: AuditScope = { tenantId: plan.tenantId, planId: plan._id, personKey: person.personKey, now };
  const sourceLeadId = plan.sourceLeadId;
  const targetLeadId = person.role === "original" ? sourceLeadId : person.targetLeadId;
  if (!targetLeadId) throw new Error(`Person ${person._id} has no target lead`);
  const own = new Set(person.meetingIds);
  const moves = person.role !== "original";

  let identifiersMoved = 0;
  if (moves) {
    for (const identifierId of person.identifierIds) {
      const identifier = await ctx.db.get("leadIdentifiers", identifierId);
      if (!identifier || identifier.leadId === targetLeadId) continue;
      if (identifier.leadId !== sourceLeadId) {
        throw new Error(`Identifier ${identifierId} is on lead ${identifier.leadId}, not the source`);
      }
      const sameValue = await ctx.db
        .query("leadIdentifiers")
        .withIndex("by_tenantId_and_type_and_value", (q) =>
          q.eq("tenantId", plan.tenantId).eq("type", identifier.type).eq("value", identifier.value),
        )
        .take(ROW_LIMIT);
      if (sameValue.some((other) => other.leadId === targetLeadId)) {
        await recordDelete(ctx, scope, AUDIT_STEP.identifier, "leadIdentifiers", identifier);
        await ctx.db.delete("leadIdentifiers", identifier._id);
      } else {
        await recordPatch(ctx, scope, AUDIT_STEP.identifier, "leadIdentifiers", identifier, {
          leadId: targetLeadId,
        });
        await ctx.db.patch("leadIdentifiers", identifier._id, { leadId: targetLeadId });
      }
      identifiersMoved += 1;
    }
  }

  const identifiersResourced = await resourceIdentifiers(ctx, scope, person, targetLeadId);

  // A merge target takes the Slack and portal fields it lacks, as a merge does.
  let carryOver: Partial<Doc<"leads">> = {};
  if (person.role === "merge_into" && plan.slackFieldsPersonKey === person.personKey) {
    const [source, target] = [
      await getLead(ctx, plan.tenantId, sourceLeadId),
      await getLead(ctx, plan.tenantId, targetLeadId),
    ];
    carryOver = Object.fromEntries(
      SLACK_AND_PORTAL_FIELDS.filter(
        (field) => target[field] === undefined && source[field] !== undefined,
      ).map((field) => [field, source[field]]),
    );
  }
  const { lead: target, identifiers } = await updateLeadFields(ctx, scope, targetLeadId, carryOver);
  const leadName = leadDisplayString(target, identifiers);

  let opportunitiesMoved = 0;
  for (const entry of person.opportunityPlan) {
    if (entry.kind === "split_new") continue;
    const document = await checkOpportunity(ctx, plan.tenantId, entry, {
      leadId: sourceLeadId,
      meetingIds: entry.meetingIds,
    });
    if (entry.kind === "keep_document") {
      await finishKeptDocument(ctx, scope, document, entry, own, plan._id);
    } else {
      await normalizeMeetings(ctx, scope, await getMeetings(ctx, plan.tenantId, entry.meetingIds), own, false);
    }
    if (!moves) continue;
    await requireNoAuditMatchConflict(ctx, plan.tenantId, document._id, targetLeadId);
    const current = (await ctx.db.get("opportunities", document._id))!;
    // The move clears a duplicate flag naming the target; rollback restores it.
    await recordPatch(ctx, scope, AUDIT_STEP.move(document._id), "opportunities", current, {
      leadId: targetLeadId,
      updatedAt: now,
      ...(current.potentialDuplicateLeadId === targetLeadId ? { potentialDuplicateLeadId: undefined } : {}),
    });
    const result = await moveOpportunityToLead(ctx, {
      tenantId: plan.tenantId,
      opportunityId: document._id,
      toLeadId: targetLeadId,
      leadName,
      now,
      moveFormResponses: true,
    });
    if (result.boundsHit.length > 0) {
      throw new Error(`Opportunity ${document._id} hit read bounds: ${result.boundsHit.join(", ")}`);
    }
    opportunitiesMoved += 1;
  }

  for (const eventId of person.slackEventIds) {
    await remapSlackEvent(ctx, scope, person, eventId, targetLeadId);
  }
  if (moves) {
    await refreshLead(ctx, scope, targetLeadId);
    await rebuildLeadCustomerSearchRow(ctx, plan.tenantId, sourceLeadId);
  }
  await ctx.db.patch("leadSplitPersons", person._id, { status: "applied" });
  log.info("lead_split.apply.person_applied", {
    tenantId: plan.tenantId,
    planId: plan._id,
    personKey: person.personKey,
    role: person.role,
    targetLeadId,
    identifiersMoved,
    identifiersResourced,
    opportunitiesMoved,
    meetings: person.meetingIds.length,
    slackEvents: person.slackEventIds.length,
  });
  return { applied: true };
}

/**
 * Finalize (F1 to F6) once every person is applied: the placeholder
 * identifiers go, the source lead takes the original person's fields, and
 * the locks come off.
 */
export async function finalizePlan(
  ctx: MutationCtx,
  planId: Id<"leadSplitPlans">,
): Promise<ApplyOutcome> {
  const plan = await ctx.db.get("leadSplitPlans", planId);
  if (!plan || plan.status !== "applying") return skipped("plan_not_applying");
  const persons = await readPlanPersons(ctx, plan._id);
  if (persons.some((person) => person.status === "pending")) return skipped("persons_pending");
  const original = persons.find((person) => person.role === "original");
  if (!original) throw new Error(`Plan ${plan._id} has no original person`);

  const now = Date.now();
  const scope: AuditScope = { tenantId: plan.tenantId, planId: plan._id, personKey: original.personKey, now };
  const source = await getLead(ctx, plan.tenantId, plan.sourceLeadId);

  // F1
  let placeholdersDeleted = 0;
  for (const identifierId of plan.placeholderIdentifierIds) {
    const identifier = await ctx.db.get("leadIdentifiers", identifierId);
    if (!identifier || identifier.leadId !== source._id) continue;
    await recordDelete(ctx, scope, AUDIT_STEP.finalize, "leadIdentifiers", identifier);
    await ctx.db.delete("leadIdentifiers", identifier._id);
    placeholdersDeleted += 1;
  }

  // F2. Another lead with the same canonical email would make every booking
  // with it an identity conflict.
  const { email, fullName, phone } = original.canonical;
  if (email) {
    const sameEmail = await ctx.db
      .query("leads")
      .withIndex("by_tenantId_and_email", (q) => q.eq("tenantId", plan.tenantId).eq("email", email))
      .take(10);
    const other = sameEmail.find((lead) => lead._id !== source._id && lead.status !== "merged");
    if (other) throw new Error(`Lead ${other._id} already has the original person's email`);
  }
  const meetings = await getMeetings(ctx, plan.tenantId, original.meetingIds);
  const slackFieldsMoved =
    plan.slackFieldsPersonKey !== undefined && plan.slackFieldsPersonKey !== original.personKey;
  const patch: Partial<Doc<"leads">> = {
    email,
    fullName: fullName ?? source.fullName,
    phone,
    ...(await customFieldsFrom(ctx, original.canonical.customFieldsMeetingId)),
    firstSeenAt: await firstSeenAt(ctx, original, meetings, source.firstSeenAt),
    ...(slackFieldsMoved
      ? Object.fromEntries(SLACK_AND_PORTAL_FIELDS.map((field) => [field, undefined]))
      : {}),
  };
  // F4
  await refreshLead(ctx, scope, source._id, patch);
  // F5: the qualification rows copy the lead's contact fields.
  const opportunities = await ctx.db
    .query("opportunities")
    .withIndex("by_tenantId_and_leadId", (q) => q.eq("tenantId", plan.tenantId).eq("leadId", source._id))
    .take(ROW_LIMIT);
  for (const opportunity of opportunities) {
    await rebuildQualificationRowsForOpportunity(ctx, opportunity._id);
  }
  const events = await ctx.db
    .query("slackQualificationEvents")
    .withIndex("by_tenantId_and_leadId_and_submittedAt", (q) =>
      q.eq("tenantId", plan.tenantId).eq("leadId", source._id),
    )
    .take(ROW_LIMIT);
  for (const event of events) await rebuildQualificationRow(ctx, event._id);

  // F6
  await unlockLead(ctx, scope, source._id);
  for (const person of persons) {
    if (person.role !== "original" && person.targetLeadId) await unlockLead(ctx, scope, person.targetLeadId);
  }
  const moved = persons.filter((person) => person.role !== "original");
  const opportunitiesCreated = persons
    .flatMap((person) => person.opportunityPlan)
    .filter((entry) => entry.newOpportunityId !== undefined).length;
  const meetingsMoved = moved.reduce((sum, person) => sum + person.meetingIds.length, 0);
  await emitDomainEvent(ctx, {
    tenantId: plan.tenantId,
    entityType: "lead",
    entityId: source._id,
    eventType: "lead.split",
    source: "system",
    metadata: { planId: plan._id, personsMoved: moved.length, opportunitiesCreated, meetingsMoved },
    occurredAt: now,
  });
  const activityRestored = await restoreActivityTimes(ctx, plan, now);
  await ctx.db.patch("leadSplitPlans", plan._id, { status: "applied", updatedAt: now });
  log.info("lead_split.apply.finalized", {
    tenantId: plan.tenantId,
    planId: plan._id,
    sourceLeadId: source._id,
    placeholdersDeleted,
    personsMoved: moved.length,
    opportunitiesCreated,
    meetingsMoved,
    activityRestored,
  });
  return { applied: true };
}

const preflightProblemValidator = v.object({
  code: v.union(
    v.literal("plan_status"),
    v.literal("stale_person"),
    v.literal("opportunity_missing"),
    v.literal("opportunity_moved"),
    v.literal("status_changed"),
    v.literal("meetings_changed"),
    v.literal("payment_on_moving_meeting"),
    v.literal("identifier_moved"),
    v.literal("merge_target_unusable"),
    v.literal("email_taken"),
    v.literal("audit_match_conflict"),
  ),
  personKey: v.optional(v.string()),
  opportunityId: v.optional(v.id("opportunities")),
  meetingId: v.optional(v.id("meetings")),
  leadId: v.optional(v.id("leads")),
});
type PreflightProblem = Infer<typeof preflightProblemValidator>;

/**
 * Read-only: every check apply makes before it writes, against the data as it
 * is now, for a plan that hasn't been applied. Returns IDs only. An empty
 * list means apply would get past its checks.
 */
export const preflight = internalQuery({
  args: { planId: v.id("leadSplitPlans") },
  returns: v.object({
    planId: v.id("leadSplitPlans"),
    status: leadSplitPlanStatusValidator,
    planVersion: v.number(),
    problems: v.array(preflightProblemValidator),
  }),
  handler: async (ctx, { planId }) => {
    const plan = await ctx.db.get("leadSplitPlans", planId);
    if (!plan) throw new Error("Lead split plan not found");
    const problems: PreflightProblem[] = [];
    if (!["draft", "needs_review", "approved"].includes(plan.status)) problems.push({ code: "plan_status" });
    const persons = await ctx.db
      .query("leadSplitPersons")
      .withIndex("by_planId_and_personKey", (q) => q.eq("planId", planId))
      .take(PERSON_LIMIT);

    // Before extraction, a split deal holds every person's meetings on it.
    const expectedMeetings = new Map<Id<"opportunities">, Set<Id<"meetings">>>();
    const moving = new Set<Id<"meetings">>();
    for (const person of persons) {
      if (person.planVersion !== plan.planVersion || person.status !== "pending") {
        problems.push({ code: "stale_person", personKey: person.personKey });
      }
      for (const entry of person.opportunityPlan) {
        const set = expectedMeetings.get(entry.opportunityId) ?? new Set();
        for (const meetingId of entry.meetingIds) set.add(meetingId);
        expectedMeetings.set(entry.opportunityId, set);
        if (entry.kind === "split_new") for (const meetingId of entry.meetingIds) moving.add(meetingId);
      }
    }
    for (const [opportunityId, expected] of expectedMeetings) {
      const opportunity = await ctx.db.get("opportunities", opportunityId);
      if (!opportunity || opportunity.tenantId !== plan.tenantId) {
        problems.push({ code: "opportunity_missing", opportunityId });
        continue;
      }
      if (opportunity.leadId !== plan.sourceLeadId) {
        problems.push({ code: "opportunity_moved", opportunityId, leadId: opportunity.leadId });
      }
      const entries = persons.flatMap((person) =>
        person.opportunityPlan.filter((entry) => entry.opportunityId === opportunityId),
      );
      if (entries.some((entry) => entry.statusAtBuild !== opportunity.status)) {
        problems.push({ code: "status_changed", opportunityId });
      }
      const meetings = await ctx.db
        .query("meetings")
        .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunityId))
        .take(ROW_LIMIT);
      if (meetings.length !== expected.size || meetings.some((meeting) => !expected.has(meeting._id))) {
        problems.push({ code: "meetings_changed", opportunityId });
      }
      const payments = await ctx.db
        .query("paymentRecords")
        .withIndex("by_opportunityId_and_recordedAt", (q) => q.eq("opportunityId", opportunityId))
        .take(ROW_LIMIT + 1);
      // Too many to check means apply would refuse to move this deal's meetings.
      if (payments.length > ROW_LIMIT && entries.some((entry) => entry.kind === "split_new")) {
        problems.push({ code: "payment_on_moving_meeting", opportunityId });
      }
      for (const payment of payments) {
        if (payment.meetingId && moving.has(payment.meetingId)) {
          problems.push({ code: "payment_on_moving_meeting", opportunityId, meetingId: payment.meetingId });
        }
      }
    }

    const otherLeadWithEmail = async (email: string | undefined, allowed: Id<"leads">[]) => {
      if (!email) return undefined;
      const leads = await ctx.db
        .query("leads")
        .withIndex("by_tenantId_and_email", (q) => q.eq("tenantId", plan.tenantId).eq("email", email))
        .take(10);
      return leads.find((lead) => !allowed.includes(lead._id) && lead.status !== "merged");
    };
    for (const person of persons) {
      for (const identifierId of person.identifierIds) {
        const identifier = await ctx.db.get("leadIdentifiers", identifierId);
        if (identifier && identifier.leadId !== plan.sourceLeadId) {
          problems.push({ code: "identifier_moved", personKey: person.personKey, leadId: identifier.leadId });
        }
      }
      if (person.role === "merge_into") {
        const target = person.targetLeadId ? await ctx.db.get("leads", person.targetLeadId) : null;
        if (!target || target.status === "merged" || target.splitLockedAt !== undefined) {
          problems.push({ code: "merge_target_unusable", personKey: person.personKey, leadId: person.targetLeadId });
          continue;
        }
        for (const entry of person.opportunityPlan) {
          if (entry.kind === "split_new") continue;
          if (await checkAuditMatches(ctx, plan.tenantId, entry.opportunityId, target._id)) {
            problems.push({ code: "audit_match_conflict", personKey: person.personKey, opportunityId: entry.opportunityId });
          }
        }
        continue;
      }
      // F2 for the original, and the new lead's email for anyone else.
      const taken = await otherLeadWithEmail(person.canonical.email, [plan.sourceLeadId]);
      if (taken) problems.push({ code: "email_taken", personKey: person.personKey, leadId: taken._id });
    }
    return { planId, status: plan.status, planVersion: plan.planVersion, problems };
  },
});
