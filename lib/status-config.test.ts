import { describe, expect, it } from "vitest";
import { meetingAttendanceDisplay, meetingEventStatusLabel, meetingStatusConfig } from "./status-config";

const meeting = {
  status: "scheduled" as const,
  scheduledAt: 1_000_000,
  durationMinutes: 30,
};
const end = meeting.scheduledAt + 30 * 60_000;

describe("meetingAttendanceDisplay", () => {
  it.each([meeting.scheduledAt - 1, meeting.scheduledAt, end - 1])(
    "keeps a scheduled call until its end time (%s)",
    (now) => expect(meetingAttendanceDisplay(meeting, now)).toBe("scheduled"),
  );
  it.each([end, end + 1])(
    "shows Not recorded at or after the end (%s)",
    (now) => {
      expect(meetingAttendanceDisplay(meeting, now)).toBe("not_recorded");
      expect(meeting.status).toBe("scheduled");
      expect(meetingStatusConfig.not_recorded.label).toBe("Not recorded");
    },
  );
  it.each(["held", "no_show", "canceled"] as const)(
    "keeps the recorded %s status",
    (status) =>
      expect(meetingAttendanceDisplay({ ...meeting, status }, end + 1)).toBe(
        status,
      ),
  );
  it("uses each meeting's duration, including a zero-minute meeting", () => {
    expect(
      meetingAttendanceDisplay({ ...meeting, durationMinutes: 60 }, end),
    ).toBe("scheduled");
    expect(
      meetingAttendanceDisplay(
        { ...meeting, durationMinutes: 0 },
        meeting.scheduledAt,
      ),
    ).toBe("not_recorded");
  });
});

it.each(["completed", "held"])("labels %s meeting events as Held", (status) => {
  expect(meetingEventStatusLabel("meeting.status_changed", status)).toBe("Held");
  expect(meetingEventStatusLabel("followUp.completed", status)).toBe(status);
});

it("labels held attendance", () => {
  expect(meetingStatusConfig.held.label).toBe("Held");
});
