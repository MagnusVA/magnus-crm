import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { assertValidDateRange } from "./lib/helpers";

const MAX_MEETINGS_SCAN = 2000;

const HISTOGRAM_BUCKETS = ["0", "1-5", "6-15", "16-30", "30+"] as const;

type HistogramBucket = (typeof HISTOGRAM_BUCKETS)[number];
type BucketCounts = Record<HistogramBucket, number>;
type StartedAtSource = "closer" | "admin_manual" | "none";
type StoppedAtSource =
  | "closer"
  | "closer_no_show"
  | "admin_manual"
  | "system"
  | "none";
type NoShowSource = "closer" | "calendly_webhook" | "none";
type SourceCounts<TKey extends string> = Record<TKey, number>;

function emptyBuckets(): BucketCounts {
  return { "0": 0, "1-5": 0, "6-15": 0, "16-30": 0, "30+": 0 };
}

function emptyStartedAtSource(): SourceCounts<StartedAtSource> {
  return { closer: 0, admin_manual: 0, none: 0 };
}

function emptyStoppedAtSource(): SourceCounts<StoppedAtSource> {
  return {
    closer: 0,
    closer_no_show: 0,
    admin_manual: 0,
    system: 0,
    none: 0,
  };
}

function emptyNoShowSource(): SourceCounts<NoShowSource> {
  return { closer: 0, calendly_webhook: 0, none: 0 };
}

/**
 * Durations are bucketed by whole minutes to avoid boundary jitter from
 * second-level timing noise.
 */
function bucketFor(durationMs: number): HistogramBucket {
  const minutes = Math.floor(Math.max(0, durationMs) / 60_000);
  if (minutes === 0) return "0";
  if (minutes <= 5) return "1-5";
  if (minutes <= 15) return "6-15";
  if (minutes <= 30) return "16-30";
  return "30+";
}

function toRate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function toStartedAtSource(
  source: Doc<"meetings">["startedAtSource"],
): StartedAtSource {
  switch (source) {
    case "closer":
      return "closer";
    case "admin_manual":
      return "admin_manual";
    case undefined:
      return "none";
  }
}

function toStoppedAtSource(
  source: Doc<"meetings">["stoppedAtSource"],
): StoppedAtSource {
  switch (source) {
    case "closer":
      return "closer";
    case "closer_no_show":
      return "closer_no_show";
    case "admin_manual":
      return "admin_manual";
    case "system":
      return "system";
    case undefined:
      return "none";
  }
}

function toNoShowSource(source: Doc<"meetings">["noShowSource"]): NoShowSource {
  switch (source) {
    case "closer":
      return "closer";
    case "calendly_webhook":
      return "calendly_webhook";
    case undefined:
      return "none";
  }
}

function hasFathomLink(meeting: Pick<Doc<"meetings">, "fathomLink">) {
  return (
    typeof meeting.fathomLink === "string" &&
    meeting.fathomLink.trim().length > 0
  );
}

export const getMeetingTimeMetrics = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, { startDate, endDate }) => {
    assertValidDateRange(startDate, endDate);

    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const meetingRows = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_scheduledAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .gte("scheduledAt", startDate)
          .lt("scheduledAt", endDate),
      )
      .take(MAX_MEETINGS_SCAN + 1);
    const meetings = meetingRows.slice(0, MAX_MEETINGS_SCAN);
    const isTruncated = meetingRows.length > MAX_MEETINGS_SCAN;

    let startedMeetingsCount = 0;
    let onTimeStartCount = 0;
    let lateStartCount = 0;
    let totalLateStartMs = 0;
    let completedWithDurationCount = 0;
    let overranCount = 0;
    let totalOverrunMs = 0;
    let totalActualDurationMs = 0;
    let scheduleAdherentCount = 0;
    let manuallyCorrectedCount = 0;
    let evidenceRequired = 0;
    let evidenceProvided = 0;

    const startedAtSource = emptyStartedAtSource();
    const stoppedAtSource = emptyStoppedAtSource();
    const noShowSource = emptyNoShowSource();
    const lateStartHistogram = emptyBuckets();
    const overrunHistogram = emptyBuckets();

    for (const meeting of meetings) {
      const lateStartDurationMs = Math.max(0, meeting.lateStartDurationMs ?? 0);
      const exceededScheduledDurationMs = Math.max(
        0,
        meeting.exceededScheduledDurationMs ?? 0,
      );

      startedAtSource[toStartedAtSource(meeting.startedAtSource)] += 1;
      stoppedAtSource[toStoppedAtSource(meeting.stoppedAtSource)] += 1;
      noShowSource[toNoShowSource(meeting.noShowSource)] += 1;

      if (
        meeting.startedAtSource === "admin_manual" ||
        meeting.stoppedAtSource === "admin_manual"
      ) {
        manuallyCorrectedCount += 1;
      }

      if (
        meeting.status === "completed" ||
        meeting.status === "meeting_overran"
      ) {
        evidenceRequired += 1;
        if (hasFathomLink(meeting)) {
          evidenceProvided += 1;
        }
      }

      if (meeting.startedAt !== undefined) {
        startedMeetingsCount += 1;
        if (lateStartDurationMs === 0) {
          onTimeStartCount += 1;
        } else {
          lateStartCount += 1;
          totalLateStartMs += lateStartDurationMs;
        }
        lateStartHistogram[bucketFor(lateStartDurationMs)] += 1;
      }

      if (meeting.startedAt !== undefined && meeting.stoppedAt !== undefined) {
        completedWithDurationCount += 1;

        const actualDurationMs = Math.max(0, meeting.stoppedAt - meeting.startedAt);
        totalActualDurationMs += actualDurationMs;

        if (exceededScheduledDurationMs === 0) {
          if (lateStartDurationMs === 0) {
            scheduleAdherentCount += 1;
          }
        } else {
          overranCount += 1;
          totalOverrunMs += exceededScheduledDurationMs;
        }

        overrunHistogram[bucketFor(exceededScheduledDurationMs)] += 1;
      }
    }

    return {
      totals: {
        startedMeetingsCount,
        onTimeStartCount,
        lateStartCount,
        completedWithDurationCount,
        overranCount,
        manuallyCorrectedCount,
        onTimeStartRate: toRate(onTimeStartCount, startedMeetingsCount),
        avgLateStartMs: toRate(totalLateStartMs, lateStartCount),
        overranRate: toRate(overranCount, completedWithDurationCount),
        avgOverrunMs: toRate(totalOverrunMs, overranCount),
        avgActualDurationMs: toRate(
          totalActualDurationMs,
          completedWithDurationCount,
        ),
        scheduleAdherenceRate: toRate(
          scheduleAdherentCount,
          completedWithDurationCount,
        ),
      },
      startedAtSource,
      stoppedAtSource,
      noShowSource,
      lateStartHistogram,
      overrunHistogram,
      fathomCompliance: {
        required: evidenceRequired,
        provided: evidenceProvided,
        rate: toRate(evidenceProvided, evidenceRequired),
      },
      isTruncated,
    };
  },
});
