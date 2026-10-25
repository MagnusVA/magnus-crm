import { ConvexError, v, type Infer } from "convex/values";
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
  dispositionSourceValidator,
  dispositionValidator,
  lifecycleStageValidator,
} from "../leads/lifecycle";
import { inactiveAfterDays } from "../lib/respark/settings";
import {
  updateLeadGenDailyStats,
  updateLeadGenOriginStats,
  updateLeadGenTeamOriginStats,
} from "./aggregates";
import { resolveLeadGenTeamIdForWrite } from "./sharedTeams";
import { linkLeadGenWorkerTeamMember } from "../lib/teamMembers";
import { emitDomainEvent } from "../lib/domainEvents";
import { blockedReason } from "../pipeline/blocked";
import {
  emitCaptureEvent,
  findOrCreateHandlePerson,
  settleProspectPerson,
} from "./prospectPeople";

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

// Where the person stood before this capture, for the confirmation
// (docs/plans/respark.md §5.4).
const capturedPersonValidator = v.object({
  isNew: v.boolean(),
  stage: lifecycleStageValidator,
  disposition: dispositionValidator,
  dispositionSource: v.optional(dispositionSourceValidator),
  dispositionSetAt: v.optional(v.number()),
  lastTouchAt: v.optional(v.number()),
  nextMeetingAt: v.optional(v.number()),
});

type CapturedPerson = Infer<typeof capturedPersonValidator>;

const MAX_OPEN_DEALS_READ = 20;

export const submit = mutation({
  args: leadGenSubmitArgsValidator,
  returns: v.object({
    submissionId: v.id("leadGenSubmissions"),
    prospectId: v.id("leadGenProspects"),
    leadId: v.optional(v.id("leads")),
    duplicateRetry: v.boolean(),
    duplicateProspect: v.boolean(),
    // Absent on a keyed retry: the state before the original capture is gone.
    person: v.optional(capturedPersonValidator),
    inactiveAfterDays: v.number(),
  }),
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
        const existingProspect = await ctx.db.get("leadGenProspects", existingSubmission.prospectId);
        return {
          submissionId: existingSubmission._id,
          prospectId: existingSubmission.prospectId,
          leadId: existingProspect?.leadId,
          duplicateRetry: true,
          duplicateProspect: false,
          inactiveAfterDays: inactiveAfterDays(await ctx.db.get("tenants", access.tenantId)),
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

    // The prospect is a person, found by handle or created at Prospect
    // (docs/plans/phase-2-person-first.md §4.1).
    let createdLeadId: Id<"leads"> | undefined;
    // Read before the capture's stage move and touch.
    let personBefore: CapturedPerson | undefined;
    if (prospect) {
      personBefore = await capturedPersonBefore(
        ctx,
        await ctx.db.get("leads", prospect.leadId),
        false,
        now,
      );
    } else {
      const person = await findOrCreateCapturePerson(ctx, {
        tenantId: access.tenantId,
        normalizedHandle: normalized.normalizedHandle,
        capturedAt: now,
      });
      createdLeadId = person.created ? person.lead._id : undefined;
      personBefore = await capturedPersonBefore(ctx, person.lead, person.created, now);
      const prospectId = await ctx.db.insert("leadGenProspects", {
        tenantId: access.tenantId,
        leadId: person.lead._id,
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
      await settleProspectPerson(ctx, prospect);
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

    // Each submission is a touch on the person's timeline.
    if (createdLeadId) {
      await emitLeadCreated(ctx, access.tenantId, createdLeadId, access.userId, now);
    }
    const submission = await ctx.db.get("leadGenSubmissions", submissionId);
    if (!submission) {
      throw new Error("Submission insert failed");
    }
    await emitCaptureEvent(ctx, submission, prospect.leadId);

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
      leadId: prospect.leadId,
      duplicateRetry: false,
      duplicateProspect,
      person: personBefore,
      inactiveAfterDays: inactiveAfterDays(await ctx.db.get("tenants", access.tenantId)),
    };
  },
});

/**
 * Where the person stood before this capture. A new person has no last
 * touch, and the next call is read only for someone at Booked or Showed.
 */
async function capturedPersonBefore(
  ctx: MutationCtx,
  lead: Doc<"leads"> | null,
  isNew: boolean,
  now: number,
): Promise<CapturedPerson | undefined> {
  if (!lead) {
    return undefined;
  }
  const hadCall = lead.lifecycleStage === "booked" || lead.lifecycleStage === "showed";
  return {
    isNew,
    stage: lead.lifecycleStage,
    disposition: lead.disposition,
    dispositionSource: lead.dispositionSource,
    dispositionSetAt: lead.dispositionSetAt,
    lastTouchAt: isNew ? undefined : lead.lastTouch?.occurredAt,
    nextMeetingAt: hadCall ? await nextMeetingAt(ctx, lead, now) : undefined,
  };
}

/**
 * The soonest scheduled call after `now` on the person's open deals. A deal's
 * `nextMeetingAt` can be a past call nobody recorded, so the meetings are
 * read by status and time. Past the deal bound it gives no date rather than
 * a wrong one.
 */
async function nextMeetingAt(
  ctx: MutationCtx,
  lead: Doc<"leads">,
  now: number,
): Promise<number | undefined> {
  const openDeals = await ctx.db
    .query("opportunities")
    .withIndex("by_tenantId_and_leadId_and_outcome", (q) =>
      q.eq("tenantId", lead.tenantId).eq("leadId", lead._id).eq("outcome", "open"),
    )
    .take(MAX_OPEN_DEALS_READ + 1);
  if (openDeals.length > MAX_OPEN_DEALS_READ) {
    return undefined;
  }
  let soonest: number | undefined;
  for (const deal of openDeals) {
    const meeting = await ctx.db
      .query("meetings")
      .withIndex("by_opportunityId_and_status_and_scheduledAt", (q) =>
        q.eq("opportunityId", deal._id).eq("status", "scheduled").gt("scheduledAt", now),
      )
      .first();
    if (meeting && (soonest === undefined || meeting.scheduledAt < soonest)) {
      soonest = meeting.scheduledAt;
    }
  }
  return soonest;
}

/**
 * The capture's person. A handle that two persons hold, or whose identifier
 * points at a broken record, can't decide who this is, so the capture fails
 * until an admin merges or repairs them.
 */
async function findOrCreateCapturePerson(
  ctx: MutationCtx,
  args: Parameters<typeof findOrCreateHandlePerson>[1],
) {
  try {
    return await findOrCreateHandlePerson(ctx, args);
  } catch (error) {
    const reason = blockedReason(error);
    if (!reason) {
      throw error;
    }
    reportError("lead_gen.capture.identity_blocked", new Error("Lead gen handle can't decide the person"), {
      fingerprint: `lead_gen.capture.identity_blocked:${reason}`,
      reason,
      tenantId: args.tenantId,
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
