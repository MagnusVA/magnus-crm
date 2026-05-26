import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  addBusinessDays,
  businessDateToUtcStart,
  timestampToBusinessDateKey,
} from "../reporting/lib/hondurasBusinessTime";
import type { LeadGenTeamId } from "./sharedTeams";
import { normalizeLeadGenOrigin } from "./normalization";

type LeadGenSource = Doc<"leadGenSubmissions">["source"];
type LeadGenOriginKind = Doc<"leadGenSubmissions">["originKind"];
type LeadGenWeekday = Doc<"leadGenWorkerSchedules">["weekday"];

const MAX_PROSPECT_DAY_ROWS_TO_CHECK = 50;
const MAX_CORRECTION_PROSPECT_DAY_ROWS_TO_CHECK = 100;
const WEEKDAYS: LeadGenWeekday[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

function dailyStatKey(args: {
  dayKey: string;
  workerId: Id<"leadGenWorkers">;
  teamId?: LeadGenTeamId;
  source: LeadGenSource;
}) {
  return [
    args.dayKey,
    args.workerId,
    args.teamId ?? "none",
    args.source,
  ].join(":");
}

export function teamOriginStatKey(args: {
  dayKey: string;
  teamId?: LeadGenTeamId;
  source: LeadGenSource;
  originKey: string;
}) {
  return [
    args.dayKey,
    args.teamId ?? "none",
    args.source,
    args.originKey,
  ].join(":");
}

function sortSubmissionsBySubmittedAt<T extends Doc<"leadGenSubmissions">>(
  rows: T[],
) {
  return [...rows].sort((a, b) => {
    if (a.submittedAt !== b.submittedAt) {
      return a.submittedAt - b.submittedAt;
    }
    return a._creationTime - b._creationTime;
  });
}

function clampCounter(value: number, delta: number, counterName: string) {
  const nextValue = value + delta;
  if (nextValue < 0) {
    console.error("[LeadGen:Corrections] aggregate counter underflow", {
      counterName,
      value,
      delta,
    });
    return 0;
  }
  return nextValue;
}

async function patchDailyStatCounters(
  ctx: MutationCtx,
  args: {
    submission: Doc<"leadGenSubmissions">;
    submissionsDelta?: number;
    uniqueProspectsDelta?: number;
    duplicateProspectsDelta?: number;
  },
) {
  const dayKey = timestampToBusinessDateKey(args.submission.submittedAt);
  const statKey = dailyStatKey({
    dayKey,
    workerId: args.submission.workerId,
    teamId: args.submission.teamId,
    source: args.submission.source,
  });
  const stat = await ctx.db
    .query("leadGenDailyStats")
    .withIndex("by_tenantId_and_statKey", (q) =>
      q.eq("tenantId", args.submission.tenantId).eq("statKey", statKey),
    )
    .unique();

  if (!stat) {
    throw new Error("Aggregate row not found for correction");
  }

  await ctx.db.patch(stat._id, {
    submissions: clampCounter(
      stat.submissions,
      args.submissionsDelta ?? 0,
      "leadGenDailyStats.submissions",
    ),
    uniqueProspectsSubmitted: clampCounter(
      stat.uniqueProspectsSubmitted,
      args.uniqueProspectsDelta ?? 0,
      "leadGenDailyStats.uniqueProspectsSubmitted",
    ),
    duplicateProspectSubmissions: clampCounter(
      stat.duplicateProspectSubmissions,
      args.duplicateProspectsDelta ?? 0,
      "leadGenDailyStats.duplicateProspectSubmissions",
    ),
    updatedAt: Date.now(),
  });
}

async function patchOriginStatCounters(
  ctx: MutationCtx,
  args: {
    submission: Doc<"leadGenSubmissions">;
    originKey: string;
    submissionsDelta?: number;
    uniqueProspectsDelta?: number;
  },
) {
  const dayKey = timestampToBusinessDateKey(args.submission.submittedAt);
  const stat = await ctx.db
    .query("leadGenOriginStats")
    .withIndex("by_tenantId_and_originKey_and_dayKey", (q) =>
      q
        .eq("tenantId", args.submission.tenantId)
        .eq("originKey", args.originKey)
        .eq("dayKey", dayKey),
    )
    .unique();

  if (!stat) {
    throw new Error("Origin aggregate row not found for correction");
  }

  await ctx.db.patch(stat._id, {
    submissions: clampCounter(
      stat.submissions,
      args.submissionsDelta ?? 0,
      "leadGenOriginStats.submissions",
    ),
    uniqueProspectsSubmitted: clampCounter(
      stat.uniqueProspectsSubmitted,
      args.uniqueProspectsDelta ?? 0,
      "leadGenOriginStats.uniqueProspectsSubmitted",
    ),
    updatedAt: Date.now(),
  });
}

async function patchTeamOriginStatCounters(
  ctx: MutationCtx,
  args: {
    submission: Doc<"leadGenSubmissions">;
    originKey: string;
    submissionsDelta?: number;
    uniqueProspectsDelta?: number;
  },
) {
  const dayKey = timestampToBusinessDateKey(args.submission.submittedAt);
  const statKey = teamOriginStatKey({
    dayKey,
    teamId: args.submission.teamId,
    source: args.submission.source,
    originKey: args.originKey,
  });
  const stat = await ctx.db
    .query("leadGenTeamOriginStats")
    .withIndex("by_tenantId_and_statKey", (q) =>
      q.eq("tenantId", args.submission.tenantId).eq("statKey", statKey),
    )
    .unique();

  if (!stat) {
    console.warn("[LeadGen:Corrections] missing team-origin aggregate row", {
      submissionId: args.submission._id,
      statKey,
    });
    return;
  }

  await ctx.db.patch(stat._id, {
    submissions: clampCounter(
      stat.submissions,
      args.submissionsDelta ?? 0,
      "leadGenTeamOriginStats.submissions",
    ),
    uniqueProspectsSubmitted: clampCounter(
      stat.uniqueProspectsSubmitted,
      args.uniqueProspectsDelta ?? 0,
      "leadGenTeamOriginStats.uniqueProspectsSubmitted",
    ),
    updatedAt: Date.now(),
  });
}

async function getBoundedActiveProspectSubmissionsForCorrectionDay(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    prospectId: Id<"leadGenProspects">;
    submittedAt: number;
  },
) {
  const rows = await getActiveProspectSubmissionsForDay(ctx, {
    ...args,
    maxRows: MAX_CORRECTION_PROSPECT_DAY_ROWS_TO_CHECK + 1,
  });

  if (rows.length > MAX_CORRECTION_PROSPECT_DAY_ROWS_TO_CHECK) {
    throw new Error("Correction range requires bounded reconciliation");
  }

  return sortSubmissionsBySubmittedAt(rows);
}

