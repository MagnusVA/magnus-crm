import { describe, expect, it } from "vitest";
import type { Id } from "../_generated/dataModel";
import {
  MEETING_STATUSES,
  MEETING_TRANSITION_EXCEPTIONS,
  validateAutomationHeldUndone,
  validateMeetingTransition,
} from "./statusTransitions";

const DECISION = "1;resultAutomationDecisions" as Id<"resultAutomationDecisions">;
const OTHER_DECISION = "2;resultAutomationDecisions" as Id<"resultAutomationDecisions">;

const markedByCall = {
  meeting: { status: "held", attendanceSource: "call_insights", attendanceDecisionId: DECISION },
  decisionId: DECISION,
  humanResultRevision: 3,
  humanResultRevisionAfter: 3,
} as const;

describe("automation_held_undone", () => {
  it("is the one named meeting exception, held back to scheduled", () => {
    expect(MEETING_TRANSITION_EXCEPTIONS).toEqual({ automation_held_undone: { from: "held", to: "scheduled" } });
  });

  it("leaves held terminal in the ordinary machine", () => {
    for (const target of MEETING_STATUSES) expect(validateMeetingTransition("held", target)).toBe(false);
  });

  it("allows the undo of a held mark its decision wrote, with nothing recorded since", () => {
    expect(validateAutomationHeldUndone(markedByCall)).toBe(true);
  });

  it("requires the meeting to carry this decision's attendanceDecisionId", () => {
    expect(validateAutomationHeldUndone({
      ...markedByCall, meeting: { ...markedByCall.meeting, attendanceDecisionId: undefined },
    })).toBe(false);
    expect(validateAutomationHeldUndone({ ...markedByCall, decisionId: OTHER_DECISION })).toBe(false);
  });

  it("refuses a held mark a person recorded", () => {
    expect(validateAutomationHeldUndone({
      ...markedByCall, meeting: { status: "held", attendanceSource: undefined, attendanceDecisionId: undefined },
    })).toBe(false);
  });

  it("refuses once a later result was recorded on the deal", () => {
    expect(validateAutomationHeldUndone({ ...markedByCall, humanResultRevision: 4 })).toBe(false);
    expect(validateAutomationHeldUndone({ ...markedByCall, humanResultRevisionAfter: undefined })).toBe(false);
  });

  it.each(["scheduled", "no_show", "canceled"] as const)("refuses a %s meeting", (status) => {
    expect(validateAutomationHeldUndone({ ...markedByCall, meeting: { ...markedByCall.meeting, status } })).toBe(false);
  });
});
