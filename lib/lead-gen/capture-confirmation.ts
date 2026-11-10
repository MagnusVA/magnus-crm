// Relative imports: the agent's capture tool in convex/ reads this file too,
// and Convex's bundler doesn't resolve the "@/" alias.
import type { SubmitCaptureResult } from "../../convex/leadGen/capture";
import {
  LIFECYCLE_STAGE_LABELS,
  stageIndex,
} from "../../convex/leads/lifecycle";

export type CaptureResult = SubmitCaptureResult;

/**
 * What the last capture was, for its status word: a new person, a capture of
 * someone captured before (a dupe), a person the CRM knew but nobody had
 * captured, a known person who is not a fit or must not be contacted, or a
 * keyed retry the server had already saved.
 */
export type CaptureKind = "new" | "dupe" | "known" | "not_a_fit" | "do_not_contact" | "already_saved";

export type CaptureConfirmation = { kind: CaptureKind; title: string; detail?: string };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What the CRM knew about the person before the capture
 * (docs/plans/respark.md §6.5). `timeZone` is the tenant's business day zone.
 */
export function captureConfirmation(
  result: CaptureResult,
  now: number,
  timeZone: string,
): CaptureConfirmation {
  const person = result.person;
  if (result.duplicateRetry || !person) {
    // A keyed retry: the original capture already counted, and where the
    // person stood before it is gone.
    return { kind: "already_saved", title: "Capture already recorded" };
  }
  if (person.isNew) {
    return { kind: "new", title: "New prospect captured", detail: "In conversation from now." };
  }

  const formatDate = (ms: number) =>
    new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone }).format(ms);

  if (person.disposition === "do_not_contact") {
    return { kind: "do_not_contact", title: "Already in the CRM · do not contact", detail: "Don't message them." };
  }

  if (person.disposition === "not_a_fit") {
    return {
      kind: "not_a_fit",
      title: "Already in the CRM · not a fit",
      detail:
        person.dispositionSource === "respark" && person.dispositionSetAt !== undefined
          ? `Marked in a respark on ${formatDate(person.dispositionSetAt)}.`
          : undefined,
    };
  }

  const kind: CaptureKind = result.duplicateProspect ? "dupe" : "known";
  if (stageIndex(person.stage) >= stageIndex("qualified")) {
    return {
      kind,
      title: `Already in the CRM · ${LIFECYCLE_STAGE_LABELS[person.stage].toLowerCase()}`,
      detail:
        person.nextMeetingAt !== undefined
          ? `Call on ${formatDate(person.nextMeetingAt)}.`
          : undefined,
    };
  }

  const inactiveDays =
    person.lastTouchAt === undefined
      ? undefined
      : Math.floor((now - person.lastTouchAt) / DAY_MS);
  return {
    kind,
    title: `Already in the CRM · ${LIFECYCLE_STAGE_LABELS[person.stage].toLowerCase()}`,
    detail:
      inactiveDays !== undefined && inactiveDays >= result.inactiveAfterDays
        ? `Inactive for ${inactiveDays} days; this capture makes them active again.`
        : undefined,
  };
}
