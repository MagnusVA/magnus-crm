import { paginationOptsValidator } from "convex/server";
import { v, type Infer } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { log } from "../lib/observability/log";
import { clusterMeetings } from "./clustering";
import { hasPlaceholderKey, keyMeetings, loadLeadEvidence, type LeadEvidence } from "./evidence";
import { identifierKey } from "./identityKeys";
import { leadSplitDiscoveryReasonValidator, leadSplitTierValidator } from "./schema";

// Phase 1 of docs/plans/polluted-lead-split.md (§5.2): find the leads to
// split, from stored data only. Invitee snapshots come later, per plan.

const candidateValidator = v.object({
  leadId: v.id("leads"),
  // A and B get a plan. D holds a placeholder key but one person; alias has
  // several booking emails but one person; bounds is too large to read.
  tier: v.union(
    v.literal("A"),
    v.literal("B"),
    v.literal("D"),
    v.literal("alias"),
    v.literal("bounds"),
  ),
  reasons: v.array(leadSplitDiscoveryReasonValidator),
  clusters: v.number(),
  meetings: v.number(),
  opportunities: v.number(),
  unattributedMeetings: v.number(),
});
export type LeadSplitCandidate = Infer<typeof candidateValidator>;

/** Classifies a lead from its stored keys, or returns undefined to skip it. */
export function classifyLead(evidence: LeadEvidence): LeadSplitCandidate | undefined {
  const placeholder = hasPlaceholderKey(evidence);
  const { clusters, unattributedMeetingIds } = clusterMeetings(keyMeetings(evidence, false));
  const bookingEmails = evidence.identifiers.filter(
    (identifier) =>
      identifier.type === "email" &&
      identifier.source === "calendly_booking" &&
      identifierKey(identifier) !== undefined,
  ).length;
  const reasons: LeadSplitCandidate["reasons"] = [];
  if (placeholder) reasons.push("placeholder_key");
  if (clusters.length > 1) reasons.push("multiple_clusters");
  if (bookingEmails > 1) reasons.push("multiple_booking_emails");
  if (reasons.length === 0 && !evidence.boundsHit) return undefined;

  const tier =
    clusters.length > 1
      ? placeholder
        ? "A"
        : "B"
      : evidence.boundsHit
        ? "bounds"
        : placeholder
          ? "D"
          : "alias";
  return {
    leadId: evidence.lead._id,
    tier,
    reasons,
    clusters: clusters.length,
    meetings: evidence.meetings.length,
    opportunities: evidence.opportunities.length,
    unattributedMeetings: unattributedMeetingIds.length,
  };
}

/** One page of leads, with the ones worth a look classified. Read-only. */
export const listCandidatesPage = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    paginationOpts: paginationOptsValidator,
    excludeLeadIds: v.array(v.id("leads")),
  },
  returns: v.object({
    candidates: v.array(candidateValidator),
    scanned: v.number(),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("leads")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", args.tenantId))
      .paginate(args.paginationOpts);
    const excluded = new Set(args.excludeLeadIds);
    const candidates: LeadSplitCandidate[] = [];
    for (const lead of page.page) {
      if (lead.status === "merged" || excluded.has(lead._id)) continue;
      const candidate = classifyLead(await loadLeadEvidence(ctx, lead, { full: false }));
      if (candidate) candidates.push(candidate);
    }
    return {
      candidates,
      scanned: page.page.length,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/** Writes a draft plan per lead. A lead that already has a plan keeps it. */
export const recordCandidates = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    candidates: v.array(
      v.object({
        leadId: v.id("leads"),
        tier: leadSplitTierValidator,
        reasons: v.array(leadSplitDiscoveryReasonValidator),
      }),
    ),
  },
  returns: v.object({ created: v.number(), existing: v.number() }),
  handler: async (ctx, args) => {
    const now = Date.now();
    let created = 0;
    let existing = 0;
    for (const candidate of args.candidates) {
      const lead = await ctx.db.get("leads", candidate.leadId);
      if (!lead || lead.tenantId !== args.tenantId) throw new Error("Lead not found in tenant");
      const plan = await ctx.db
        .query("leadSplitPlans")
        .withIndex("by_tenantId_and_sourceLeadId", (q) =>
          q.eq("tenantId", args.tenantId).eq("sourceLeadId", candidate.leadId),
        )
        .first();
      if (plan) {
        existing += 1;
        continue;
      }
      await ctx.db.insert("leadSplitPlans", {
        tenantId: args.tenantId,
        sourceLeadId: candidate.leadId,
        tier: candidate.tier,
        status: "draft",
        planVersion: 0,
        discoveryReasons: candidate.reasons,
        discoveredAt: now,
        flags: [],
        flagDetails: [],
        placeholderIdentifierIds: [],
        unattributedMeetingIds: [],
        updatedAt: now,
      });
      created += 1;
    }
    return { created, existing };
  },
});

const DEFAULT_PAGE_SIZE = 25;

/**
 * Scans every lead of the tenant and records a draft plan for each Tier A
 * and Tier B lead. Leads in `excludeLeadIds`, such as staff and test leads,
 * are skipped. With `dryRun` it only reports.
 */
export const discover = internalAction({
  args: {
    tenantId: v.id("tenants"),
    dryRun: v.boolean(),
    excludeLeadIds: v.optional(v.array(v.id("leads"))),
    pageSize: v.optional(v.number()),
  },
  returns: v.object({
    dryRun: v.boolean(),
    scanned: v.number(),
    created: v.number(),
    existing: v.number(),
    candidates: v.array(candidateValidator),
  }),
  handler: async (ctx, args) => {
    const candidates: LeadSplitCandidate[] = [];
    let scanned = 0;
    let created = 0;
    let existing = 0;
    let cursor: string | null = null;
    for (;;) {
      const page: {
        candidates: LeadSplitCandidate[];
        scanned: number;
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runQuery(internal.leadSplit.discover.listCandidatesPage, {
        tenantId: args.tenantId,
        excludeLeadIds: args.excludeLeadIds ?? [],
        paginationOpts: { numItems: args.pageSize ?? DEFAULT_PAGE_SIZE, cursor },
      });
      scanned += page.scanned;
      candidates.push(...page.candidates);
      const toPlan = page.candidates.flatMap((candidate) =>
        candidate.tier === "A" || candidate.tier === "B"
          ? [{ leadId: candidate.leadId, tier: candidate.tier, reasons: candidate.reasons }]
          : [],
      );
      if (!args.dryRun && toPlan.length > 0) {
        const result: { created: number; existing: number } = await ctx.runMutation(
          internal.leadSplit.discover.recordCandidates,
          { tenantId: args.tenantId, candidates: toPlan },
        );
        created += result.created;
        existing += result.existing;
      }
      if (page.isDone) break;
      cursor = page.continueCursor;
    }

    const byTier = (tier: LeadSplitCandidate["tier"]) =>
      candidates.filter((candidate) => candidate.tier === tier).length;
    log.info("lead_split.discover.completed", {
      tenantId: args.tenantId,
      dryRun: args.dryRun,
      scanned,
      created,
      existing,
      tierA: byTier("A"),
      tierB: byTier("B"),
      tierD: byTier("D"),
      alias: byTier("alias"),
      bounds: byTier("bounds"),
    });
    return { dryRun: args.dryRun, scanned, created, existing, candidates };
  },
});