async function submissionHadPriorProspectAttempt(
  ctx: MutationCtx,
  submission: Doc<"leadGenSubmissions">,
) {
  const priorRows = await ctx.db
    .query("leadGenSubmissions")
    .withIndex("by_tenantId_and_prospectId_and_submittedAt", (q) =>
      q
        .eq("tenantId", submission.tenantId)
        .eq("prospectId", submission.prospectId)
        .lt("submittedAt", submission.submittedAt),
    )
    .order("desc")
    .take(1);

  return priorRows.length > 0;
}

function originKeyForSubmission(submission: Doc<"leadGenSubmissions">) {
  if (!submission.originRankable || !submission.originValue) {
    return null;
  }

  return (
    normalizeLeadGenOrigin({
      originKind: submission.originKind,
      originUrlOrLabel: submission.originValue,
    }).originKey ?? null
  );
}

function weekdayForBusinessDate(dayKey: string): LeadGenWeekday {
  businessDateToUtcStart(dayKey);
  const date = new Date(`${dayKey}T12:00:00.000Z`);
  const weekday = WEEKDAYS[date.getUTCDay()];
  if (!weekday) {
    throw new Error("Invalid business date weekday");
  }
  return weekday;
}

function isCurrentSubmission(
  row: Doc<"leadGenSubmissions">,
  args: {
    workerId?: Id<"leadGenWorkers">;
    prospectId: Id<"leadGenProspects">;
    source: LeadGenSource;
    submittedAt: number;
  },
) {
  return (
    (args.workerId === undefined || row.workerId === args.workerId) &&
    row.prospectId === args.prospectId &&
    row.source === args.source &&
    row.submittedAt === args.submittedAt &&
    row.voidedAt === undefined
  );
}

