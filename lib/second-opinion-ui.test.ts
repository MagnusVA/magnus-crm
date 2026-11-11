// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpinionDetail } from "@/components/second-opinion/presentation";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

const fixture = vi.hoisted(() => ({
  detail: null as OpinionDetail | null,
  settings: undefined as
    FunctionReturnType<typeof api.secondOpinion.getSettings> | undefined,
}));
vi.mock("convex/react", () => ({
  useQuery: (reference: Parameters<typeof getFunctionName>[0]) =>
    getFunctionName(reference) === "secondOpinion:getSettings"
      ? fixture.settings
      : fixture.detail,
  useMutation: () => async () => null,
}));
import { SecondOpinionCard } from "@/components/second-opinion/meeting-card";
import { SecondOpinionHint } from "@/components/second-opinion/needs-outcome-hint";
import { SecondOpinionSettingsRow } from "@/components/second-opinion/settings-row";
import { TooltipProvider } from "@/components/ui/tooltip";
const meetingId = "meeting" as Id<"meetings">;
const now = Date.parse("2026-11-03T18:00Z");
function detail(): OpinionDetail {
  return {
    opinion: {
      _id: "opinion" as Id<"secondOpinions">,
      _creationTime: now,
      tenantId: "tenant" as Id<"tenants">,
      meetingId,
      recordingId: "recording" as Id<"callRecordings">,
      closerUserId: "closer" as Id<"users">,
      trigger: "result_recorded",
      record: { kind: "no_show" },
      inputKey: "meeting:recording",
      model: "typesafe/jev-1.13",
      status: "answered",
      attempts: 1,
      createdAt: now,
      answeredAt: now,
      answers: {
        attendance: { choice: "held", confidence: 0.96 },
        ending: { choice: "call_back", confidence: 0.81 },
        objection: { choice: "partner", confidence: 0.71 },
        claim: 0.03,
      },
      verdict: "disagrees",
      reviewState: "open",
      evidence: {
        recordedMinutes: 34,
        closerMinutes: 12,
        prospectMinutes: 11,
        prospectFirstAt: now,
        talkPattern: "cccqqppp",
      },
    },
    reviewer: undefined,
    recordingUrl: undefined,
    summary: undefined,
    person: "Grace",
    closer: "Kim",
    program: "Scale",
    scheduledAt: now,
    canAddNote: false,
    canReview: false,
    canReopen: false,
    canRerun: false,
    actionItems: [],
    timeZone: "America/Tegucigalpa",
    callbackTimeZone: "America/Tegucigalpa",
  };
}
function settingsRow(fathomConnected = true) {
  return renderToStaticMarkup(
    createElement(TooltipProvider, null, createElement(SecondOpinionSettingsRow, { fathomConnected })),
  );
}
beforeEach(() => {
  fixture.detail = detail();
  fixture.settings = undefined;
});
describe("second opinion UI", () => {
  it("renders the four labelled answers, disagreement evidence and reassurance", () => {
    const html = renderToStaticMarkup(
      createElement(SecondOpinionCard, { meetingId }),
    );
    for (const text of [
      "Second opinion",
      "Disagrees",
      "Attendance",
      "How it ended",
      "Main objection",
      "Your record",
      "96%",
      "81%",
      "71%",
      "3%",
      "Who spoke, minute by minute",
      "Grace speaks for 11",
      "From the recording. It never changes your record.",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("Add a note for the admin");
  });
  it("renders the note field only when the backend allows it", () => {
    fixture.detail!.canAddNote = true;
    expect(
      renderToStaticMarkup(createElement(SecondOpinionCard, { meetingId })),
    ).toContain("Add a note for the admin");
  });
  it("renders checked attribution and a sent closer note", () => {
    fixture.detail!.opinion.reviewState = "checked";
    fixture.detail!.opinion.review = {
      outcome: "second_opinion_right",
      byUserId: "admin" as Id<"users">,
      at: now,
      reopened: true,
    };
    fixture.detail!.reviewer = "Jordan";
    fixture.detail!.opinion.closerNote = "I waited ten minutes.";
    fixture.detail!.opinion.closerNoteAt = now;
    const html = renderToStaticMarkup(
      createElement(SecondOpinionCard, { meetingId }),
    );
    expect(html).toContain("Checked by Jordan");
    expect(html).toContain("the second opinion was right");
    expect(html).toContain("Sent to admins");
  });
  it("renders no card or hint when the backend hides the check", () => {
    fixture.detail = null;
    expect(
      renderToStaticMarkup(createElement(SecondOpinionCard, { meetingId })),
    ).toBe("");
    expect(
      renderToStaticMarkup(createElement(SecondOpinionHint, { meetingId })),
    ).toBe("");
  });
  it("shows the day-close hint in Needs outcome", () => {
    fixture.detail!.opinion.verdict = "hint";
    expect(
      renderToStaticMarkup(createElement(SecondOpinionHint, { meetingId })),
    ).toContain("Second opinion · held, ended in call-back · 81%");
  });
  it("shows cap pause and the owner's raise-cap control", () => {
    fixture.settings = {
      mode: "shadow",
      shadowDay: 14,
      monthlyCapUsd: 40,
      readyToOpen: true,
      paused: true,
      resetsAt: Date.parse("2026-12-01T00:00Z"),
      canManage: true,
      visible: true,
      month: {
        costUsd: 40,
        total: 38,
        answered: 38,
        agrees: 35,
        disagrees: 1,
        unsure: 2,
        hints: 0,
        checked: 0,
        failed: 0,
        capped: false,
      },
    };
    const html = settingsRow();
    for (const text of [
      "Shadow run, day",
      "Only owners and admins see results",
      "$40.00",
      "monthly cap is reached",
      "Checks resume on 1 Dec",
      "Raise cap",
      "Open results",
    ])
      expect(html).toContain(text);
  });
  it("shows a disabled switch without owner controls to admins", () => {
    fixture.settings = {
      mode: "shadow",
      shadowDay: 1,
      monthlyCapUsd: 40,
      readyToOpen: false,
      paused: false,
      resetsAt: now,
      canManage: false,
      visible: false,
      month: {
        costUsd: 0,
        total: 0,
        answered: 0,
        agrees: 0,
        disagrees: 0,
        unsure: 0,
        hints: 0,
        checked: 0,
        failed: 0,
        capped: false,
      },
    };
    const html = settingsRow();
    expect(html).toContain("disabled");
    expect(html).toContain("Only an owner");
    expect(html).not.toContain("Change cap");
  });
  it("hides the section while Fathom isn't connected, unless it is still on", () => {
    fixture.settings = {
      mode: "off",
      shadowDay: 0,
      monthlyCapUsd: 40,
      readyToOpen: false,
      paused: false,
      resetsAt: now,
      canManage: true,
      visible: false,
      month: {
        costUsd: 0,
        total: 0,
        answered: 0,
        agrees: 0,
        disagrees: 0,
        unsure: 0,
        hints: 0,
        checked: 0,
        failed: 0,
        capped: false,
      },
    };
    expect(settingsRow(false)).toBe("");
    expect(settingsRow(true)).toContain("Second opinion");
    fixture.settings = { ...fixture.settings, mode: "on" };
    expect(settingsRow(false)).toContain("Second opinion on recorded calls");
  });
});
