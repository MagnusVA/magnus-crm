import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, type MutationCtx } from "../_generated/server";
import { describeError, log, reportError } from "../lib/observability/log";
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
import { linkLeadGenWorkerTeamMember } from "../lib/teamMembers";
import { emitDomainEvent } from "../lib/domainEvents";
import { blockedReason } from "../pipeline/blocked";
import { emitCaptureEvent, linkProspectPerson } from "./prospectPeople";

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
        log.info("lead_gen.submission.duplicate_retry", {
          reason: "client_submission_key_match",
          tenantId: access.tenantId,
          workerId: worker._id,
          submissionId: existingSubmission._id,
        });
        // A prospect the link backfill hasn't reached gets its person now.
        const existingProspect = await ctx.db.get("leadGenProspects", existingSubmission.prospectId);
        let leadId = existingProspect?.leadId;
        if (existingProspect && !leadId) {
          const person = await linkProspectPersonForCapture(ctx, existingProspect._id);
          if (person.created) {
            await emitLeadCreated(ctx, access.tenantId, person.leadId, access.userId, now);
          }
          leadId = person.leadId;
        }
        return {
          submissionId: existingSubmission._id,
          prospectId: existingSubmission.prospectId,
          leadId,
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

      prospect = await ctx.db.get("leadGenProspects", prospectId);
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

    // The prospect is a person, found by handle or created at Prospect
    // (docs/plans/phase-2-person-first.md §4.1), and each submission is a
    // touch on their timeline.
    const person = await linkProspectPersonForCapture(ctx, prospect._id);
    if (person.created) {
      await emitLeadCreated(ctx, access.tenantId, person.leadId, access.userId, now);
    }
    const submission = await ctx.db.get("leadGenSubmissions", submissionId);
    if (!submission) {
      throw new Error("Submission insert failed");
    }
    await emitCaptureEvent(ctx, submission, person.leadId);

    await ctx.db.patch("leadGenProspects", prospect._id, {
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

    log.info("lead_gen.submission.created", {
      tenantId: access.tenantId,
      submissionId,
      prospectId: prospect._id,
      workerId: worker._id,
      teamId: worker.teamId,
      source: args.source,
      originKind: submittedOrigin.originKind,
      originRankable,
      duplicateProspect,
      isDistinctWorker,
    });

    await scheduleSlackLeadGenNotification(ctx, {
      tenantId: access.tenantId,
      submissionId,
    });

    return {
      submissionId,
      prospectId: prospect._id,
      leadId: person.leadId,
      duplicateRetry: false,
      duplicateProspect,
    };
  },
});

/**
 * Links the prospect to its person. A handle that two persons hold, or whose
 * identifier points at a broken record, can't decide who this is, so the
 * capture fails until an admin merges or repairs them.
 */
async function linkProspectPersonForCapture(
  ctx: MutationCtx,
  prospectId: Id<"leadGenProspects">,
) {
  try {
    return await linkProspectPerson(ctx, prospectId);
  } catch (error) {
    const reason = blockedReason(error);
    if (!reason) {
      throw error;
    }
    reportError("lead_gen.capture.identity_blocked", new Error("Lead gen handle can't decide the person"), {
      fingerprint: `lead_gen.capture.identity_blocked:${reason}`,
      reason,
      prospectId,
    });
    throw new ConvexError(
      reason === "identity_conflict"
        ? "This handle belongs to more than one person in the CRM. Ask an admin to merge them, then submit again."
        : "This handle points at a person record that needs repair. Ask an admin to check it, then submit again.",
    );
  }
}

/** A capture created the person, as the other channels record it. */
async function emitLeadCreated(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
  actorUserId: Id<"users">,
  at: number,
) {
  await emitDomainEvent(ctx, {
    tenantId,
    entityType: "lead",
    entityId: leadId,
    eventType: "lead.created",
    source: "pipeline",
    actorUserId,
    toStatus: "active",
    occurredAt: at,
  });
}

/** Posts to the tenant's lead gen Slack channel, when one is configured. */
async function scheduleSlackLeadGenNotification(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    submissionId: Id<"leadGenSubmissions">;
  },
) {
  const installation = await ctx.db
    .query("slackInstallations")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", args.tenantId))
    .first();
  if (installation?.status !== "active" || !installation.leadGenNotifyChannelId) {
    return;
  }

  try {
    await ctx.scheduler.runAfter(
      0,
      internal.slack.notify.postLeadGenSubmission,
      args,
    );
  } catch (error) {
    // Swallowed so the submission still commits without a Slack post.
    reportError(
      "lead_gen.slack_notify.schedule_failed",
      new Error("Scheduling the lead gen Slack notification failed"),
      {
        fingerprint: "lead_gen.slack_notify.schedule_failed",
        errorName: describeError(error).name,
        tenantId: args.tenantId,
        submissionId: args.submissionId,
      },
    );
  }
}

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

  const user = await ctx.db.get("users", access.userId);
  if (!user || user.tenantId !== access.tenantId || !user.isActive) {
    throw new Error("Lead Gen Ops access is not active for this user");
  }

  if (existing) {
    await ctx.db.patch("leadGenWorkers", existing._id, {
      workosUserId: user.workosUserId,
      email: user.email,
      displayName: displayNameForUser(user),
      customProfilePictureStorageId: user.customProfilePictureStorageId,
      profilePictureUrl: user.profilePictureUrl,
      isActive: true,
      updatedAt: now,
    });
    const updated = await ctx.db.get("leadGenWorkers", existing._id);
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
    customProfilePictureStorageId: user.customProfilePictureStorageId,
    profilePictureUrl: user.profilePictureUrl,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });
  await linkLeadGenWorkerTeamMember(ctx, workerId);
  const worker = await ctx.db.get("leadGenWorkers", workerId);
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

  await ctx.db.patch("leadGenWorkers", worker._id, {
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
