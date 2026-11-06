import { describe, expect, it } from "vitest";
import { captureConfirmation, type CaptureResult } from "./capture-confirmation";

// What the Capture page says about the last paste: its status word's kind,
// the title and the detail (docs/plans/respark.md §6.5).

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-05T21:40:00Z");
const TIME_ZONE = "America/Tegucigalpa";

type Person = NonNullable<CaptureResult["person"]>;

function result(overrides: { duplicateRetry?: boolean; duplicateProspect?: boolean; person?: Person }): CaptureResult {
  return {
    submissionId: "submission" as CaptureResult["submissionId"],
    prospectId: "prospect" as CaptureResult["prospectId"],
    leadId: "lead" as CaptureResult["leadId"],
    duplicateRetry: false,
    duplicateProspect: false,
    inactiveAfterDays: 30,
    ...overrides,
  } as CaptureResult;
}

describe("captureConfirmation", () => {
  it("names a new person", () => {
    expect(
      captureConfirmation(
        result({ person: { isNew: true, stage: "in_conversation", disposition: "open" } }),
        NOW,
        TIME_ZONE,
      ),
    ).toEqual({ kind: "new", title: "New prospect captured", detail: "In conversation from now." });
  });

  it("calls a keyed retry already saved", () => {
    expect(captureConfirmation(result({ duplicateRetry: true }), NOW, TIME_ZONE)).toEqual({
      kind: "already_saved",
      title: "Capture already recorded",
    });
  });

  it("calls a person captured before a dupe, and says how long they were inactive", () => {
    expect(
      captureConfirmation(
        result({
          duplicateProspect: true,
          person: { isNew: false, stage: "in_conversation", disposition: "open", lastTouchAt: NOW - 41 * DAY_MS },
        }),
        NOW,
        TIME_ZONE,
      ),
    ).toEqual({
      kind: "dupe",
      title: "Already in the CRM · in conversation",
      detail: "Inactive for 41 days; this capture makes them active again.",
    });
  });

  it("calls a person the CRM knew but nobody captured known, with their call", () => {
    expect(
      captureConfirmation(
        result({
          person: {
            isNew: false,
            stage: "booked",
            disposition: "open",
            nextMeetingAt: Date.parse("2026-11-09T16:00:00Z"),
          },
        }),
        NOW,
        TIME_ZONE,
      ),
    ).toEqual({ kind: "known", title: "Already in the CRM · booked", detail: "Call on 9 Nov." });
  });

  it("says don't contact before anything else", () => {
    expect(
      captureConfirmation(
        result({ duplicateProspect: true, person: { isNew: false, stage: "qualified", disposition: "do_not_contact" } }),
        NOW,
        TIME_ZONE,
      ),
    ).toEqual({ kind: "do_not_contact", title: "Already in the CRM · do not contact", detail: "Don't message them." });
  });

  it("names a not-a-fit person and when a respark marked them", () => {
    expect(
      captureConfirmation(
        result({
          duplicateProspect: true,
          person: {
            isNew: false,
            stage: "in_conversation",
            disposition: "not_a_fit",
            dispositionSource: "respark",
            dispositionSetAt: Date.parse("2026-10-20T18:00:00Z"),
          },
        }),
        NOW,
        TIME_ZONE,
      ),
    ).toEqual({ kind: "not_a_fit", title: "Already in the CRM · not a fit", detail: "Marked in a respark on 20 Oct." });
  });
});
