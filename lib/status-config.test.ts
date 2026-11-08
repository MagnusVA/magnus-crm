import { readFileSync } from "node:fs";
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

// Status colours come from the design tokens in app/globals.css (DESIGN.md,
// rule 6), so these files must not grow raw Tailwind palette classes again.
const PALETTE =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const RAW_COLOUR = new RegExp(
  String.raw`\b(?:bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|fill|stroke|from|via|to|outline|divide|shadow|decoration|accent|caret|placeholder)-` +
    String.raw`(?:(?:${PALETTE})-\d{2,3}\b|(?:white|black)\b|\[(?:#|rgba?\(|hsla?\(|oklch\())`,
  "g",
);
const TOKEN_ONLY_FILES = [
  "lib/status-config.ts",
  "app/dm-links/[portalSlug]/_components/portal-leads-panel.tsx",
  "app/workspace/_components/initial-source-badge.tsx",
  "components/slack-connection-guard.tsx",
];

describe("token-only colour files", () => {
  it("catch every raw colour form", () => {
    for (const raw of [
      "bg-red-500",
      "dark:text-emerald-300",
      "border-l-amber-500/60",
      "bg-sky-500/10",
      "fill-blue-600",
      "ring-orange-200",
      "from-violet-400",
      "bg-[#ff0000]",
      "text-[rgb(0,0,0)]",
      "bg-white",
      "dark:text-black",
      "border-white/10",
    ]) {
      expect(raw.match(RAW_COLOUR), raw).not.toBeNull();
    }
    for (const token of ["bg-stage-booked/15", "text-warning-ink", "text-muted-foreground", "border-border"]) {
      expect(token.match(RAW_COLOUR), token).toBeNull();
    }
  });

  it.each(TOKEN_ONLY_FILES)("%s uses design tokens, not palette colours", (file) => {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    expect(source.match(RAW_COLOUR) ?? []).toEqual([]);
  });
});
