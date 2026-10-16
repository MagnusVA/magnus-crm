import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type QueryCtx } from "../_generated/server";
import { log } from "../lib/observability/log";
import { opportunityStatusValidator } from "../opportunities/validators";
import { loadLeadEvidence, keyMeetings } from "./evidence";
import { keyToIdentifier, type IdentityKey } from "./identityKeys";
import { planLeadSplit, type LeadSplitPlanResult, type PlannedPerson } from "./planner";
import {
  leadSplitCanonicalValidator,
  leadSplitDiscoveryReasonValidator,
  leadSplitFlagDetailValidator,
  leadSplitFlagValidator,
  leadSplitOverridesValidator,
  leadSplitPersonRoleValidator,
  leadSplitPlanStatusValidator,
  leadSplitTierValidator,
  type LeadSplitFlag,
} from "./schema";

// Phase 3 and 4 of docs/plans/polluted-lead-split.md: build each plan into
// persons, review it, and approve one exact version.

/** Flags that stop approval: the plan can't be applied as built. */
export const BLOCKING_FLAGS: ReadonlySet<LeadSplitFlag> = new Set<LeadSplitFlag>([
  "bounds_exceeded",
  "customer_review",
  "merge_target_ambiguous",
  "merge_target_in_plan",
  "outcome_review",
  "stale_override",
  "winning_opportunity_mismatch",
]);

const REBUILDABLE: ReadonlySet<Doc<"leadSplitPlans">["status"]> = new Set([
  "draft",
  "needs_review",
  "approved",
  "dismissed",
  "rolled_back",
] as const);
const MATCH_LIMIT = 17;
const MERGE_CHAIN_LIMIT = 5;
// The largest plan has 53 persons.
const PERSON_LIMIT = 1000;

type Reader = Pick<QueryCtx, "db">;

const meetingStatusValidator = v.union(
  v.literal("scheduled"),
  v.literal("completed"),
  v.literal("canceled"),
  v.literal("no_show"),
);

async function getPlan(ctx: Reader, planId: Id<"leadSplitPlans">) {
  const plan = await ctx.db.get("leadSplitPlans", planId);
  if (!plan) throw new Error("Lead split plan not found");
  return plan;
}

async function readPersons(ctx: Reader, planId: Id<"leadSplitPlans">) {
  return await ctx.db
    .query("leadSplitPersons")
    .withIndex("by_planId_and_personKey", (q) => q.eq("planId", planId))
    .take(PERSON_LIMIT);
}

async function resolveMergedLead(ctx: Reader, leadId: Id<"leads">) {
  let lead = await ctx.db.get("leads", leadId);
  for (let depth = 0; lead?.status === "merged" && depth < MERGE_CHAIN_LIMIT; depth += 1) {
    lead = lead.mergedIntoLeadId ? await ctx.db.get("leads", lead.mergedIntoLeadId) : null;
  }
  return lead && lead.status !== "merged" ? lead : null;
}

// A plan in one of these states may still move people on or off its lead.
const LIVE_PLAN_STATUSES: ReadonlySet<Doc<"leadSplitPlans">["status"]> = new Set([
  "draft",
  "needs_review",
  "approved",
  "applying",
] as const);

/**
 * Rule 3: the other leads a person's keys already resolve to, through
 * identifiers and canonical emails, and which of them have a live split plan
 * of their own or are locked by one.
 */
