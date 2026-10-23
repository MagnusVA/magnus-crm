import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import { bookingHarness } from "../../tests/bookingHarness";
import { seedBookingAnswers } from "../../tests/bookingAnswersFixtures";

describe("meeting detail booking answers", () => {
  it("returns each booking's own snapshots in capture time and field key order", async () => {
    const h = await bookingHarness();
    const { first, second } = await h.t.run((ctx) => seedBookingAnswers(ctx, h.tenantId));
    const firstDetail = await h.closer.query(api.closer.meetingDetail.getMeetingDetail, { meetingId: first });
    expect(firstDetail.bookingAnswers).toEqual([
      { fieldKey: "availability", question: "When?", answer: "Monday", capturedAt: 100 },
      { fieldKey: "budget", question: "Budget?", answer: "100", capturedAt: 100 },
      { fieldKey: "goal", question: "Original goal?", answer: "First booking goal", capturedAt: 200 },
    ]);
    const secondDetail = await h.admin.query(api.closer.meetingDetail.getMeetingDetail, { meetingId: second });
    expect(secondDetail.bookingAnswers).toEqual([
      { fieldKey: "goal", question: "New goal?", answer: "Second booking goal", capturedAt: 300 },
    ]);
  });

  it("ignores a response owned by another tenant even when its meeting ID matches", async () => {
    const h = await bookingHarness();
    const { first } = await h.t.run((ctx) => seedBookingAnswers(ctx, h.tenantId));
    const detail = await h.admin.query(api.closer.meetingDetail.getMeetingDetail, { meetingId: first });
    expect(detail.bookingAnswers.map(({ fieldKey }) => fieldKey)).toEqual(["availability", "budget", "goal"]);
  });

  it("returns no answers for a booking without responses, even when the person has answers", async () => {
    const h = await bookingHarness();
    const { empty } = await h.t.run((ctx) => seedBookingAnswers(ctx, h.tenantId));
    const detail = await h.admin.query(api.closer.meetingDetail.getMeetingDetail, { meetingId: empty });
    expect(detail.lead.customFields).toEqual({ goal: "Latest person answer" });
    expect(detail.bookingAnswers).toEqual([]);
  });
});
