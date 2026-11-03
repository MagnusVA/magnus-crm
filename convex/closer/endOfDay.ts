import { getConvexSize, v } from "convex/values";
import type { Infer } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import schema from "../schema";
import { businessDateForInstant } from "../../lib/businessDay";
import { meetingAttendanceDisplay } from "../../lib/status-config";
import { createLiveReadState, readLiveQueryRows } from "../lib/liveQueryBounds";
import { rejectRequest } from "../lib/observability/errors";
import { log } from "../lib/observability/log";
import { getTenantBusinessDay } from "../lib/tenantBusinessDay";
import { dealStageOf } from "../opportunities/stages";
import { meetingsByStatus } from "../reporting/aggregates";
import { readCloseRateCohort } from "../reporting/lib/closeRateCohort";
import {
  getNonDisputedPaymentsInRange,
  makeTupleDateBounds,
  summarizePaymentsForRevenueReporting,
} from "../reporting/lib/helpers";
import { isPersonLoss } from "../reporting/lib/outcomeDerivation";
import { validateTimezone } from "../users/timezone";
import { countStripByStage, readCloserMeetingDeals } from "./dashboard";
import {
  endOfDayGapValidator,
  endOfDayNumbersValidator,
} from "./endOfDaySchema";

const DAY = 86_400_000;
// A shift snapshot must fit one document and leave transaction reads for joins.
const MAX_ROWS = 200;
const BYTE_BUDGET = 3 * 1024 * 1024;
type Numbers = Infer<typeof endOfDayNumbersValidator>;
type Gap = Infer<typeof endOfDayGapValidator>;
export type EndDayCaller = {
  tenantId: Id<"tenants">;
  userId: Id<"users">;
  role: Doc<"users">["role"];
};
export type EndDayOptions = {
  narrative?: string;
  note?: string;
  timeZone?: string;
  endedVia: "web" | "agent";
  agentClient?: string;
};
export type CloserDaySummary = { numbers: Numbers; gaps: Gap[] };
export type DaySummaryOptions = { now?: number; timeZone?: string };
export type DaySummary = CloserDaySummary & {
  periodStart: number;
  periodEnd: number;
  previousDayUnclosed: boolean;
  timeZone: string;
  slackChannelName: string | null;
  slackChannelId: string | null;
  latestReport: Doc<"endOfDayReports"> | null;
};

function requireComplete(capped: boolean) {
  if (capped)
    throw rejectRequest(
      "end_day.read_limit",
      "This shift has too much data to summarize safely. Ask an admin for help.",
    );
}

/** Decision 10: never put an email or a full surname in the shared report. */
export function reportPersonName(fullName: string | undefined): string {
  const words = (fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.some((word) => word.includes("@")))
    return "Unknown";
  return words.length === 1
    ? words[0]
    : `${words[0]} ${Array.from(words.at(-1)!)[0]}.`;
}

