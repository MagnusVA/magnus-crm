import type {
  getPipelineBacklogAndLoss,
  getSchedulingShowRateByOperationsDimensions,
} from "../../reporting/pipelineHealth";
import type { ReaderOutput } from "../definition";
import { addCounts, mergeRows, rate } from "./helpers";

type PipelineBacklogAndLoss = ReaderOutput<typeof getPipelineBacklogAndLoss>;
type SchedulingShowRate = ReaderOutput<typeof getSchedulingShowRateByOperationsDimensions>;

export function mergePipelineBacklogAndLoss(
  history: PipelineBacklogAndLoss,
  today: PipelineBacklogAndLoss,
): PipelineBacklogAndLoss {
  return {
    // The reminder backlog and its truncation are current state, independent
    // of the selected range, so they come from today's answer.
    ...today,
    noShowSourceSplit: addCounts(history.noShowSourceSplit, today.noShowSourceSplit),
    lossAttribution: {
      admin: history.lossAttribution.admin + today.lossAttribution.admin,
      closer: history.lossAttribution.closer + today.lossAttribution.closer,
      unknown: history.lossAttribution.unknown + today.lossAttribution.unknown,
      byActor: mergeRows(
        history.lossAttribution.byActor,
        today.lossAttribution.byActor,
        (row) => row.userId,
        (past, current) => ({ ...current, count: past.count + current.count }),
      ).sort(
        (left, right) => right.count - left.count || left.actorName.localeCompare(right.actorName),
      ),
    },
    isNoShowSourceTruncated: history.isNoShowSourceTruncated || today.isNoShowSourceTruncated,
    isLossAttributionTruncated:
      history.isLossAttributionTruncated || today.isLossAttributionTruncated,
  };
}

export function mergeSchedulingShowRate(
  history: SchedulingShowRate,
  today: SchedulingShowRate,
): SchedulingShowRate {
  const shown = history.shown + today.shown;
  const noShows = history.noShows + today.noShows;
  return {
    scheduled: history.scheduled + today.scheduled,
    shown,
    canceled: history.canceled + today.canceled,
    noShows,
    resultsRecorded: history.resultsRecorded + today.resultsRecorded,
    pastCalls: history.pastCalls + today.pastCalls,
    showRate: rate(shown, shown + noShows),
    noShowRate: rate(noShows, shown + noShows),
    attendanceCountsPartial: history.attendanceCountsPartial || today.attendanceCountsPartial,
    truncated: history.truncated || today.truncated,
  };
}