async function lookupMergeTargets(
  ctx: Reader,
  plan: Doc<"leadSplitPlans">,
  keys: IdentityKey[],
): Promise<{ leadIds: Id<"leads">[]; inPlanLeadIds: Id<"leads">[] }> {
  const matched = new Set<Id<"leads">>();
  for (const key of keys) {
    const { type, value } = keyToIdentifier(key);
    const identifiers = await ctx.db
      .query("leadIdentifiers")
      .withIndex("by_tenantId_and_type_and_value", (q) =>
        q.eq("tenantId", plan.tenantId).eq("type", type).eq("value", value),
      )
      .take(MATCH_LIMIT);
    for (const identifier of identifiers) matched.add(identifier.leadId);
    if (type === "email") {
      const leads = await ctx.db
        .query("leads")
        .withIndex("by_tenantId_and_email", (q) =>
          q.eq("tenantId", plan.tenantId).eq("email", value),
        )
        .take(MATCH_LIMIT);
      for (const lead of leads) matched.add(lead._id);
    }
  }
  matched.delete(plan.sourceLeadId);

  const resolved = new Set<Id<"leads">>();
  const inPlan = new Set<Id<"leads">>();
  for (const leadId of matched) {
    const lead = await resolveMergedLead(ctx, leadId);
    if (!lead || lead._id === plan.sourceLeadId || lead.tenantId !== plan.tenantId) continue;
    resolved.add(lead._id);
    const otherPlan = await ctx.db
      .query("leadSplitPlans")
      .withIndex("by_tenantId_and_sourceLeadId", (q) =>
        q.eq("tenantId", plan.tenantId).eq("sourceLeadId", lead._id),
      )
      .first();
    if ((otherPlan && LIVE_PLAN_STATUSES.has(otherPlan.status)) || lead.splitLockedAt !== undefined) {
      inPlan.add(lead._id);
    }
  }
  return { leadIds: [...resolved].sort(), inPlanLeadIds: [...inPlan].sort() };
}

type PersonShape = Pick<
  PlannedPerson,
  "role" | "meetingIds" | "identifierIds" | "slackEventIds" | "opportunityPlan" | "canonical"
>;

/** IDs and counts only, for review and the plan doc (§5.5). */
function totalsOf(
  persons: PersonShape[],
  placeholderIdentifierIds: Id<"leadIdentifiers">[],
) {
  const moved = persons.filter((person) => person.role !== "original");
  const entries = persons.flatMap((person) => person.opportunityPlan);
  return {
    persons: persons.length,
    newLeads: persons.filter((person) => person.role === "new").length,
    mergeIns: persons.filter((person) => person.role === "merge_into").length,
    opportunitiesMovedWhole: moved
      .flatMap((person) => person.opportunityPlan)
      .filter((entry) => entry.kind === "whole").length,
    splitOpportunities: entries.filter((entry) => entry.kind === "keep_document").length,
    newOpportunities: entries.filter((entry) => entry.kind === "split_new").length,
    keptDocumentStatusChanges: entries.filter(
      (entry) => entry.kind === "keep_document" && entry.status !== entry.statusAtBuild,
    ).length,
    meetingsChangingOpportunity: entries
      .filter((entry) => entry.kind === "split_new")
      .reduce((sum, entry) => sum + entry.meetingIds.length, 0),
    meetingsChangingLead: moved.reduce((sum, person) => sum + person.meetingIds.length, 0),
    identifiersMoved: moved.reduce((sum, person) => sum + person.identifierIds.length, 0),
    placeholderIdentifiers: placeholderIdentifierIds.length,
    slackEventsReassigned: moved.reduce((sum, person) => sum + person.slackEventIds.length, 0),
    movedWithoutEmail: moved.filter((person) => person.canonical.email === undefined).length,
  };
}

function nextStatus(result: LeadSplitPlanResult): Doc<"leadSplitPlans">["status"] {
  if (result.persons.length < 2) return "dismissed";
  return result.tier === "B" || result.flags.length > 0 ? "needs_review" : "draft";
}

const totalsValidator = v.object({
  persons: v.number(),
  newLeads: v.number(),
  mergeIns: v.number(),
  opportunitiesMovedWhole: v.number(),
  splitOpportunities: v.number(),
  newOpportunities: v.number(),
  keptDocumentStatusChanges: v.number(),
  meetingsChangingOpportunity: v.number(),
  meetingsChangingLead: v.number(),
  identifiersMoved: v.number(),
  placeholderIdentifiers: v.number(),
  slackEventsReassigned: v.number(),
  movedWithoutEmail: v.number(),
});

/**
 * Phase 3 (§5.4). Builds the plan's persons from the lead's current data and
 * the invitee snapshots, and replaces the previous build. `overrides`, when
 * given, replace the stored reviewer decisions. A rebuild bumps
 * `planVersion` and clears any approval. With `dryRun` it writes nothing and
 * returns what the build would be.
 */
