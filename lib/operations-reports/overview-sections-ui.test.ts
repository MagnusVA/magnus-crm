// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";

// Every post in these tests has a ready preview with its posted date.
const previews = vi.hoisted(() => ({ postedOn: new Map<string, string>() }));
vi.mock("convex/react", () => ({
  useQuery: (_query: unknown, args: { originKeys: string[] }) =>
    args.originKeys.map((originKey) => ({
      originKey,
      status: "ready",
      handle: "magnus",
      caption: `Caption ${originKey}`,
      postedOn: previews.postedOn.get(originKey),
      thumbnailUrl: null,
    })),
}));

import { PhoneCloserOperationsSection } from "@/app/workspace/_components/phone-closer-operations-section";
import { TopOriginsOverviewSection } from "@/app/workspace/_components/top-origins-overview-section";
import { ATTENDANCE_COUNTS_PARTIAL_HELP } from "@/app/workspace/_components/results-recorded";

const closer = (id: string, name: string) => ({ id, name, imageSource: "none" as const, source: "crm_user" as const });
const counts = { scheduled: 3, held: 2, noShows: 1, canceled: 0, moved: 0, resultsRecorded: 3, pastCalls: 3, showRate: 2 / 3, noShowRate: 1 / 3 };

function phoneClosers(attendanceCountsPartial: boolean, rowCounts: typeof counts = counts) {
  return renderToStaticMarkup(
    createElement(PhoneCloserOperationsSection, {
      section: {
        status: "ready",
        truncated: false,
        message: null,
        errorCode: null,
        data: {
          attendanceCountsPartial,
          rows: [
            { closerId: "u1" as Id<"users">, closer: closer("u1", "Ana"), ...rowCounts },
            { closerId: "u2" as Id<"users">, closer: closer("u2", "Ben"), ...rowCounts },
          ],
          totals: rowCounts,
        },
      },
    }),
  );
}

function topPosts(posts: Record<string, string>, todayBusinessDate?: string) {
  previews.postedOn = new Map(Object.entries(posts));
  return renderToStaticMarkup(
    createElement(TopOriginsOverviewSection, {
      todayBusinessDate,
      section: {
        status: "ready",
        truncated: false,
        message: null,
        errorCode: null,
        data: {
          rows: Object.keys(posts).map((originKey) => ({
            originKey,
            source: "instagram" as const,
            originKind: "reel",
            originValue: `https://www.instagram.com/reel/${originKey}/`,
            submissions: 4,
            uniqueProspects: 3,
          })),
        },
      },
    }),
  );
}

afterEach(() => vi.useRealTimers());

describe("Overview phone closers canceled and moved", () => {
  it("shows them when the answer has them", () => {
    const html = phoneClosers(false, { ...counts, canceled: 2, moved: 1 });
    expect(html).toContain("2 canceled · 1 moved");
  });

  it("leaves them out of an answer saved before they were added", () => {
    const { canceled: _canceled, moved: _moved, ...saved } = counts;
    const html = phoneClosers(false, saved as typeof counts);
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("canceled");
    expect(html).not.toContain("moved");
    expect(html).toContain("booked");
  });
});

describe("Overview phone closers help", () => {
  it.each([true, false])("says the partial help once on the page, never as a tooltip (partial %s)", (partial) => {
    const html = phoneClosers(partial);
    expect(html).not.toContain("title=");
    expect(html.split(ATTENDANCE_COUNTS_PARTIAL_HELP).length - 1).toBe(partial ? 1 : 0);
    expect(html).toContain("Show rate: held ÷ (held + no-show)");
  });
});

describe("Overview top posts dates", () => {
  it("drops the year by the business day, not the browser clock", () => {
    vi.useFakeTimers();
    // Jan 1, 2027 on every browser clock, while a Honolulu tenant whose day starts
    // at 4 AM is still on Dec 31, 2026.
    vi.setSystemTime(new Date("2027-01-01T12:00:00Z"));
    const html = topPosts({ a: "2026-12-20", b: "2027-01-01", c: "2025-06-01" }, "2026-12-31");
    expect(html).toContain("@magnus · Reel · Dec 20<");
    expect(html).toContain("@magnus · Reel · Jan 1, 2027<");
    expect(html).toContain("@magnus · Reel · Jun 1, 2025<");
  });

  it("shows the year when no business date is given", () => {
    expect(topPosts({ a: "2026-12-20" })).toContain("@magnus · Reel · Dec 20, 2026<");
  });
});
