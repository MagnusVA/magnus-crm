import { describe, expect, it } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import type { MissedMeetingRow } from "@/convex/operations/missedMeetings";
import {
  MISSED_MEETINGS_EXPORT_CAP,
  capMissedMeetingRows,
  missedMeetingsCsv,
  needsMoreMissedMeetingRows,
} from "./missed-meetings-export";

const row = (overrides: Partial<MissedMeetingRow> = {}): MissedMeetingRow => ({
  opportunityId: "deal1" as Id<"opportunities">,
  leadId: "lead1" as Id<"leads">,
  personName: "Nora Noshow",
  instagramHandle: "nora.noshow",
  email: "nora@example.com",
  phone: "+15550001",
  missedMeeting: "no_show",
  lostAt: Date.UTC(2026, 9, 18, 12),
  meetingAt: Date.UTC(2026, 9, 18, 11),
  source: "calendly",
  closerName: "Casey Closer",
  setterName: "Sam Setter",
  dmCloserName: "Dana DM",
  dmTeamName: "Team North",
  bookedAgain: false,
  ...overrides,
});

describe("the No-shows and cancellations export", () => {
  it("takes up to 2,000 rows", () => {
    expect(MISSED_MEETINGS_EXPORT_CAP).toBe(2000);
  });

  it("reads one row past the cap, and says it is truncated only then", () => {
    const rows = [row(), row(), row()];

    expect([needsMoreMissedMeetingRows(2, 3), needsMoreMissedMeetingRows(3, 3)]).toEqual([true, true]);
    expect(needsMoreMissedMeetingRows(4, 3)).toBe(false);
    expect(capMissedMeetingRows(rows, 3)).toEqual({ rows, truncated: false });
    expect(capMissedMeetingRows(rows, 2)).toEqual({ rows: rows.slice(0, 2), truncated: true });
  });

  it("sorts what the pages read by when each deal closed, newest first", () => {
    const older = row({ opportunityId: "older" as Id<"opportunities">, lostAt: 1_000 });
    const newer = row({ opportunityId: "newer" as Id<"opportunities">, lostAt: 2_000 });

    expect(capMissedMeetingRows([older, newer]).rows).toEqual([newer, older]);
    expect(capMissedMeetingRows([older, newer], 1)).toEqual({ rows: [newer], truncated: true });
  });

  it("writes one line a deal, with labels and ISO times", () => {
    const csv = missedMeetingsCsv([
      row(),
      row({
        opportunityId: "deal2" as Id<"opportunities">,
        personName: null,
        instagramHandle: null,
        phone: null,
        missedMeeting: "canceled",
        meetingAt: null,
        source: "slack_qualified",
        closerName: "Removed closer",
        setterName: null,
        dmCloserName: null,
        dmTeamName: null,
        bookedAgain: true,
      }),
    ]);

    expect(csv.split("\r\n")).toEqual([
      "Name,Instagram,Email,Phone,Missed meeting,Meeting at,Closed at,Source,Closer,Setter,DM closer,DM team,Booked again,Deal ID,Person ID",
      "Nora Noshow,nora.noshow,nora@example.com,'+15550001,No-show,2026-10-18T11:00:00.000Z,2026-10-18T12:00:00.000Z,Calendly,Casey Closer,Sam Setter,Dana DM,Team North,No,deal1,lead1",
      ",,nora@example.com,,Canceled,,2026-10-18T12:00:00.000Z,Slack,Removed closer,,,,Yes,deal2,lead1",
    ]);
  });
});
