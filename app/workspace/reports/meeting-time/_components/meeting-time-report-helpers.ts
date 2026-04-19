import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";

export type MeetingTimeMetrics = FunctionReturnType<
  typeof api.reporting.meetingTime.getMeetingTimeMetrics
>;
export type MeetingTimeTotals = MeetingTimeMetrics["totals"];
export type FathomCompliance = MeetingTimeMetrics["fathomCompliance"];
export type HistogramCounts = MeetingTimeMetrics["lateStartHistogram"];
export type StartedAtSourceCounts = MeetingTimeMetrics["startedAtSource"];
export type StoppedAtSourceCounts = MeetingTimeMetrics["stoppedAtSource"];
export type NoShowSourceCounts = MeetingTimeMetrics["noShowSource"];

export function formatRate(rate: number | null): string {
  if (rate === null) {
    return "\u2014";
  }

  return `${(rate * 100).toFixed(1)}%`;
}

export function formatDuration(durationMs: number | null): string {
  if (durationMs === null) {
    return "\u2014";
  }

  const totalMinutes = Math.round(durationMs / 60_000);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

export function sumCounts(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}
