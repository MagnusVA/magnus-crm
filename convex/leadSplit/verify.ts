import { v, type Infer } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalAction,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { SAME_TRANSACTION_EVENT_LIMIT } from "../lib/domainEventLinks";
import { isRecord } from "../lib/payloadExtraction";
import { parseInvitee } from "./inviteeSnapshot";
import { emailKey, identifierKey, keyToIdentifier, phoneKey, socialKey } from "./identityKeys";

// Verification for docs/plans/polluted-lead-split.md §5.8. The per-person
// assert runs as a migration and throws on the first failure. The
// tenant-wide checks are scans that report failures by ID instead, because
// rows outside the split (Tier D, unreviewed Tier B) fail them until they are
// cleaned up.

type Reader = Pick<QueryCtx, "db">;

const ROW_LIMIT = 200;

/**
 * Throws for a plan still applying, and unless an applied person's meetings, identifiers, form answers and
 * Slack events are on their target lead, and every deal apply rebuilt has
 * one `new` meeting, its earliest.
 */
export async function assertPersonApplied(ctx: MutationCtx, person: Doc<"leadSplitPersons">) {
  const plan = await ctx.db.get("leadSplitPlans", person.planId);
  if (!plan) return;
  const fail = (message: string): never => {
    throw new Error(`Plan ${plan._id}, person ${person.personKey}: ${message}`);
  };
  // A started plan that didn't finish must not pass as clean.
  if (plan.status === "applying" || plan.status === "failed") fail(`plan is ${plan.status}`);
  if (plan.status !== "applied") return;
  const targetLeadId = person.role === "original" ? plan.sourceLeadId : person.targetLeadId;
  if (!targetLeadId) fail("no target lead");
  if (person.status !== "applied") fail(`status is ${person.status}`);

  for (const meetingId of person.meetingIds) {
    const meeting = await ctx.db.get("meetings", meetingId);
    if (!meeting) return fail(`meeting ${meetingId} is missing`);
    const opportunity = await ctx.db.get("opportunities", meeting.opportunityId);
    if (opportunity?.leadId !== targetLeadId) fail(`meeting ${meetingId} is on lead ${opportunity?.leadId}`);
    if (meeting.opportunityStatus !== opportunity?.status) {
      fail(`meeting ${meetingId} mirrors status ${meeting.opportunityStatus}, not ${opportunity?.status}`);
    }
    const responses = await ctx.db
      .query("meetingFormResponses")
      .withIndex("by_meetingId", (q) => q.eq("meetingId", meetingId))
      .take(ROW_LIMIT + 1);
    if (responses.length > ROW_LIMIT) fail(`meeting ${meetingId} has more than ${ROW_LIMIT} form responses`);
    for (const response of responses) {
      if (response.leadId !== targetLeadId || response.opportunityId !== meeting.opportunityId) {
        fail(`form response ${response._id} points elsewhere`);
      }
    }
  }
  for (const identifierId of person.identifierIds) {
    // A duplicate of the target's own identifier was deleted.
    const identifier = await ctx.db.get("leadIdentifiers", identifierId);
    if (identifier && identifier.leadId !== targetLeadId) fail(`identifier ${identifierId} is on lead ${identifier.leadId}`);
  }
  for (const eventId of person.slackEventIds) {
    const event = await ctx.db.get("slackQualificationEvents", eventId);
    if (event && event.leadId !== targetLeadId) fail(`Slack event ${eventId} is on lead ${event.leadId}`);
  }
  // A merge target keeps its own email.
  if (person.role !== "merge_into") {
    const lead = await ctx.db.get("leads", targetLeadId!);
    if (lead?.email !== undefined && lead.email !== person.canonical.email) fail("the lead's email isn't the person's");
  }
  for (const entry of person.opportunityPlan) {
    if (entry.kind === "whole") continue;
    const opportunityId = entry.kind === "split_new" ? entry.newOpportunityId : entry.opportunityId;
    if (!opportunityId) return fail(`no new opportunity for ${entry.opportunityId}`);
    const meetings = await ctx.db
      .query("meetings")
      .withIndex("by_opportunityId_and_scheduledAt", (q) => q.eq("opportunityId", opportunityId))
      .take(ROW_LIMIT);
    const firsts = meetings.filter((meeting) => meeting.callClassification === "new");
    if (firsts.length !== 1 || firsts[0]._id !== meetings[0]?._id) {
      fail(`opportunity ${opportunityId} doesn't have exactly one new meeting, its earliest`);
    }
  }
}