async function getActiveProspectSubmissionsForDay(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    prospectId: Id<"leadGenProspects">;
    submittedAt: number;
    maxRows: number;
  },
) {
  const dayKey = timestampToBusinessDateKey(args.submittedAt);
  const dayStart = businessDateToUtcStart(dayKey);
  const dayEnd = businessDateToUtcStart(addBusinessDays(dayKey, 1));

  const rows = await ctx.db
    .query("leadGenSubmissions")
    .withIndex("by_tenantId_and_prospectId_and_submittedAt", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .eq("prospectId", args.prospectId)
        .gte("submittedAt", dayStart)
        .lt("submittedAt", dayEnd),
    )
    .take(args.maxRows);

  return rows.filter((row) => row.voidedAt === undefined);
}

async function isFirstActiveProspectSubmissionForDay(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    workerId: Id<"leadGenWorkers">;
    prospectId: Id<"leadGenProspects">;
    source: LeadGenSource;
    submittedAt: number;
  },
) {
  const rows = await getActiveProspectSubmissionsForDay(ctx, {
    tenantId: args.tenantId,
    prospectId: args.prospectId,
    submittedAt: args.submittedAt,
    maxRows: 2,
  });
  const currentAlreadyInserted = rows.some((row) =>
    isCurrentSubmission(row, args),
  );

  return currentAlreadyInserted ? rows.length === 1 : rows.length === 0;
}

async function isFirstActiveProspectSubmissionForOriginDay(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    prospectId: Id<"leadGenProspects">;
    source: LeadGenSource;
    originKind: LeadGenOriginKind;
    originValue: string;
    submittedAt: number;
  },
) {
  const rows = await getActiveProspectSubmissionsForDay(ctx, {
    tenantId: args.tenantId,
    prospectId: args.prospectId,
    submittedAt: args.submittedAt,
    maxRows: MAX_PROSPECT_DAY_ROWS_TO_CHECK,
  });
  const sameOriginRows = rows.filter(
    (row) =>
      row.originRankable &&
      row.originKind === args.originKind &&
      row.originValue === args.originValue,
  );
  const currentAlreadyInserted = sameOriginRows.some((row) =>
    isCurrentSubmission(row, args),
  );

  return currentAlreadyInserted
    ? sameOriginRows.length === 1
    : sameOriginRows.length === 0;
}

async function isFirstActiveProspectSubmissionForTeamOriginDay(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    teamId?: LeadGenTeamId;
    prospectId: Id<"leadGenProspects">;
    source: LeadGenSource;
    originKind: LeadGenOriginKind;
    originValue: string;
    submittedAt: number;
  },
) {
  const rows = await getActiveProspectSubmissionsForDay(ctx, {
    tenantId: args.tenantId,
    prospectId: args.prospectId,
    submittedAt: args.submittedAt,
    maxRows: MAX_PROSPECT_DAY_ROWS_TO_CHECK,
  });
  const sameTeamOriginRows = rows.filter(
    (row) =>
      row.teamId === args.teamId &&
      row.originRankable &&
      row.originKind === args.originKind &&
      row.originValue === args.originValue,
  );
  const currentAlreadyInserted = sameTeamOriginRows.some((row) =>
    isCurrentSubmission(row, args),
  );

  return currentAlreadyInserted
    ? sameTeamOriginRows.length === 1
    : sameTeamOriginRows.length === 0;
}

export async function snapshotLeadGenScheduledHours(
  ctx: MutationCtx,
  args: {
    worker: Doc<"leadGenWorkers">;
    dayKey: string;
  },
) {
  const weekday = weekdayForBusinessDate(args.dayKey);
  const schedule = await ctx.db
    .query("leadGenWorkerSchedules")
    .withIndex("by_tenantId_and_workerId_and_weekday", (q) =>
      q
        .eq("tenantId", args.worker.tenantId)
        .eq("workerId", args.worker._id)
        .eq("weekday", weekday),
    )
    .unique();

  return schedule?.scheduledHours ?? 0;
}

