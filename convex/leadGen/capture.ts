import type { Doc, Id } from "../_generated/dataModel";
import { mutation, type MutationCtx } from "../_generated/server";
import type { CrmRole } from "../lib/roleMapping";
import { requireTenantUser } from "../requireTenantUser";
import {
  isRankableLeadGenOrigin,
  normalizeLeadGenOrigin,
  normalizeLeadGenProspectInput,
} from "./normalization";
import { leadGenSubmitArgsValidator } from "./validators";
import {
  updateLeadGenDailyStats,
  updateLeadGenOriginStats,
  updateLeadGenTeamOriginStats,
} from "./aggregates";
import { resolveLeadGenTeamIdForWrite } from "./sharedTeams";

const MAX_CLIENT_SUBMISSION_KEY_LENGTH = 200;
type LeadGenSource = Doc<"leadGenSubmissions">["source"];
type LeadGenOriginKind = Doc<"leadGenSubmissions">["originKind"];

const INSTAGRAM_CAPTURE_ORIGINS = new Set<LeadGenOriginKind>([
  "post",
  "reel",
  "story_poll",
  "story",
  "follower",
  "application",
]);

export const submit = mutation({
  args: leadGenSubmitArgsValidator,
  handler: async (ctx, args) => {
    const access = await requireTenantUser(ctx, [
      "lead_generator",
      "tenant_master",
      "tenant_admin",
    ]);
    const now = Date.now();
    const worker = await requireOperationalLeadGenWorker(ctx, access, now);
    const clientSubmissionKey = normalizeClientSubmissionKey(
      args.clientSubmissionKey,
    );

    if (clientSubmissionKey) {
      const existingSubmission = await ctx.db
        .query("leadGenSubmissions")
        .withIndex("by_tenantId_and_workerId_and_clientSubmissionKey", (q) =>
          q
            .eq("tenantId", access.tenantId)
            .eq("workerId", worker._id)
            .eq("clientSubmissionKey", clientSubmissionKey),
        )
        .unique();

      if (existingSubmission) {
        return {
          submissionId: existingSubmission._id,
          prospectId: existingSubmission.prospectId,
          duplicateRetry: true,
          duplicateProspect: false,
        };
      }
    }

    const normalized = normalizeLeadGenProspectInput({
      source: args.source,
      rawHandleOrProfileUrl: args.rawHandleOrProfileUrl,
    });
    const submittedOrigin = resolveCaptureOrigin(args);
    const origin = normalizeLeadGenOrigin({
      originKind: submittedOrigin.originKind,
      originUrlOrLabel: submittedOrigin.originUrlOrLabel,
    });

    let prospect = await ctx.db
      .query("leadGenProspects")
      .withIndex("by_tenantId_and_dedupeKey", (q) =>
        q
          .eq("tenantId", access.tenantId)
          .eq("dedupeKey", normalized.dedupeKey),
      )
      .unique();

    if (!prospect) {
      const prospectId = await ctx.db.insert("leadGenProspects", {
        tenantId: access.tenantId,
        firstSource: args.source,
        latestSource: args.source,
        dedupeKey: normalized.dedupeKey,
        normalizedHandle: normalized.normalizedHandle,
        rawHandle: args.rawHandleOrProfileUrl.trim(),
        profileUrl: normalized.profileUrl,
        firstCapturedByWorkerId: worker._id,
        firstCapturedAt: now,
        lastSubmittedByWorkerId: worker._id,
        lastSubmittedAt: now,
        latestOriginKind: submittedOrigin.originKind,
        latestOriginValue: origin.originValue,
        contactAttemptCount: 0,
        distinctWorkerCount: 0,
        createdAt: now,
        updatedAt: now,
      });

      prospect = await ctx.db.get(prospectId);
      if (!prospect) {
        throw new Error("Prospect insert failed");
      }
    }

    const priorWorkerSubmission = await ctx.db
      .query("leadGenSubmissions")
      .withIndex("by_tenantId_and_prospectId_and_workerId", (q) =>
        q
          .eq("tenantId", access.tenantId)
          .eq("prospectId", prospect._id)
          .eq("workerId", worker._id),
      )
      .take(1);

    const duplicateProspect = prospect.contactAttemptCount > 0;
    const isDistinctWorker = priorWorkerSubmission.length === 0;
    const originRankable = isRankableLeadGenOrigin(
      submittedOrigin.originKind,
    );

    const submissionId = await ctx.db.insert("leadGenSubmissions", {
      tenantId: access.tenantId,
      prospectId: prospect._id,
      workerId: worker._id,
      userId: access.userId,
      teamId: worker.teamId,
      source: args.source,
      originKind: submittedOrigin.originKind,
      originValue: origin.originValue,
      originRankable,
      clientSubmissionKey,
      submittedAt: now,
      createdAt: now,
    });

    await ctx.db.patch(prospect._id, {
      lastSubmittedByWorkerId: worker._id,
      lastSubmittedAt: now,
      latestOriginKind: submittedOrigin.originKind,
      latestOriginValue: origin.originValue,
      latestSource: args.source,
      contactAttemptCount: prospect.contactAttemptCount + 1,
      distinctWorkerCount:
        prospect.distinctWorkerCount + (isDistinctWorker ? 1 : 0),
      updatedAt: now,
    });

    await updateLeadGenDailyStats(ctx, {
      tenantId: access.tenantId,
      worker,
      source: args.source,
      submittedAt: now,
      duplicateProspectSubmission: duplicateProspect,
      prospectId: prospect._id,
    });

    if (originRankable && origin.originKey && origin.originValue) {
      await updateLeadGenOriginStats(ctx, {
        tenantId: access.tenantId,
        source: args.source,
        originKind: submittedOrigin.originKind,
        originKey: origin.originKey,
        originValue: origin.originValue,
        prospectId: prospect._id,
        submittedAt: now,
      });

      await updateLeadGenTeamOriginStats(ctx, {
        tenantId: access.tenantId,
        teamId: worker.teamId,
        source: args.source,
        originKind: submittedOrigin.originKind,
        originKey: origin.originKey,
        originValue: origin.originValue,
        prospectId: prospect._id,
        submittedAt: now,
      });
    }

    return {
      submissionId,
      prospectId: prospect._id,
      duplicateRetry: false,
      duplicateProspect,
    };
  },
});

