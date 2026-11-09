import type { CallsSummary } from "../../reports/calls";
import { addCounts, mergeRows } from "./helpers";

export function mergeCallsSummary(
  history: CallsSummary,
  today: CallsSummary,
): CallsSummary {
  const owed = mergeRows(
    history.owed,
    today.owed,
    (r) => r.meetingId,
    (_a, b) => b,
  )
    .sort(
      (a, b) =>
        a.scheduledAt - b.scheduledAt || a.meetingId.localeCompare(b.meetingId),
    )
    .slice(0, 200);
  return {
    counts: addCounts(history.counts, today.counts),
    byType: {
      new: addCounts(history.byType.new, today.byType.new),
      follow_up: addCounts(history.byType.follow_up, today.byType.follow_up),
    },
    leadTime: mergeRows(
      history.leadTime,
      today.leadTime,
      (r) => r.bucket,
      (a, b) => ({
        bucket: b.bucket,
        held: a.held + b.held,
        noShow: a.noShow + b.noShow,
        notRecorded: a.notRecorded + b.notRecorded,
      }),
    ),
    noShowMarkers: addCounts(history.noShowMarkers, today.noShowMarkers),
    noShowReasons: mergeRows(
      history.noShowReasons,
      today.noShowReasons,
      (r) => r.reason,
      (a, b) => ({ reason: b.reason, count: a.count + b.count }),
    ).sort((a, b) => a.reason.localeCompare(b.reason)),
    mode: {
      priority: addCounts(history.mode.priority, today.mode.priority),
      standard: addCounts(history.mode.standard, today.mode.standard),
    },
    recordMinutes: [...history.recordMinutes, ...today.recordMinutes],
    byDay: mergeRows(
      history.byDay,
      today.byDay,
      (r) => r.dayKey,
      (a, b) => ({
        dayKey: b.dayKey,
        held: a.held + b.held,
        noShow: a.noShow + b.noShow,
        notRecorded: a.notRecorded + b.notRecorded,
        canceled: a.canceled + b.canceled,
        moved: a.moved + b.moved,
      }),
    ).sort((a, b) => a.dayKey.localeCompare(b.dayKey)),
    owed,
    owedTotal: history.owedTotal + today.owedTotal,
    partial: history.partial || today.partial,
  };
}