export async function updateLeadGenDailyStats(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    worker: Doc<"leadGenWorkers">;
    source: LeadGenSource;
    submittedAt: number;
    duplicateProspectSubmission: boolean;
    prospectId: Id<"leadGenProspects">;
  },
) {
  if (args.worker.tenantId !== args.tenantId) {
    throw new Error("Worker does not belong to tenant");
  }

  const dayKey = timestampToBusinessDateKey(args.submittedAt);
  const statKey = dailyStatKey({
    dayKey,
    workerId: args.worker._id,
    teamId: args.worker.teamId,
    source: args.source,
  });
  const now = Date.now();

  const existing = await ctx.db
    .query("leadGenDailyStats")
    .withIndex("by_tenantId_and_statKey", (q) =>
      q.eq("tenantId", args.tenantId).eq("statKey", statKey),
    )
    .unique();

  const isUniqueForDay = await isFirstActiveProspectSubmissionForDay(ctx, {
    tenantId: args.tenantId,
    workerId: args.worker._id,
    prospectId: args.prospectId,
    source: args.source,
    submittedAt: args.submittedAt,
  });

  if (existing) {
    await ctx.db.patch(existing._id, {
      submissions: existing.submissions + 1,
      uniqueProspectsSubmitted:
        existing.uniqueProspectsSubmitted + (isUniqueForDay ? 1 : 0),
      duplicateProspectSubmissions:
        existing.duplicateProspectSubmissions +
        (args.duplicateProspectSubmission ? 1 : 0),
      updatedAt: now,
    });
    return existing._id;
  }

  return await ctx.db.insert("leadGenDailyStats", {
    tenantId: args.tenantId,
    statKey,
    dayKey,
    workerId: args.worker._id,
    userId: args.worker.userId,
    teamId: args.worker.teamId,
    source: args.source,
    submissions: 1,
    uniqueProspectsSubmitted: isUniqueForDay ? 1 : 0,
    duplicateProspectSubmissions: args.duplicateProspectSubmission ? 1 : 0,
    scheduledHours: await snapshotLeadGenScheduledHours(ctx, {
      worker: args.worker,
      dayKey,
    }),
    updatedAt: now,
  });
}

export async function updateLeadGenOriginStats(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    source: LeadGenSource;
    originKind: LeadGenOriginKind;
    originKey: string;
    originValue: string;
    prospectId: Id<"leadGenProspects">;
    submittedAt: number;
  },
) {
  const dayKey = timestampToBusinessDateKey(args.submittedAt);
  const now = Date.now();
  const existing = await ctx.db
    .query("leadGenOriginStats")
    .withIndex("by_tenantId_and_originKey_and_dayKey", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .eq("originKey", args.originKey)
        .eq("dayKey", dayKey),
    )
    .unique();

  const isUniqueForOriginDay =
    await isFirstActiveProspectSubmissionForOriginDay(ctx, {
      tenantId: args.tenantId,
      prospectId: args.prospectId,
      source: args.source,
      originKind: args.originKind,
      originValue: args.originValue,
      submittedAt: args.submittedAt,
    });

  if (existing) {
    await ctx.db.patch(existing._id, {
      submissions: existing.submissions + 1,
      uniqueProspectsSubmitted:
        existing.uniqueProspectsSubmitted +
        (isUniqueForOriginDay ? 1 : 0),
      updatedAt: now,
    });
    return existing._id;
  }

  return await ctx.db.insert("leadGenOriginStats", {
    tenantId: args.tenantId,
    originKey: args.originKey,
    dayKey,
    source: args.source,
    originKind: args.originKind,
    originValue: args.originValue,
    submissions: 1,
    uniqueProspectsSubmitted: isUniqueForOriginDay ? 1 : 0,
    updatedAt: now,
  });
}