export const tenantCheckValidator = v.union(
  v.literal("identifier_meeting_consistency"),
  v.literal("placeholder_identifiers"),
  v.literal("placeholder_lead_emails"),
  v.literal("form_response_refs"),
  v.literal("follow_up_refs"),
  v.literal("slack_event_refs"),
  v.literal("customer_refs"),
  v.literal("meeting_opportunity_status"),
);
type TenantCheck = Infer<typeof tenantCheckValidator>;
const TENANT_CHECKS: TenantCheck[] = [...tenantCheckValidator.members.map((member) => member.value)];

const failureValidator = v.object({
  docId: v.string(),
  leadId: v.optional(v.id("leads")),
  detail: v.string(),
});
type Failure = Infer<typeof failureValidator>;

function pageOf(ctx: Reader, check: TenantCheck, tenantId: Id<"tenants">) {
  switch (check) {
    case "identifier_meeting_consistency":
    case "placeholder_identifiers":
      return ctx.db
        .query("leadIdentifiers")
        .withIndex("by_tenantId_and_type_and_value", (q) => q.eq("tenantId", tenantId));
    case "placeholder_lead_emails":
      return ctx.db.query("leads").withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId));
    case "form_response_refs":
      return ctx.db
        .query("meetingFormResponses")
        .withIndex("by_tenantId_and_fieldKey", (q) => q.eq("tenantId", tenantId));
    case "follow_up_refs":
      return ctx.db
        .query("followUps")
        .withIndex("by_tenantId_and_leadId_and_createdAt", (q) => q.eq("tenantId", tenantId));
    case "slack_event_refs":
      return ctx.db
        .query("slackQualificationEvents")
        .withIndex("by_tenantId_and_leadId_and_submittedAt", (q) => q.eq("tenantId", tenantId));
    case "customer_refs":
      return ctx.db.query("customers").withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId));
    case "meeting_opportunity_status":
      return ctx.db
        .query("meetings")
        .withIndex("by_tenantId_and_scheduledAt", (q) => q.eq("tenantId", tenantId));
  }
}

/** Reads each row's meeting and opportunity once per page. */
function cachedReader(ctx: Reader) {
  const meetings = new Map<Id<"meetings">, Doc<"meetings"> | null>();
  const opportunities = new Map<Id<"opportunities">, Doc<"opportunities"> | null>();
  return {
    meeting: async (id: Id<"meetings">) => {
      if (!meetings.has(id)) meetings.set(id, await ctx.db.get("meetings", id));
      return meetings.get(id)!;
    },
    opportunity: async (id: Id<"opportunities">) => {
      if (!opportunities.has(id)) opportunities.set(id, await ctx.db.get("opportunities", id));
      return opportunities.get(id)!;
    },
  };
}

