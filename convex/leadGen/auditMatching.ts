import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { normalizeSocialHandle } from "../lib/normalization";
import { log, reportError } from "../lib/observability/log";
import { leadGenAuditMatchSourceValidator } from "./validators";

type MatchOutcome =
  | "matched_new"
  | "matched_existing"
  | "unmatched_invalid_handle"
  | "unmatched_no_prospect"
  | "unmatched_ambiguous_prospects"
  | "unmatched_multiple_accepted"
  | "unmatched_ambiguous_matches";

/** One line per match attempt. Never log the handle itself. */
function logMatchOutcome(
  outcome: MatchOutcome,
  attrs: {
    tenantId: Id<"tenants">;
    leadId: Id<"leads">;
    matchSource: string;
    [key: string]: unknown;
  },
) {
  const ambiguous =
    outcome === "unmatched_ambiguous_prospects" ||
    outcome === "unmatched_multiple_accepted" ||
    outcome === "unmatched_ambiguous_matches";
  log[ambiguous ? "warn" : "info"]("lead_gen.audit_match", {
    outcome,
    matched: outcome.startsWith("matched"),
    ...attrs,
  });
}

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
  const logAttrs = {
    tenantId: args.tenantId,
    leadId: args.leadId,
    opportunityId: args.opportunityId,
    prospectId: args.prospect._id,
    matchSource: args.matchSource,
  };
  if (acceptedMatches.length > 1) {
    logMatchOutcome("unmatched_multiple_accepted", logAttrs);
    return null;
  }

  const accepted = acceptedMatches[0];
  if (accepted) {
    if (!accepted.opportunityId && args.opportunityId) {
      await ctx.db.patch("leadGenAuditMatches", accepted._id, {
        opportunityId: args.opportunityId,
        updatedAt: args.now,
      });
    }

    if (args.prospect.currentAuditMatchId !== accepted._id) {
      await ctx.db.patch("leadGenProspects", args.prospect._id, {
        currentAuditMatchId: accepted._id,
        updatedAt: args.now,
      });
    }

    logMatchOutcome("matched_existing", { ...logAttrs, matchId: accepted._id });
    return accepted._id;
  }

  if (existingMatches.length > 1) {
    logMatchOutcome("unmatched_ambiguous_matches", logAttrs);
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

  await ctx.db.patch("leadGenProspects", args.prospect._id, {
    currentAuditMatchId: matchId,
    updatedAt: args.now,
  });

  logMatchOutcome("matched_new", { ...logAttrs, matchId });
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
    const logAttrs = {
      tenantId: args.tenantId,
      leadId: args.leadId,
      opportunityId: args.opportunityId,
      matchSource: args.matchSource,
    };
    if (!normalizedHandle) {
      logMatchOutcome("unmatched_invalid_handle", logAttrs);
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
      logMatchOutcome(
        prospects.length > 1
          ? "unmatched_ambiguous_prospects"
          : "unmatched_no_prospect",
        logAttrs,
      );
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
    reportError(
      "lead_gen.data_inconsistency",
      new Error("Lead has multiple accepted lead gen audit matches"),
      {
        severity: "warning",
        fingerprint:
          "lead_gen.data_inconsistency:multiple_accepted_audit_matches",
        reason: "multiple_accepted_audit_matches",
        tenantId: args.tenantId,
        leadId: args.leadId,
        opportunityId: args.opportunityId,
        acceptedMatchCount: acceptedMatches.length,
      },
    );
    return null;
  }

  const match = acceptedMatches[0];
  if (match.opportunityId === args.opportunityId) {
    return match._id;
  }
  if (match.opportunityId !== undefined) {
    return match._id;
  }

  await ctx.db.patch("leadGenAuditMatches", match._id, {
    opportunityId: args.opportunityId,
    updatedAt: args.now,
  });

  return match._id;
}