export async function updateLeadGenTeamOriginStats(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    teamId?: LeadGenTeamId;
    source: LeadGenSource;
    originKind: LeadGenOriginKind;
    originKey: string;
    originValue: string;
    prospectId: Id<"leadGenProspects">;
    submittedAt: number;
  },
) {
  const dayKey = timestampToBusinessDateKey(args.submittedAt);
  const statKey = teamOriginStatKey({
    dayKey,
    teamId: args.teamId,
    source: args.source,
    originKey: args.originKey,
  });
  const now = Date.now();
  const existing = await ctx.db
    .query("leadGenTeamOriginStats")
    .withIndex("by_tenantId_and_statKey", (q) =>
      q.eq("tenantId", args.tenantId).eq("statKey", statKey),
    )
    .unique();

  const isUniqueForTeamOriginDay =
    await isFirstActiveProspectSubmissionForTeamOriginDay(ctx, {
      tenantId: args.tenantId,
      teamId: args.teamId,
      prospectId: args.prospectId,
      source: args.source,
      originKind: args.originKind,
      originValue: args.originValue,
      submittedAt: args.submittedAt,
    });

  if (existing) {
    await ctx.db.patch(existing._id, {
      submissions: existing.submissions + 1,
      uniqueProspectsSubmitted:
        existing.uniqueProspectsSubmitted +
        (isUniqueForTeamOriginDay ? 1 : 0),
      updatedAt: now,
    });
    return existing._id;
  }

  return await ctx.db.insert("leadGenTeamOriginStats", {
    tenantId: args.tenantId,
    statKey,
    dayKey,
    teamId: args.teamId,
    source: args.source,
    originKind: args.originKind,
    originKey: args.originKey,
    originValue: args.originValue,
    submissions: 1,
    uniqueProspectsSubmitted: isUniqueForTeamOriginDay ? 1 : 0,
    updatedAt: now,
  });
}

export async function applyLeadGenAggregateDelta(
  ctx: MutationCtx,
  args: {
    submission: Doc<"leadGenSubmissions">;
    delta: 1 | -1;
    reason: "voided" | "restored" | "edited";
  },
) {
  if (args.delta !== -1 || args.reason !== "voided") {
    throw new Error("Only void aggregate corrections are supported");
  }

  const activeProspectRows =
    await getBoundedActiveProspectSubmissionsForCorrectionDay(ctx, {
      tenantId: args.submission.tenantId,
      prospectId: args.submission.prospectId,
      submittedAt: args.submission.submittedAt,
    });
  const activeCurrent = activeProspectRows.find(
    (row) => row._id === args.submission._id,
  );

  if (!activeCurrent) {
    throw new Error("Submission is already voided");
  }

  const firstActiveForProspectDay = activeProspectRows[0];
  const nextActiveForProspectDay = activeProspectRows.find(
    (row) => row._id !== args.submission._id,
  );
  const currentOwnsUniqueProspectCredit =
    firstActiveForProspectDay?._id === args.submission._id;
  const duplicateProspectSubmission = await submissionHadPriorProspectAttempt(
    ctx,
    args.submission,
  );

  await patchDailyStatCounters(ctx, {
    submission: args.submission,
    submissionsDelta: -1,
    uniqueProspectsDelta: currentOwnsUniqueProspectCredit ? -1 : 0,
    duplicateProspectsDelta: duplicateProspectSubmission ? -1 : 0,
  });

  if (currentOwnsUniqueProspectCredit && nextActiveForProspectDay) {
    await patchDailyStatCounters(ctx, {
      submission: nextActiveForProspectDay,
      uniqueProspectsDelta: 1,
    });
  }

  const originKey = originKeyForSubmission(args.submission);
  if (!originKey) {
    return;
  }

  const activeSameOriginRows = activeProspectRows.filter(
    (row) => originKeyForSubmission(row) === originKey,
  );
  const currentOwnsOriginUniqueCredit =
    activeSameOriginRows[0]?._id === args.submission._id;
  const anotherSameOriginSubmissionExists = activeSameOriginRows.some(
    (row) => row._id !== args.submission._id,
  );

  await patchOriginStatCounters(ctx, {
    submission: args.submission,
    originKey,
    submissionsDelta: -1,
    uniqueProspectsDelta:
      currentOwnsOriginUniqueCredit && !anotherSameOriginSubmissionExists
        ? -1
        : 0,
  });

  const activeSameTeamOriginRows = activeProspectRows.filter(
    (row) =>
      row.teamId === args.submission.teamId &&
      originKeyForSubmission(row) === originKey,
  );
  const currentOwnsTeamOriginUniqueCredit =
    activeSameTeamOriginRows[0]?._id === args.submission._id;
  const anotherSameTeamOriginSubmissionExists =
    activeSameTeamOriginRows.some((row) => row._id !== args.submission._id);

  await patchTeamOriginStatCounters(ctx, {
    submission: args.submission,
    originKey,
    submissionsDelta: -1,
    uniqueProspectsDelta:
      currentOwnsTeamOriginUniqueCredit &&
      !anotherSameTeamOriginSubmissionExists
        ? -1
        : 0,
  });
}