/** The dashboard's counts, in a shift window. Never persist a partial read. */
export async function buildCloserDaySummary(
  ctx: QueryCtx,
  {
    tenantId,
    userId,
    periodStart,
    periodEnd,
    now,
  }: {
    tenantId: Id<"tenants">;
    userId: Id<"users">;
    periodStart: number;
    periodEnd: number;
    now: number;
  },
): Promise<CloserDaySummary> {
  if (
    !Number.isFinite(periodStart) ||
    !Number.isFinite(periodEnd) ||
    periodStart > periodEnd ||
    periodEnd - periodStart > DAY
  ) {
    throw rejectRequest(
      "end_day.invalid_window",
      "The report window must be at most 24 hours and end at or after it starts.",
    );
  }
  const state = createLiveReadState();
  const bounded = async <T>(rows: AsyncIterable<T>, limit = MAX_ROWS) => {
    const read = await readLiveQueryRows(rows, limit, state, BYTE_BUDGET);
    requireComplete(read.capped);
    return read.rows;
  };
  const meetings = await bounded(
    ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_assignedCloserId_and_scheduledAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("assignedCloserId", userId)
          .gte("scheduledAt", periodStart)
          .lt("scheduledAt", periodEnd),
      ),
  );
  const dealRead = await readCloserMeetingDeals(
    ctx,
    tenantId,
    userId,
    periodStart,
    periodEnd,
    MAX_ROWS,
    BYTE_BUDGET,
  );
  requireComplete(dealRead.isMeetingDataTruncated);
  const strip = countStripByStage(dealRead.deals);
  const cohort = await readCloseRateCohort(
    ctx,
    tenantId,
    { start: periodStart, end: periodEnd },
    { closerId: userId, maxHeldMeetings: MAX_ROWS },
  );
  requireComplete(cohort.capped);
  const payments =
    periodStart === periodEnd
      ? { payments: [], isTruncated: false }
      : await getNonDisputedPaymentsInRange(
          ctx,
          tenantId,
          periodStart,
          periodEnd,
        );
  requireComplete(payments.isTruncated);
  const closerPayments = summarizePaymentsForRevenueReporting(
    payments.payments,
  ).allPayments.filter((payment) => payment.effectiveCloserId === userId);
  const currencies = [
    ...new Set(closerPayments.map((payment) => payment.currency)),
  ].sort();
  const money = currencies.map((currency) => {
    const summary = summarizePaymentsForRevenueReporting(
      closerPayments.filter((payment) => payment.currency === currency),
    );
    return {
      currency,
      cashMinor: summary.finalRevenueMinor,
      depositsMinor: summary.depositRevenueMinor,
    };
  });
  const gaps: Gap[] = [];
  const numbers: Numbers = {
    newCalls: {
      scheduled: 0,
      held: 0,
      noShow: 0,
      canceled: 0,
      notRecorded: 0,
      showRate: null,
    },
    followUpCalls: {
      scheduled: 0,
      held: 0,
      noShow: 0,
      canceled: 0,
      notRecorded: 0,
      showRate: null,
    },
    closeRate: {
      cohort: cohort.deals.length,
      won: cohort.deals.filter((deal) => deal.won).length,
    },
    deals: {
      won: strip.won,
      deposits: 0,
      lost: strip.lost,
      followUp: strip.counts.follow_up,
    },
    money,
    callbacks: { due: 0, done: 0, pending: 0 },
    overran: 0,
    people: [],
  };
  // Aggregate attendance is the same source Team uses. Live rows supply the
  // scheduled-call end time, which cannot be inferred from the aggregate key.
  for (const classification of periodStart === periodEnd
    ? []
    : (["new", "follow_up"] as const)) {
    const group =
      classification === "new" ? numbers.newCalls : numbers.followUpCalls;
    const counts = await meetingsByStatus.countBatch(
      ctx,
      (["scheduled", "held", "no_show", "canceled"] as const).map((status) => ({
        namespace: tenantId,
        bounds: makeTupleDateBounds(
          [userId, classification, status] as const,
          periodStart,
          periodEnd,
        ),
      })),
    );
    group.scheduled = counts.reduce((sum, count) => sum + count, 0);
    [, group.held, group.noShow, group.canceled] = counts;
    group.showRate =
      group.held + group.noShow
        ? group.held / (group.held + group.noShow)
        : null;
  }
  for (const meeting of meetings) {
    const recordings = await bounded(
      ctx.db
        .query("callRecordings")
        .withIndex("by_meetingId", (q) => q.eq("meetingId", meeting._id)),
      10,
    );
    const matched = recordings.filter(
      (recording) =>
        recording.tenantId === tenantId && recording.matchStatus === "matched",
    );
    if (
      meeting.status === "held" &&
      matched.some(
        (recording) =>
          recording.recordingEndAt >
          meeting.scheduledAt + (meeting.durationMinutes + 10) * 60_000,
      )
    )
      numbers.overran++;
    if (meetingAttendanceDisplay(meeting, now) === "not_recorded") {
      (meeting.callClassification === "follow_up"
        ? numbers.followUpCalls
        : numbers.newCalls
      ).notRecorded++;
      gaps.push({
        kind: "not_recorded",
        label: `${reportPersonName(meeting.leadName)} · Not recorded${matched.length ? " · Recording available" : ""}`,
        meetingId: meeting._id,
        ...(matched[0] && { recordingId: matched[0]._id }),
      });
    }
  }
  for (const deal of dealRead.deals) {
    const dealMeetings = meetings.filter(
      (meeting) => meeting.opportunityId === deal._id,
    );
    const meeting =
      dealMeetings.find((row) => row.status === "held") ?? dealMeetings[0];
    const lead = await ctx.db.get("leads", deal.leadId);
    const name = reportPersonName(
      lead?.tenantId === tenantId
        ? (lead.fullName ?? meeting?.leadName)
        : meeting?.leadName,
    );
    const callType = meeting?.callClassification ?? "new";
    const { stage, outcome } = dealStageOf(deal);
    let kind: Numbers["people"][number]["kind"] | undefined;
    let amounts: NonNullable<Numbers["people"][number]["amounts"]> | undefined;
    if (outcome === "won") {
      const rows = await bounded(
        ctx.db
          .query("paymentRecords")
          .withIndex("by_opportunityId_and_recordedAt", (q) =>
            q.eq("opportunityId", deal._id),
          ),
      );
      const summary = summarizePaymentsForRevenueReporting(
        rows.filter((payment) => payment.tenantId === tenantId),
      );
      const depositOnly =
        summary.allPayments.length > 0 && summary.finalPayments.length === 0;
      kind = depositOnly ? "deposit" : "won";
      if (depositOnly) {
        numbers.deals.won--;
        numbers.deals.deposits++;
      }
      const grouped = new Map<string, NonNullable<typeof amounts>[number]>();
      for (const payment of depositOnly
        ? summary.depositPayments
        : summary.finalPayments) {
        const key = JSON.stringify([
          payment.currency,
          payment.programName,
          payment.paymentType,
        ]);
        const amount = grouped.get(key) ?? {
          amountMinor: 0,
          currency: payment.currency,
          program: payment.programName,
          paymentType: payment.paymentType,
        };
        amount.amountMinor += payment.amountMinor;
        grouped.set(key, amount);
      }
      amounts = [...grouped.values()];
    } else if (isPersonLoss(deal)) kind = "lost";
    else if (stage === "follow_up") kind = "follow_up";
    else if (dealMeetings.some((row) => row.status === "no_show"))
      kind = "no_show";
    if (kind)
      numbers.people.push({
        kind,
        callType,
        name,
        ...(deal.firstBookingProgramName && {
          program: deal.firstBookingProgramName,
        }),
        ...(amounts && { amounts }),
        ...(amounts?.length === 1 && {
          amountMinor: amounts[0].amountMinor,
          currency: amounts[0].currency,
          program: amounts[0].program,
          paymentType: amounts[0].paymentType,
        }),
      });
  }
  // Due time selects tasks, irrespective of when someone completed them.
  for (const status of ["pending", "completed", "booked", "expired"] as const) {
    const tasks = await bounded(
      ctx.db
        .query("followUps")
        .withIndex(
          "by_tenantId_and_closerId_and_type_and_status_reminderScheduledAt",
          (q) =>
            q
              .eq("tenantId", tenantId)
              .eq("closerId", userId)
              .eq("type", "manual_reminder")
              .eq("status", status)
              .gte("reminderScheduledAt", periodStart)
              .lt("reminderScheduledAt", periodEnd),
        ),
    );
    numbers.callbacks.due += tasks.length;
    if (status === "completed") numbers.callbacks.done += tasks.length;
    if (status === "pending") numbers.callbacks.pending += tasks.length;
  }
  const overdue = await bounded(
    ctx.db
      .query("followUps")
      .withIndex(
        "by_tenantId_and_closerId_and_type_and_status_reminderScheduledAt",
        (q) =>
          q
            .eq("tenantId", tenantId)
            .eq("closerId", userId)
            .eq("type", "manual_reminder")
            .eq("status", "pending")
            .gt("reminderScheduledAt", 0)
            .lt("reminderScheduledAt", now),
      ),
  );
  for (const task of overdue) {
    const lead = await ctx.db.get("leads", task.leadId);
    gaps.push({
      kind: "overdue_task",
      label: `${reportPersonName(lead?.tenantId === tenantId ? lead.fullName : undefined)} · Call-back overdue`,
      followUpId: task._id,
    });
  }
  const unmatched = await bounded(
    ctx.db
      .query("callRecordings")
      .withIndex("by_tenantId_and_recordedByUserId_and_matchStatus", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("recordedByUserId", userId)
          .eq("matchStatus", "unmatched"),
      ),
  );
  for (const recording of unmatched)
    gaps.push({
      kind: "unmatched_recording",
      label: "Recording without a meeting",
      recordingId: recording._id,
    });
  const result = { numbers, gaps };
  requireComplete(getConvexSize(result) > 800_000);
  return result;
}

