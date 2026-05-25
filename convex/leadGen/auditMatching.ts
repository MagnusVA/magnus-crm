import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { normalizeSocialHandle } from "../lib/normalization";
import { leadGenAuditMatchSourceValidator } from "./validators";

async function createOrReuseAcceptedMatch(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    prospect: Doc<"leadGenProspects">;
    leadId: Id<"leads">;
    opportunityId?: Id<"opportunities">;
    normalizedHandle: string;
    matchSource: Doc<"leadGenAuditMatches">["matchSource"];
    now: number;
  },
) {
  const existingMatches = await ctx.db
    .query("leadGenAuditMatches")
    .withIndex("by_tenantId_and_prospectId_and_leadId", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .eq("prospectId", args.prospect._id)
        .eq("leadId", args.leadId),
    )
    .take(2);

  const acceptedMatches = existingMatches.filter(
    (match) => match.matchStatus === "accepted",
  );
  if (acceptedMatches.length > 1) {
    console.warn("[LeadGen:Audit] multiple accepted matches for prospect/lead", {
      tenantId: args.tenantId,
      prospectId: args.prospect._id,
      leadId: args.leadId,
    });
    return null;
  }

  const accepted = acceptedMatches[0];
  if (accepted) {
    if (!accepted.opportunityId && args.opportunityId) {
      await ctx.db.patch(accepted._id, {
        opportunityId: args.opportunityId,
        updatedAt: args.now,
      });
    }

    if (args.prospect.currentAuditMatchId !== accepted._id) {
      await ctx.db.patch(args.prospect._id, {
        currentAuditMatchId: accepted._id,
        updatedAt: args.now,
      });
    }

    return accepted._id;
  }

  if (existingMatches.length > 1) {
    console.warn("[LeadGen:Audit] ambiguous existing matches for prospect/lead", {
      tenantId: args.tenantId,
      prospectId: args.prospect._id,
      leadId: args.leadId,
    });
    return null;
  }

  const matchId = await ctx.db.insert("leadGenAuditMatches", {
    tenantId: args.tenantId,
    prospectId: args.prospect._id,
    leadId: args.leadId,
    opportunityId: args.opportunityId,
    matchSource: args.matchSource,
    matchStatus: "accepted",
    matchedVia: "social_handle",
    normalizedHandle: args.normalizedHandle,
    createdAt: args.now,
    updatedAt: args.now,
  });

  await ctx.db.patch(args.prospect._id, {
    currentAuditMatchId: matchId,
    updatedAt: args.now,
  });

  return matchId;
}

export const matchQualifiedLead = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    leadId: v.id("leads"),
    opportunityId: v.optional(v.id("opportunities")),
    platform: v.literal("instagram"),
    rawHandle: v.string(),
    matchSource: leadGenAuditMatchSourceValidator,
  },
  handler: async (ctx, args) => {
    const normalizedHandle = normalizeSocialHandle(
      args.rawHandle,
      args.platform,
    );
    if (!normalizedHandle) {
      return null;
    }

    const prospects = await ctx.db
      .query("leadGenProspects")
      .withIndex("by_tenantId_and_dedupeKey", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("dedupeKey", `instagram:${normalizedHandle}`),
      )
      .take(2);

    if (prospects.length !== 1) {
      if (prospects.length > 1) {
        console.warn("[LeadGen:Audit] ambiguous prospects for handle", {
          tenantId: args.tenantId,
          normalizedHandle,
        });
      }
      return null;
    }

    return await createOrReuseAcceptedMatch(ctx, {
      tenantId: args.tenantId,
      prospect: prospects[0],
      leadId: args.leadId,
      opportunityId: args.opportunityId,
      normalizedHandle,
      matchSource: args.matchSource,
      now: Date.now(),
    });
  },
});

export async function preserveQualificationAuditMatchForScheduledMeeting(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    leadId: Id<"leads">;
    opportunityId: Id<"opportunities">;
    now: number;
  },
) {
  const matches = await ctx.db
    .query("leadGenAuditMatches")
    .withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", args.tenantId).eq("leadId", args.leadId),
    )
    .take(5);

  const acceptedMatches = matches.filter(
    (match) => match.matchStatus === "accepted",
  );
  if (acceptedMatches.length === 0) {
    return null;
  }
  if (acceptedMatches.length > 1) {
    console.warn("[LeadGen:Audit] multiple accepted matches for lead", {
      tenantId: args.tenantId,
      leadId: args.leadId,
    });
    return null;
  }

  const match = acceptedMatches[0];
  if (match.opportunityId === args.opportunityId) {
    return match._id;
  }
  if (match.opportunityId !== undefined) {
    return match._id;
  }

  await ctx.db.patch(match._id, {
    opportunityId: args.opportunityId,
    updatedAt: args.now,
  });

  return match._id;
}
