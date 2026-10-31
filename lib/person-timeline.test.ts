import { describe, expect, it } from "vitest";
import { isShownOnTimeline, timelineSentence, type TimelineEntryFacts } from "./person-timeline";

function entry(overrides: Partial<TimelineEntryFacts>): TimelineEntryFacts {
  return {
    eventType: "unknown",
    label: "Something happened",
    actorName: null,
    fromStatus: null,
    toStatus: null,
    detail: null,
    opportunityId: "deal1",
    amount: null,
    callAt: null,
    task: null,
    ...overrides,
  };
}

const programOf = (id: string) => (id === "deal1" ? "TestProgram" : null);
const dayOf = () => "Oct 10";
const say = (overrides: Partial<TimelineEntryFacts>) => timelineSentence(entry(overrides), programOf, dayOf);

describe("timelineSentence", () => {
  it("writes a won deal stage as Won and the program", () => {
    expect(say({ eventType: "opportunity.stage_changed", fromStatus: "Follow-up", toStatus: "Closed (won)" })).toEqual({
      fact: "Won TestProgram",
      figure: null,
      subject: null,
    });
  });

  it("gives a payment its amount and no transition", () => {
    expect(
      say({
        eventType: "payment.recorded",
        label: "Payment recorded",
        toStatus: "recorded",
        amount: { amountMinor: 200_000, currency: "USD" },
      }),
    ).toEqual({ fact: "Payment recorded", figure: "$2,000", subject: null });
  });

  it("names the call of a no-show by its program and day", () => {
    expect(say({ eventType: "meeting.no_show", callAt: 1, fromStatus: "scheduled", toStatus: "no_show" })).toEqual({
      fact: "No-show",
      figure: null,
      subject: "TestProgram call Oct 10",
    });
  });

  it("tells a reschedule link from a call-back task", () => {
    const link = { type: "scheduling_link" as const, reschedule: true, method: null };
    const reminder = { type: "manual_reminder" as const, reschedule: false, method: "call" as const };
    expect(say({ eventType: "followUp.created", task: link }).fact).toBe("Reschedule link sent");
    expect(say({ eventType: "followUp.created", task: reminder })).toMatchObject({
      fact: "Call-back task set",
      subject: "TestProgram",
    });
  });

  it("says who captured the person and when the person became a customer", () => {
    expect(say({ eventType: "lead.captured", label: "Captured by lead gen", actorName: "Maria Acosta", opportunityId: null }))
      .toMatchObject({ fact: "Captured by lead gen", subject: "Maria Acosta" });
    expect(say({ eventType: "lead.lifecycle_stage_changed", fromStatus: "Showed", toStatus: "Customer" }).fact).toBe(
      "Became a customer",
    );
    expect(say({ eventType: "lead.lifecycle_stage_changed", fromStatus: "Showed", toStatus: "Booked" }).fact).toBe(
      "Moved back to Booked",
    );
  });

  it("leaves out the old lead status, which repeats the stage", () => {
    expect(isShownOnTimeline({ eventType: "lead.status_changed" })).toBe(false);
    expect(isShownOnTimeline({ eventType: "lead.lifecycle_stage_changed" })).toBe(true);
  });
});