async function reportWindow(ctx: QueryCtx, caller: EndDayCaller, now: number) {
  if (caller.role !== "closer")
    throw rejectRequest("end_day.forbidden", "Only closers can end their day.");
  const [user, setting, previous] = await Promise.all([
    ctx.db.get("users", caller.userId),
    getTenantBusinessDay(ctx, caller.tenantId),
    ctx.db
      .query("endOfDayReports")
      .withIndex("by_tenantId_and_userId_and_periodEnd", (q) =>
        q.eq("tenantId", caller.tenantId).eq("userId", caller.userId),
      )
      .order("desc")
      .first(),
  ]);
  if (
    !user ||
    user.tenantId !== caller.tenantId ||
    !user.isActive ||
    user.role !== "closer"
  )
    throw rejectRequest("end_day.forbidden", "Closer access is required.");
  const previousDayUnclosed = !previous || now - previous.periodEnd > DAY;
  return {
    user,
    setting,
    previous,
    periodStart: previousDayUnclosed ? now - DAY : previous.periodEnd,
    periodEnd: Math.max(now, previous?.periodEnd ?? now),
    previousDayUnclosed,
  };
}

/** Read-only core for magnus_day_summary. The caller must resolve auth first. */
export async function getDaySummaryCore(
  ctx: QueryCtx,
  caller: EndDayCaller,
  options: DaySummaryOptions = {},
): Promise<DaySummary> {
  const now = options.now ?? Date.now();
  const window = await reportWindow(ctx, caller, now);
  const installation = await ctx.db
    .query("slackInstallations")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", caller.tenantId))
    .first();
  const channel =
    installation?.status === "active" && installation.eodReportChannelId
      ? installation
      : null;
  return {
    periodStart: window.periodStart,
    periodEnd: window.periodEnd,
    previousDayUnclosed: window.previousDayUnclosed,
    timeZone:
      window.user.timezone ??
      (options.timeZone
        ? validateTimezone(options.timeZone)
        : window.setting.timeZone),
    slackChannelName: channel?.eodReportChannelName ?? null,
    slackChannelId: channel?.eodReportChannelId ?? null,
    latestReport: window.previous,
    ...(await buildCloserDaySummary(ctx, {
      ...caller,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      now: window.periodEnd,
    })),
  };
}

