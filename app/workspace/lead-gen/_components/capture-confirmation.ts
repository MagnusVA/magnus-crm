import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import {
  LIFECYCLE_STAGE_LABELS,
  stageIndex,
} from "@/convex/leads/lifecycle";

export type CaptureResult = FunctionReturnType<typeof api.leadGen.capture.submit>;

export type CaptureConfirmation = { title: string; detail?: string };

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
    return { title: "Capture already recorded" };
  }
  if (person.isNew) {
    return { title: "New prospect captured", detail: "In conversation from now." };
  }

  const formatDate = (ms: number) =>
    new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone }).format(ms);

  if (person.disposition === "do_not_contact") {
    return { title: "Already in the CRM · do not contact", detail: "Don't message them." };
  }

  if (person.disposition === "not_a_fit") {
    return {
      title: "Already in the CRM · not a fit",
      detail:
        person.dispositionSource === "respark" && person.dispositionSetAt !== undefined
          ? `Marked in a respark on ${formatDate(person.dispositionSetAt)}.`
          : undefined,
    };
  }

  if (stageIndex(person.stage) >= stageIndex("qualified")) {
    return {
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
    title: `Already in the CRM · ${LIFECYCLE_STAGE_LABELS[person.stage].toLowerCase()}`,
    detail:
      inactiveDays !== undefined && inactiveDays >= result.inactiveAfterDays
        ? `Inactive for ${inactiveDays} days; this capture makes them active again.`
        : undefined,
  };
}
