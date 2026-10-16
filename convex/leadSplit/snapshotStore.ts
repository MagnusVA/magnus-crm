import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { loadLeadEvidence } from "./evidence";
import { leadSplitSnapshotOutcomeValidator } from "./schema";
import { socialPlatformValidator } from "../lib/socialPlatform";

// Reads and writes for the invitee snapshot action in snapshot.ts.

const mappingsValidator = v.object({
  socialHandleField: v.optional(v.string()),
  socialHandleType: v.optional(
    v.union(
      v.literal("instagram"),
      v.literal("tiktok"),
      v.literal("twitter"),
      v.literal("other_social"),
    ),
  ),
  phoneField: v.optional(v.string()),
});

/** Each meeting of the plan's lead, with its invitee URI and form mapping. */
export const getSnapshotTargets = internalQuery({
  args: { planId: v.id("leadSplitPlans") },
  returns: v.object({
    tenantId: v.id("tenants"),
    targets: v.array(
      v.object({
        meetingId: v.id("meetings"),
        inviteeUri: v.string(),
        mappings: v.optional(mappingsValidator),
        snapshotOutcome: v.optional(leadSplitSnapshotOutcomeValidator),
      }),
    ),
  }),
  handler: async (ctx, { planId }) => {
    const plan = await ctx.db.get("leadSplitPlans", planId);
    if (!plan) throw new Error("Lead split plan not found");
    const lead = await ctx.db.get("leads", plan.sourceLeadId);
    if (!lead || lead.tenantId !== plan.tenantId) throw new Error("Source lead not found");
    const evidence = await loadLeadEvidence(ctx, lead, { full: false });
    const configIds = new Map(
      evidence.opportunities.map((opportunity) => [opportunity._id, opportunity.eventTypeConfigId]),
    );
    const targets = [];
    for (const meeting of evidence.meetings) {
      const snapshot = await ctx.db
        .query("leadSplitInviteeSnapshots")
        .withIndex("by_meetingId", (q) => q.eq("meetingId", meeting._id))
        .unique();
      const configId = configIds.get(meeting.opportunityId);
      targets.push({
        meetingId: meeting._id,
        inviteeUri: meeting.calendlyInviteeUri,
        mappings: configId
          ? evidence.eventTypeConfigs.get(configId)?.customFieldMappings
          : undefined,
        snapshotOutcome: snapshot?.outcome,
      });
    }
    return { tenantId: plan.tenantId, targets };
  },
});

/** Upserts snapshots by meeting. A failed fetch never replaces a good one. */
export const saveInviteeSnapshots = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    snapshots: v.array(
      v.object({
        meetingId: v.id("meetings"),
        inviteeUri: v.string(),
        outcome: leadSplitSnapshotOutcomeValidator,
        httpStatus: v.optional(v.number()),
        email: v.optional(v.string()),
        name: v.optional(v.string()),
        phone: v.optional(v.string()),
        social: v.optional(v.object({ platform: socialPlatformValidator, handle: v.string() })),
        fetchedAt: v.number(),
      }),
    ),
  },
  returns: v.object({ written: v.number(), kept: v.number() }),
  handler: async (ctx, { tenantId, snapshots }) => {
    let written = 0;
    let kept = 0;
    for (const snapshot of snapshots) {
      const meeting = await ctx.db.get("meetings", snapshot.meetingId);
      if (!meeting || meeting.tenantId !== tenantId) throw new Error("Meeting not found in tenant");
      const existing = await ctx.db
        .query("leadSplitInviteeSnapshots")
        .withIndex("by_meetingId", (q) => q.eq("meetingId", snapshot.meetingId))
        .unique();
      if (existing?.outcome === "ok" && snapshot.outcome !== "ok") {
        kept += 1;
        continue;
      }
      if (existing) {
        await ctx.db.replace("leadSplitInviteeSnapshots", existing._id, { tenantId, ...snapshot });
      } else {
        await ctx.db.insert("leadSplitInviteeSnapshots", { tenantId, ...snapshot });
      }
      written += 1;
    }
    return { written, kept };
  },
});