export const buildPlan = internalMutation({
  args: {
    planId: v.id("leadSplitPlans"),
    dryRun: v.boolean(),
    overrides: v.optional(leadSplitOverridesValidator),
  },
  returns: v.object({
    planId: v.id("leadSplitPlans"),
    dryRun: v.boolean(),
    planVersion: v.number(),
    status: leadSplitPlanStatusValidator,
    tier: leadSplitTierValidator,
    flags: v.array(leadSplitFlagValidator),
    blockingFlags: v.array(leadSplitFlagValidator),
    totals: totalsValidator,
  }),
  handler: async (ctx, args) => {
    const plan = await getPlan(ctx, args.planId);
    if (!REBUILDABLE.has(plan.status)) {
      throw new Error(`A ${plan.status} plan can't be rebuilt`);
    }
    const lead = await ctx.db.get("leads", plan.sourceLeadId);
    if (!lead || lead.tenantId !== plan.tenantId) throw new Error("Source lead not found");

    const overrides = args.overrides ?? plan.overrides;
    const evidence = await loadLeadEvidence(ctx, lead, { full: true });
    const result = await planLeadSplit(evidence, {
      overrides,
      lookupMergeTargets: (keys) => lookupMergeTargets(ctx, plan, keys),
    });
    const status = nextStatus(result);
    const planVersion = args.dryRun ? plan.planVersion : plan.planVersion + 1;
    const totals = totalsOf(result.persons, result.placeholderIdentifierIds);
    const summary = {
      planId: plan._id,
      dryRun: args.dryRun,
      planVersion,
      status,
      tier: result.tier,
      flags: result.flags,
      blockingFlags: result.flags.filter((flag) => BLOCKING_FLAGS.has(flag)),
      totals,
    };
    log.info("lead_split.plan.built", {
      tenantId: plan.tenantId,
      sourceLeadId: plan.sourceLeadId,
      ...summary,
      ...totals,
    });
    if (args.dryRun) return summary;

    for (const person of await readPersons(ctx, plan._id)) {
      await ctx.db.delete("leadSplitPersons", person._id);
    }
    for (const person of result.persons) {
      await ctx.db.insert("leadSplitPersons", {
        tenantId: plan.tenantId,
        planId: plan._id,
        planVersion,
        ...person,
        status: "pending",
      });
    }
    const now = Date.now();
    await ctx.db.patch("leadSplitPlans", plan._id, {
      tier: result.tier,
      status,
      planVersion,
      flags: result.flags,
      flagDetails: result.flagDetails,
      placeholderIdentifierIds: result.placeholderIdentifierIds,
      unattributedMeetingIds: result.unattributedMeetingIds,
      slackFieldsPersonKey: result.slackFieldsPersonKey,
      overrides,
      builtAt: now,
      approvedBy: undefined,
      approvedAt: undefined,
      updatedAt: now,
    });
    return summary;
  },
});

/**
 * Phase 4 (§5.5). Approves the version the reviewer saw. A plan with flags
 * needs a named reviewer, and a blocking flag stops approval until a rebuild
 * clears it.
 */
export const approve = internalMutation({
  args: {
    planId: v.id("leadSplitPlans"),
    planVersion: v.number(),
    reviewer: v.string(),
  },
  returns: v.object({ planId: v.id("leadSplitPlans"), planVersion: v.number() }),
  handler: async (ctx, args) => {
    const plan = await getPlan(ctx, args.planId);
    const reviewer = args.reviewer.trim();
    if (!reviewer) throw new Error("Name the reviewer");
    if (plan.status !== "draft" && plan.status !== "needs_review") {
      throw new Error(`A ${plan.status} plan can't be approved`);
    }
    if (plan.planVersion === 0) throw new Error("Build the plan before approving it");
    if (plan.planVersion !== args.planVersion) {
      throw new Error(
        `Plan is at version ${plan.planVersion}, not ${args.planVersion}. Review it again.`,
      );
    }
    const blocking = plan.flags.filter((flag) => BLOCKING_FLAGS.has(flag));
    if (blocking.length > 0) {
      throw new Error(`Plan has blocking flags: ${blocking.join(", ")}`);
    }
    const now = Date.now();
    await ctx.db.patch("leadSplitPlans", plan._id, {
      status: "approved",
      approvedBy: reviewer,
      approvedAt: now,
      updatedAt: now,
    });
    log.info("lead_split.plan.approved", {
      tenantId: plan.tenantId,
      planId: plan._id,
      sourceLeadId: plan.sourceLeadId,
      planVersion: plan.planVersion,
      flags: plan.flags,
    });
    return { planId: plan._id, planVersion: plan.planVersion };
  },
});