async function checkRow(
  reader: ReturnType<typeof cachedReader>,
  check: TenantCheck,
  row: Doc<
    | "leadIdentifiers"
    | "leads"
    | "meetingFormResponses"
    | "followUps"
    | "slackQualificationEvents"
    | "customers"
    | "meetings"
  >,
): Promise<Failure | undefined> {
  switch (check) {
    case "identifier_meeting_consistency": {
      const identifier = row as Doc<"leadIdentifiers">;
      if (!identifier.sourceMeetingId) return;
      const meeting = await reader.meeting(identifier.sourceMeetingId);
      if (!meeting) return;
      const opportunity = await reader.opportunity(meeting.opportunityId);
      if (opportunity && opportunity.leadId !== identifier.leadId) {
        return { docId: identifier._id, leadId: identifier.leadId, detail: `meeting on lead ${opportunity.leadId}` };
      }
      return;
    }
    case "placeholder_identifiers": {
      const identifier = row as Doc<"leadIdentifiers">;
      return identifierKey(identifier) === undefined
        ? { docId: identifier._id, leadId: identifier.leadId, detail: identifier.type }
        : undefined;
    }
    case "placeholder_lead_emails": {
      const lead = row as Doc<"leads">;
      return lead.email !== undefined && lead.status !== "merged" && emailKey(lead.email) === undefined
        ? { docId: lead._id, leadId: lead._id, detail: "placeholder canonical email" }
        : undefined;
    }
    case "form_response_refs": {
      const response = row as Doc<"meetingFormResponses">;
      const meeting = await reader.meeting(response.meetingId);
      if (!meeting) return { docId: response._id, leadId: response.leadId, detail: "missing meeting" };
      const opportunity = await reader.opportunity(meeting.opportunityId);
      if (response.opportunityId !== meeting.opportunityId || response.leadId !== opportunity?.leadId) {
        return { docId: response._id, leadId: response.leadId, detail: `meeting ${meeting._id}` };
      }
      return;
    }
    case "follow_up_refs": {
      const followUp = row as Doc<"followUps">;
      const opportunity = await reader.opportunity(followUp.opportunityId);
      if (!opportunity) return { docId: followUp._id, leadId: followUp.leadId, detail: "missing opportunity" };
      return opportunity.leadId !== followUp.leadId
        ? { docId: followUp._id, leadId: followUp.leadId, detail: `opportunity on lead ${opportunity.leadId}` }
        : undefined;
    }
    case "slack_event_refs": {
      const event = row as Doc<"slackQualificationEvents">;
      if (!event.opportunityId) return;
      const opportunity = await reader.opportunity(event.opportunityId);
      if (!opportunity) return { docId: event._id, leadId: event.leadId, detail: "missing opportunity" };
      return opportunity.leadId !== event.leadId
        ? { docId: event._id, leadId: event.leadId, detail: `opportunity on lead ${opportunity.leadId}` }
        : undefined;
    }
    case "customer_refs": {
      const customer = row as Doc<"customers">;
      const opportunity = await reader.opportunity(customer.winningOpportunityId);
      return opportunity?.leadId !== customer.leadId
        ? { docId: customer._id, leadId: customer.leadId, detail: "winning opportunity on another lead" }
        : undefined;
    }
    case "meeting_opportunity_status": {
      const meeting = row as Doc<"meetings">;
      const opportunity = await reader.opportunity(meeting.opportunityId);
      return opportunity && meeting.opportunityStatus !== opportunity.status
        ? { docId: meeting._id, leadId: opportunity.leadId, detail: `${meeting.opportunityStatus} != ${opportunity.status}` }
        : undefined;
    }
  }
}