function resolveCaptureOrigin(args: {
  source: LeadGenSource;
  originKind: LeadGenOriginKind;
  originUrlOrLabel?: string;
}): {
  originKind: LeadGenOriginKind;
  originUrlOrLabel?: string;
} {
  if (args.source === "meta_business") {
    return {
      originKind: "source_only" as const,
      originUrlOrLabel: undefined,
    };
  }

  if (!INSTAGRAM_CAPTURE_ORIGINS.has(args.originKind)) {
    throw new Error(
      "Choose Post, Reel, Story, Story Poll, Follower, or Application for Instagram source",
    );
  }

  return {
    originKind: args.originKind,
    originUrlOrLabel: args.originUrlOrLabel,
  };
}

async function requireOperationalLeadGenWorker(
  ctx: MutationCtx,
  access: {
    tenantId: Id<"tenants">;
    userId: Id<"users">;
    role: CrmRole;
  },
  now: number,
) {
  const existing = await ctx.db
    .query("leadGenWorkers")
    .withIndex("by_tenantId_and_userId", (q) =>
      q.eq("tenantId", access.tenantId).eq("userId", access.userId),
    )
    .unique();

  if (existing?.isActive) {
    return await normalizeWorkerTeamForWrite(ctx, existing, now);
  }

  if (access.role === "lead_generator") {
    throw new Error("Lead Gen Ops access is not active for this user");
  }

  const user = await ctx.db.get(access.userId);
  if (!user || user.tenantId !== access.tenantId || !user.isActive) {
    throw new Error("Lead Gen Ops access is not active for this user");
  }

  if (existing) {
    await ctx.db.patch(existing._id, {
      workosUserId: user.workosUserId,
      email: user.email,
      displayName: displayNameForUser(user),
      isActive: true,
      updatedAt: now,
    });
    const updated = await ctx.db.get(existing._id);
    if (!updated) {
      throw new Error("Worker profile update failed");
    }
    return await normalizeWorkerTeamForWrite(ctx, updated, now);
  }

  const workerId = await ctx.db.insert("leadGenWorkers", {
    tenantId: access.tenantId,
    userId: user._id,
    workosUserId: user.workosUserId,
    email: user.email,
    displayName: displayNameForUser(user),
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });
  const worker = await ctx.db.get(workerId);
  if (!worker) {
    throw new Error("Worker profile insert failed");
  }
  return worker;
}

async function normalizeWorkerTeamForWrite(
  ctx: MutationCtx,
  worker: Doc<"leadGenWorkers">,
  now: number,
) {
  const teamId = await resolveLeadGenTeamIdForWrite(ctx, {
    tenantId: worker.tenantId,
    teamId: worker.teamId,
  });

  if (teamId === worker.teamId) {
    return worker;
  }

  await ctx.db.patch(worker._id, {
    teamId,
    updatedAt: now,
  });

  return {
    ...worker,
    teamId,
    updatedAt: now,
  };
}

function normalizeClientSubmissionKey(key: string | undefined) {
  const trimmed = key?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_CLIENT_SUBMISSION_KEY_LENGTH) {
    throw new Error("Submission retry key is too long");
  }
  return trimmed;
}

function displayNameForUser(user: Doc<"users">) {
  return user.fullName?.trim() || user.email;
}