/** Phase 4 (§5.5). A plan as IDs and counts, without personal data. */
export const describe = internalQuery({
  args: { planId: v.id("leadSplitPlans") },
  returns: v.object({
    planId: v.id("leadSplitPlans"),
    tenantId: v.id("tenants"),
    sourceLeadId: v.id("leads"),
    tier: leadSplitTierValidator,
    status: leadSplitPlanStatusValidator,
    planVersion: v.number(),
    discoveryReasons: v.array(leadSplitDiscoveryReasonValidator),
    flags: v.array(leadSplitFlagValidator),
    blockingFlags: v.array(leadSplitFlagValidator),
    flagDetails: v.array(leadSplitFlagDetailValidator),
    overrides: v.optional(leadSplitOverridesValidator),
    approvedBy: v.optional(v.string()),
    approvedAt: v.optional(v.number()),
    placeholderIdentifierIds: v.array(v.id("leadIdentifiers")),
    unattributedMeetingIds: v.array(v.id("meetings")),
    slackFieldsPersonKey: v.optional(v.string()),
    totals: totalsValidator,
    persons: v.array(
      v.object({
        personKey: v.string(),
        candidateKeys: v.array(v.string()),
        role: leadSplitPersonRoleValidator,
        targetLeadId: v.optional(v.id("leads")),
        mergeCandidateLeadIds: v.array(v.id("leads")),
        status: v.union(v.literal("pending"), v.literal("applied"), v.literal("skipped")),
        meetingIds: v.array(v.id("meetings")),
        identifiers: v.number(),
        slackEventIds: v.array(v.id("slackQualificationEvents")),
        hasEmail: v.boolean(),
        hasName: v.boolean(),
        hasPhone: v.boolean(),
        opportunities: v.array(
          v.object({
            opportunityId: v.id("opportunities"),
            kind: v.union(v.literal("whole"), v.literal("keep_document"), v.literal("split_new")),
            meetings: v.number(),
            statusAtBuild: opportunityStatusValidator,
            status: opportunityStatusValidator,
            inheritsOutcome: v.boolean(),
          }),
        ),
      }),
    ),
  }),
  handler: async (ctx, { planId }) => {
    const plan = await getPlan(ctx, planId);
    const persons = (await readPersons(ctx, planId)).sort((a, b) =>
      a.role === "original" ? -1 : b.role === "original" ? 1 : a.personKey < b.personKey ? -1 : 1,
    );
    return {
      planId: plan._id,
      tenantId: plan.tenantId,
      sourceLeadId: plan.sourceLeadId,
      tier: plan.tier,
      status: plan.status,
      planVersion: plan.planVersion,
      discoveryReasons: plan.discoveryReasons,
      flags: plan.flags,
      blockingFlags: plan.flags.filter((flag) => BLOCKING_FLAGS.has(flag)),
      flagDetails: plan.flagDetails,
      overrides: plan.overrides,
      approvedBy: plan.approvedBy,
      approvedAt: plan.approvedAt,
      placeholderIdentifierIds: plan.placeholderIdentifierIds,
      unattributedMeetingIds: plan.unattributedMeetingIds,
      slackFieldsPersonKey: plan.slackFieldsPersonKey,
      totals: totalsOf(persons, plan.placeholderIdentifierIds),
      persons: persons.map((person) => ({
        personKey: person.personKey,
        candidateKeys: person.candidateKeys,
        role: person.role,
        targetLeadId: person.targetLeadId,
        mergeCandidateLeadIds: person.mergeCandidateLeadIds,
        status: person.status,
        meetingIds: person.meetingIds,
        identifiers: person.identifierIds.length,
        slackEventIds: person.slackEventIds,
        hasEmail: person.canonical.email !== undefined,
        hasName: person.canonical.fullName !== undefined,
        hasPhone: person.canonical.phone !== undefined,
        opportunities: person.opportunityPlan.map((entry) => ({
          opportunityId: entry.opportunityId,
          kind: entry.kind,
          meetings: entry.meetingIds.length,
          statusAtBuild: entry.statusAtBuild,
          status: entry.status,
          inheritsOutcome: entry.inheritsOutcome,
        })),
      })),
    };
  },
});

