import type { NoShowTier } from "../../../lib/callInsights/taxonomy";
import type {
  AttendanceEvidence,
  AttendanceMeasures,
  EarlyReading,
} from "../validators";

export const NO_SHOW_NOTE_CODES = [
  "ineligible",
  "slot_not_over",
  "not_sales_call",
  "empty_recording",
  "no_no_show_proposed",
  "recorder_differs",
  "someone_spoke",
  "someone_there",
  "second_person",
  "answer_like_pairs",
  "other_recording",
  "newer_booking",
  "models_disagree",
  "no_waiting_quote",
  "no_leaving_quote",
  "wait_not_met",
  "wait_unset",
  "weak_match",
  "jev_missing",
  "jev_low_confidence",
  "claude_not_absent",
  "not_closer_only",
  "late_start",
  "long_recording",
  "too_many_words",
  "too_many_lines",
  "no_long_gap",
  "trace_incomplete",
  "slot_recently_ended",
] as const;

export function noShowTier(a: {
  eligible: boolean;
  now: number;
  measures: AttendanceMeasures;
  attendance?: AttendanceEvidence;
  jev?: EarlyReading["attendance"];
  waitMinutes?: number;
}): { tier: NoShowTier; notes: string[] } {
  const m = a.measures;
  const evidence = a.attendance;
  const readings = [a.jev?.withSummary, a.jev?.withoutSummary];
  if (!a.eligible) return { tier: "none", notes: ["ineligible"] };
  if (a.now < m.slotEndedAt) return { tier: "none", notes: ["slot_not_over"] };
  if (
    evidence?.notSalesCall.length ||
    readings.some((reading) => reading?.choice === "not_sales_call")
  ) {
    return { tier: "none", notes: ["not_sales_call"] };
  }
  if (m.lineCount === 0 && m.endOffsetSeconds >= 300) {
    return { tier: "empty", notes: ["empty_recording"] };
  }
  const proposed =
    evidence?.reading === "absent" ||
    readings.some((reading) => reading?.choice === "no_show");
  if (!proposed) return { tier: "none", notes: ["no_no_show_proposed"] };

  const contradictions: string[] = [];
  const opposes = readings.some(
    (reading) => reading?.choice === "held" && (reading.confidence ?? 0) >= 0.6,
  );
  if (
    opposes ||
    (evidence?.reading === "present" &&
      readings.some(
        (reading) =>
          reading?.choice === "no_show" && (reading.confidence ?? 0) >= 0.6,
      ))
  )
    contradictions.push("models_disagree");
  if (evidence?.someoneThere.length) contradictions.push("someone_there");
  if (evidence?.secondPerson.length) contradictions.push("second_person");
  if (m.answerLikePairs >= 2) contradictions.push("answer_like_pairs");
  if (m.otherLines > 0 && !m.otherIsOneShortUnknown)
    contradictions.push("someone_spoke");
  if (m.otherRecordingsWithLines > 0) contradictions.push("other_recording");
  if (m.newerBooking) contradictions.push("newer_booking");
  if (!m.recorderIsAssignedCloser) contradictions.push("recorder_differs");
  if (contradictions.length) return { tier: "check", notes: contradictions };

  const notes: string[] = [];
  const bothNoShow = readings.every((reading) => reading?.choice === "no_show");
  const confidence = Math.min(
    ...readings.map((reading) => reading?.confidence ?? 0),
  );
  if (readings.some((reading) => !reading || reading.confidence === undefined))
    notes.push("jev_missing");
  if (!bothNoShow && readings.every(Boolean)) notes.push("models_disagree");
  if (confidence < 0.9) notes.push("jev_low_confidence");
  if (evidence?.reading !== "absent") notes.push("claude_not_absent");
  if (!m.closerOnly) notes.push("not_closer_only");
  if (m.answerLikePairs > 0) notes.push("answer_like_pairs");
  if (m.startOffsetSeconds > 180) notes.push("late_start");
  if (a.waitMinutes === undefined) notes.push("wait_unset");
  else if (m.endOffsetSeconds < a.waitMinutes * 60) notes.push("wait_not_met");
  if (m.lengthSeconds >= 5_400) notes.push("long_recording");
  if (m.closerWordsAfterStart > 250) notes.push("too_many_words");
  if (m.closerLinesAfterStart > 25) notes.push("too_many_lines");
  if (m.longestGapSeconds < 120) notes.push("no_long_gap");
  if (!m.matchStrong) notes.push("weak_match");
  if (m.otherRecordingsAny > 0) notes.push("other_recording");
  if (!m.traceCoversWindow) notes.push("trace_incomplete");
  if (
    !evidence?.waiting.some(
      (quote) => quote.atSeconds + m.startOffsetSeconds >= 300,
    )
  )
    notes.push("no_waiting_quote");
  if (
    !evidence?.leaving.some(
      (quote) =>
        quote.atSeconds >= m.lengthSeconds - 120 &&
        quote.atSeconds <= m.lengthSeconds,
    )
  ) {
    notes.push("no_leaving_quote");
  }
  if (a.now < m.slotEndedAt + 3_600_000) notes.push("slot_recently_ended");
  if (bothNoShow && notes.length === 0) return { tier: "certain", notes };
  if (
    evidence?.reading === "absent" &&
    bothNoShow &&
    confidence >= 0.8 &&
    (m.closerOnly || m.otherIsOneShortUnknown)
  )
    return { tier: "review", notes };
  return { tier: "unconfirmed", notes };
}

export function shadowTiers(
  a: Omit<Parameters<typeof noShowTier>[0], "waitMinutes">,
): {
  wait5: NoShowTier;
  wait7: NoShowTier;
  wait10: NoShowTier;
} {
  return {
    wait5: noShowTier({ ...a, waitMinutes: 5 }).tier,
    wait7: noShowTier({ ...a, waitMinutes: 7 }).tier,
    wait10: noShowTier({ ...a, waitMinutes: 10 }).tier,
  };
}