/** Shared write core for web and magnus_end_day. The caller resolves auth. */
export async function endDayCore(
  ctx: MutationCtx,
  caller: EndDayCaller,
  options: EndDayOptions,
): Promise<Doc<"endOfDayReports">> {
  const now = Date.now();
  const window = await reportWindow(ctx, caller, now);
  if (window.previous && now - window.previous.periodEnd < 60_000)
    return window.previous;
  const text = (value: string | undefined, max: number) => {
    if (value && value.length > max)
      throw rejectRequest(
        "end_day.text_too_long",
        `Report text must be at most ${max} characters.`,
      );
    return value?.trim() || undefined;
  };
  const timeZone =
    window.user.timezone ??
    (options.timeZone
      ? validateTimezone(options.timeZone)
      : window.setting.timeZone);
  const summary = await buildCloserDaySummary(ctx, {
    ...caller,
    periodStart: window.periodStart,
    periodEnd: now,
    now,
  });
  const installation = await ctx.db
    .query("slackInstallations")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", caller.tenantId))
    .first();
  const channelId =
    installation?.status === "active"
      ? installation.eodReportChannelId
      : undefined;
  const previous = window.previous;
  const sameDay =
    previous &&
    !window.previousDayUnclosed &&
    businessDateForInstant(previous.periodEnd, window.setting) ===
      businessDateForInstant(now, window.setting);
  const thread =
    sameDay && previous.slackChannelId === channelId ? previous : null;
  const reportId = await ctx.db.insert("endOfDayReports", {
    tenantId: caller.tenantId,
    userId: caller.userId,
    role: "closer",
    periodStart: window.periodStart,
    periodEnd: now,
    previousDayUnclosed: window.previousDayUnclosed,
    timeZone,
    previousReportId: previous?._id,
    ...summary,
    narrativeMarkdown: text(options.narrative, 6000),
    note: text(options.note, 2000),
    endedVia: options.endedVia,
    agentClient: text(options.agentClient, 100),
    slackStatus: channelId ? "pending" : "not_configured",
    slackChannelId: channelId,
    slackChannelName: channelId
      ? installation?.eodReportChannelName
      : undefined,
    slackThreadTs: thread?.slackThreadTs ?? thread?.slackTs,
    slackThreadReportId: thread
      ? (thread.slackThreadReportId ?? thread._id)
      : undefined,
    createdAt: now,
  });
  if (options.endedVia === "web" && options.timeZone && !window.user.timezone)
    await ctx.db.patch("users", caller.userId, {
      timezone: validateTimezone(options.timeZone),
    });
  if (channelId)
    await ctx.scheduler.runAfter(0, internal.slack.eodReports.post, {
      reportId,
    });
  log.info("closer.day_ended", {
    tenantId: caller.tenantId,
    userId: caller.userId,
    reportId,
    endedVia: options.endedVia,
    slackStatus: channelId ? "pending" : "not_configured",
  });
  return (await ctx.db.get("endOfDayReports", reportId))!;
}