/**
 * The review packet: each person's names, emails, phones and handles, and
 * each meeting's invitee. It contains personal data, so write it to a temp
 * directory, delete it after review, and never commit it.
 */
export const reviewPacket = internalQuery({
  args: { planId: v.id("leadSplitPlans") },
  returns: v.object({
    planId: v.id("leadSplitPlans"),
    sourceLeadId: v.id("leads"),
    leadEmail: v.optional(v.string()),
    leadName: v.optional(v.string()),
    persons: v.array(
      v.object({
        personKey: v.string(),
        role: leadSplitPersonRoleValidator,
        targetLeadId: v.optional(v.id("leads")),
        canonical: leadSplitCanonicalValidator,
        meetings: v.array(
          v.object({
            meetingId: v.id("meetings"),
            scheduledAt: v.optional(v.string()),
            status: v.optional(meetingStatusValidator),
            snapshotName: v.optional(v.string()),
            snapshotEmail: v.optional(v.string()),
            keys: v.array(v.string()),
          }),
        ),
      }),
    ),
  }),
  handler: async (ctx, { planId }) => {
    const plan = await getPlan(ctx, planId);
    const lead = await ctx.db.get("leads", plan.sourceLeadId);
    if (!lead || lead.tenantId !== plan.tenantId) throw new Error("Source lead not found");
    const evidence = await loadLeadEvidence(ctx, lead, { full: true });
    const meetings = new Map(keyMeetings(evidence, true).map((meeting) => [meeting.meetingId, meeting]));
    const persons = await readPersons(ctx, planId);
    return {
      planId,
      sourceLeadId: plan.sourceLeadId,
      leadEmail: lead.email,
      leadName: lead.fullName,
      persons: persons.map((person) => ({
        personKey: person.personKey,
        role: person.role,
        targetLeadId: person.targetLeadId,
        canonical: person.canonical,
        meetings: person.meetingIds.map((meetingId) => {
          const meeting = meetings.get(meetingId);
          const snapshot = evidence.snapshots.get(meetingId);
          return {
            meetingId,
            scheduledAt: meeting ? new Date(meeting.scheduledAt).toISOString() : undefined,
            status: meeting?.status,
            snapshotName: snapshot?.name,
            snapshotEmail: snapshot?.email,
            keys: meeting?.keys ?? [],
          };
        }),
      })),
    };
  },
});

/** A tenant's plans, as IDs and counts. */
export const listPlans = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    status: v.optional(leadSplitPlanStatusValidator),
  },
  returns: v.array(
    v.object({
      planId: v.id("leadSplitPlans"),
      sourceLeadId: v.id("leads"),
      tier: leadSplitTierValidator,
      status: leadSplitPlanStatusValidator,
      planVersion: v.number(),
      flags: v.array(leadSplitFlagValidator),
    }),
  ),
  handler: async (ctx, { tenantId, status }) => {
    const plans = status
      ? await ctx.db
          .query("leadSplitPlans")
          .withIndex("by_tenantId_and_status", (q) => q.eq("tenantId", tenantId).eq("status", status))
          .take(500)
      : await ctx.db
          .query("leadSplitPlans")
          .withIndex("by_tenantId_and_sourceLeadId", (q) => q.eq("tenantId", tenantId))
          .take(500);
    return plans.map((plan) => ({
      planId: plan._id,
      sourceLeadId: plan.sourceLeadId,
      tier: plan.tier,
      status: plan.status,
      planVersion: plan.planVersion,
      flags: plan.flags,
    }));
  },
});