/** One page of one tenant-wide check. */
export const checkPage = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    check: tenantCheckValidator,
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  returns: v.object({
    scanned: v.number(),
    failures: v.array(failureValidator),
    continueCursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const page = await pageOf(ctx, args.check, args.tenantId).paginate({
      cursor: args.cursor,
      numItems: args.numItems,
    });
    const reader = cachedReader(ctx);
    const failures: Failure[] = [];
    for (const row of page.page) {
      const failure = await checkRow(reader, args.check, row);
      if (failure) failures.push(failure);
    }
    return {
      scanned: page.page.length,
      failures,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

const SAMPLE_LIMIT = 50;

/**
 * Runs the tenant-wide checks (§5.8) and reports, per check, how many rows
 * failed and the first failures by ID. Rows on leads with an unapplied plan,
 * and Tier D leads, are expected to fail until they are split or cleaned up.
 */
export const verifyTenant = internalAction({
  args: {
    tenantId: v.id("tenants"),
    checks: v.optional(v.array(tenantCheckValidator)),
    pageSize: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      check: tenantCheckValidator,
      scanned: v.number(),
      failed: v.number(),
      sample: v.array(failureValidator),
    }),
  ),
  handler: async (ctx, args) => {
    const results = [];
    for (const check of args.checks ?? TENANT_CHECKS) {
      let cursor: string | null = null;
      let scanned = 0;
      let failed = 0;
      const sample: Failure[] = [];
      for (;;) {
        const page: {
          scanned: number;
          failures: Failure[];
          continueCursor: string;
          isDone: boolean;
        } = await ctx.runQuery(internal.leadSplit.verify.checkPage, {
          tenantId: args.tenantId,
          check,
          cursor,
          numItems: args.pageSize ?? 200,
        });
        scanned += page.scanned;
        failed += page.failures.length;
        sample.push(...page.failures.slice(0, SAMPLE_LIMIT - sample.length));
        if (page.isDone) break;
        cursor = page.continueCursor;
      }
      results.push({ check, scanned, failed, sample });
    }
    return results;
  },
});

async function resolveLead(ctx: Reader, leadId: Id<"leads">) {
  let lead = await ctx.db.get("leads", leadId);
  for (let hops = 0; lead?.status === "merged" && lead.mergedIntoLeadId && hops < 5; hops += 1) {
    lead = await ctx.db.get("leads", lead.mergedIntoLeadId);
  }
  return lead && lead.status !== "merged" ? lead : null;
}

/**
 * The identity probe (§5.8): replays the matching half of
 * `resolveLeadIdentity` for a stored booking, read-only. It returns IDs and
 * booleans, never the booking's contact details.
 */
export const probeDelivery = internalQuery({
  args: { deliveryId: v.id("webhookDeliveries") },
  returns: v.object({
    deliveryId: v.id("webhookDeliveries"),
    status: v.string(),
    reason: v.optional(v.string()),
    payloadAvailable: v.boolean(),
    keys: v.object({ email: v.boolean(), phone: v.boolean(), social: v.boolean() }),
    matches: v.array(v.object({ via: v.string(), leadId: v.id("leads") })),
    leadIds: v.array(v.id("leads")),
    lockedLeadIds: v.array(v.id("leads")),
    leadEmailMatches: v.boolean(),
    resolvesToOneLead: v.boolean(),
    /**
     * Deals on the one matched lead changed after the booking arrived, so the
     * pipeline holds it as historical (inviteeCreated.ts). Approximate: it
     * doesn't apply the stale-expiry exception.
     */
    newerOpportunityIds: v.array(v.id("opportunities")),
    /** The lead has more deals than the pipeline reads, which holds the booking too. */
    tooManyOpportunities: v.boolean(),
  }),
  handler: async (ctx, { deliveryId }) => {
    const delivery = await ctx.db.get("webhookDeliveries", deliveryId);
    if (!delivery) throw new Error("Delivery not found");
    const raw = await ctx.db.get("rawWebhookEvents", delivery.rawEventId);
    let invitee: unknown;
    try {
      const envelope: unknown = raw ? JSON.parse(raw.payload) : undefined;
      invitee = isRecord(envelope) ? envelope.payload : undefined;
    } catch {
      invitee = undefined;
    }
    const parsed = parseInvitee({ resource: invitee }, undefined);
    const keys = {
      email: emailKey(parsed.email),
      phone: phoneKey(parsed.phone),
      social: parsed.social ? socialKey(parsed.social.platform, parsed.social.handle) : undefined,
    };

    const matches: { via: string; leadId: Id<"leads"> }[] = [];
    const leads = new Map<Id<"leads">, Doc<"leads">>();
    const add = async (via: string, leadId: Id<"leads">) => {
      const lead = await resolveLead(ctx, leadId);
      if (!lead || lead.tenantId !== delivery.tenantId) return;
      leads.set(lead._id, lead);
      if (!matches.some((match) => match.via === via && match.leadId === lead._id)) {
        matches.push({ via, leadId: lead._id });
      }
    };
    if (keys.email) {
      const email = keyToIdentifier(keys.email).value;
      const byEmail = await ctx.db
        .query("leads")
        .withIndex("by_tenantId_and_email", (q) => q.eq("tenantId", delivery.tenantId).eq("email", email))
        .take(17);
      for (const lead of byEmail) await add("email", lead._id);
    }
    for (const [via, key] of Object.entries(keys)) {
      if (!key) continue;
      const { type, value } = keyToIdentifier(key);
      const identifiers = await ctx.db
        .query("leadIdentifiers")
        .withIndex("by_tenantId_and_type_and_value", (q) =>
          q.eq("tenantId", delivery.tenantId).eq("type", type).eq("value", value),
        )
        .take(17);
      for (const identifier of identifiers) await add(via, identifier.leadId);
    }

    const leadIds = [...leads.keys()].sort();
    const [only] = leadIds.length === 1 ? [leads.get(leadIds[0])!] : [];
    const leadEmailMatches =
      only !== undefined && keys.email !== undefined && only.email === keyToIdentifier(keys.email).value;
    // The pipeline reads the lead's newest 129 deals, and holds a booking
    // whose lead has more as booking_history_requires_review.
    const candidates = only
      ? await ctx.db
          .query("opportunities")
          .withIndex("by_tenantId_and_leadId", (q) => q.eq("tenantId", delivery.tenantId).eq("leadId", only._id))
          .order("desc")
          .take(129)
      : [];
    const newerOpportunityIds = candidates
      .filter((opportunity) => opportunity.updatedAt > delivery.occurredAt)
      .map((opportunity) => opportunity._id);
    return {
      deliveryId,
      newerOpportunityIds,
      tooManyOpportunities: candidates.length > 128,
      status: delivery.status,
      reason: delivery.reason,
      payloadAvailable: invitee !== undefined,
      keys: { email: !!keys.email, phone: !!keys.phone, social: !!keys.social },
      matches,
      leadIds,
      lockedLeadIds: [...leads.values()].filter((lead) => lead.splitLockedAt !== undefined).map((lead) => lead._id),
      leadEmailMatches,
      resolvesToOneLead: leadIds.length === 1 && only?.splitLockedAt === undefined,
    };
  },
});

/**
 * Phase 1 (docs/plans/phase-1-foundations.md §9.3): checks the person on the
 * deal events a split took apart against this audit, which Deploy 3 drops.
 * For each meeting the split moved, each event on its old deal written with
 * one of its meeting events must name the meeting's new person.
 */
export const verifySplitEventLinks = internalQuery({
  args: {},
  handler: async (ctx) => {
    // Fail closed: a truncated scan must never report zero mismatches.
    const bounded = <T>(rows: T[], limit: number, what: string): T[] => {
      if (rows.length > limit) throw new Error(`verifySplitEventLinks read more than ${limit} ${what}`);
      return rows;
    };
    const rows = bounded(await ctx.db.query("leadSplitAudit").take(5001), 5000, "audit rows");
    const mismatches: string[] = [];
    let checked = 0;
    for (const row of rows) {
      if (row.revertedAt || row.table !== "meetings" || row.op !== "patch") continue;
      const after = isRecord(row.after) ? row.after : undefined;
      const before = isRecord(row.before) ? row.before : undefined;
      const fromOpportunityId = typeof before?.opportunityId === "string" ? before.opportunityId : undefined;
      const toOpportunityId = typeof after?.opportunityId === "string" ? after.opportunityId : undefined;
      if (!fromOpportunityId || !toOpportunityId || fromOpportunityId === toOpportunityId) continue;
      const toOpportunity = await ctx.db.get("opportunities", toOpportunityId as Id<"opportunities">);
      const meetingEvents = bounded(
        await ctx.db
          .query("domainEvents")
          .withIndex("by_entityId", (q) => q.eq("entityId", row.docId))
          .take(101),
        100,
        `events for meeting ${row.docId}`,
      );
      for (const meetingEvent of meetingEvents) {
        if (meetingEvent.occurredAt >= row.createdAt) continue;
        const dealEvents = bounded(
          await ctx.db
            .query("domainEvents")
            .withIndex("by_tenantId_and_occurredAt", (q) =>
              q.eq("tenantId", row.tenantId).eq("occurredAt", meetingEvent.occurredAt),
            )
            .take(SAME_TRANSACTION_EVENT_LIMIT + 1),
          SAME_TRANSACTION_EVENT_LIMIT,
          `events at ${meetingEvent.occurredAt}`,
        );
        for (const dealEvent of dealEvents) {
          if (dealEvent.entityId !== fromOpportunityId || dealEvent.eventType === "opportunity.created") continue;
          checked += 1;
          if (dealEvent.leadId !== toOpportunity?.leadId) mismatches.push(dealEvent._id);
        }
      }
    }
    return { checked, mismatches: mismatches.slice(0, 200), mismatchCount: mismatches.length };
  },
});
