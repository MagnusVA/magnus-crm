import type { getActivitySummary } from "../../reporting/activityFeed";
import type { ReaderOutput } from "../definition";
import { addCounts, mergeRows } from "./helpers";

type ActivitySummary = ReaderOutput<typeof getActivitySummary>;

export function mergeActivitySummary(
  history: ActivitySummary,
  today: ActivitySummary,
): ActivitySummary {
  return {
    totalEvents: history.totalEvents + today.totalEvents,
    bySource: addCounts(history.bySource, today.bySource),
    byEntity: addCounts(history.byEntity, today.byEntity),
    byActor: addCounts(history.byActor, today.byActor),
    byEventType: addCounts(history.byEventType, today.byEventType),
    byOutcome: addCounts(history.byOutcome, today.byOutcome),
    actorBreakdown: mergeRows(
      history.actorBreakdown,
      today.actorBreakdown,
      (actor) => actor.actorUserId,
      (past, current) => ({ ...current, count: past.count + current.count }),
    ).sort((left, right) => right.count - left.count),
    isTruncated: history.isTruncated || today.isTruncated,
  };
}