export const endMyDay = mutation({
  args: { note: v.optional(v.string()), timeZone: v.optional(v.string()) },
  returns: schema.doc("endOfDayReports"),
  handler: async (ctx, args) => {
    const caller = await requireTenantUser(ctx, ["closer"]);
    return await endDayCore(ctx, caller, { ...args, endedVia: "web" });
  },
});

export const getMyReport = query({
  args: { reportId: v.id("endOfDayReports") },
  returns: v.union(schema.doc("endOfDayReports"), v.null()),
  handler: async (ctx, { reportId }) => {
    const caller = await requireTenantUser(ctx, ["closer"]);
    const report = await ctx.db.get("endOfDayReports", reportId);
    return report?.tenantId === caller.tenantId &&
      report.userId === caller.userId
      ? report
      : null;
  },
});

export const getDaySummary = query({
  args: { now: v.number(), timeZone: v.optional(v.string()) },
  returns: v.object({
    periodStart: v.number(),
    periodEnd: v.number(),
    timeZone: v.string(),
    previousDayUnclosed: v.boolean(),
    slackChannelId: v.union(v.string(), v.null()),
    slackChannelName: v.union(v.string(), v.null()),
    latestReport: v.union(schema.doc("endOfDayReports"), v.null()),
    numbers: endOfDayNumbersValidator,
    gaps: v.array(endOfDayGapValidator),
  }),
  handler: async (ctx, args) => {
    const caller = await requireTenantUser(ctx, ["closer"]);
    return await getDaySummaryCore(ctx, caller, args);
  },
});

export const retryEndOfDayPost = mutation({
  args: { reportId: v.id("endOfDayReports") },
  returns: schema.doc("endOfDayReports"),
  handler: async (ctx, { reportId }) => {
    const caller = await requireTenantUser(ctx, [
      "closer",
      "tenant_admin",
      "tenant_master",
    ]);
    const report = await ctx.db.get("endOfDayReports", reportId);
    if (
      !report ||
      report.tenantId !== caller.tenantId ||
      (caller.role === "closer" && report.userId !== caller.userId)
    )
      throw rejectRequest(
        "end_day.forbidden",
        "Report not found or not yours.",
      );
    if (
      report.slackStatus === "posted" ||
      (report.slackStatus === "pending" &&
        (report.slackPostStartedAt === undefined ||
          Date.now() - report.slackPostStartedAt < 120_000))
    )
      return report;
    const installation = await ctx.db
      .query("slackInstallations")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", caller.tenantId))
      .first();
    if (installation?.status !== "active" || !installation.eodReportChannelId)
      throw rejectRequest(
        "end_day.no_channel",
        "No end-of-day Slack channel is set.",
      );
    const sameChannel =
      installation.eodReportChannelId === report.slackChannelId;
    await ctx.db.patch("endOfDayReports", reportId, {
      slackStatus: "pending",
      slackError: undefined,
      slackPostStartedAt: undefined,
      slackPostAttempt: undefined,
      slackChannelId: installation.eodReportChannelId,
      slackChannelName: installation.eodReportChannelName,
      ...(!sameChannel && {
        slackThreadTs: undefined,
        slackThreadReportId: undefined,
      }),
    });
    await ctx.scheduler.runAfter(0, internal.slack.eodReports.post, {
      reportId,
    });
    return (await ctx.db.get("endOfDayReports", reportId))!;
  },
});
