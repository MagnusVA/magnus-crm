// @vitest-environment node
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardRangeInput } from "@/app/workspace/_components/date-range-picker";

// The analytics pages send their live Convex readers the business dates of
// the picked range, worked out from the browser's ticking clock and the
// tenant's business day. A preset resolved on the server would read the
// server's clock once, and Convex never re-runs a query because time passed,
// so a page left open past the business day's change kept yesterday's numbers.

const fixture = vi.hoisted(() => ({
  queries: [] as Array<[string, unknown]>,
  search: "",
  // Overview and My activity keep their range in component state, not the URL;
  // tests set the starting range here instead of clicking the picker.
  initialRange: null as DashboardRangeInput | null,
}));

const TENANT = {
  businessDay: { timeZone: "America/Tegucigalpa", dayStartHour: 1 },
  businessDayReady: true,
  leadGenBusinessDayReady: true,
  businessDayVersion: 1,
  analyticsReports: [],
};

const REBUILDING_SECTION = { status: "rebuilding", data: null, truncated: false, message: "Rebuilding", errorCode: null };

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    // Overview's `useState<DashboardRangeInput>({ kind: "preset", preset: "today" })`.
    useState: (initial: unknown) =>
      actual.useState(
        fixture.initialRange &&
          typeof initial === "object" &&
          initial !== null &&
          (initial as { kind?: unknown }).kind === "preset" &&
          (initial as { preset?: unknown }).preset === "today"
          ? fixture.initialRange
          : initial,
      ),
  };
});
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(fixture.search),
  useRouter: () => ({ replace: () => undefined, push: () => undefined }),
  usePathname: () => "/workspace",
}));
vi.mock("@/app/workspace/_components/use-dashboard-range", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/workspace/_components/use-dashboard-range")>();
  return {
    ...actual,
    useDashboardRange: (options: Parameters<typeof actual.useDashboardRange>[0] = {}) =>
      actual.useDashboardRange(fixture.initialRange ? { ...options, defaultRange: fixture.initialRange } : options),
  };
});
vi.mock("convex/react", () => ({
  useQuery: (reference: Parameters<typeof getFunctionName>[0], args: unknown) => {
    const name = getFunctionName(reference);
    fixture.queries.push([name, args]);
    if (name === "tenants:getCurrentTenant") return TENANT;
    // Overview shows its skeleton, without the picker, until the reader answers.
    if (name === "dashboard/overview:getOverviewDashboard" && args !== "skip") {
      const range = (args as { range: { startBusinessDate: string; endBusinessDateInclusive: string } }).range;
      return {
        range: { startBusinessDate: range.startBusinessDate, endBusinessDateInclusive: range.endBusinessDateInclusive },
        leadGen: REBUILDING_SECTION,
        topQualifiers: REBUILDING_SECTION,
        topDmClosers: REBUILDING_SECTION,
        phoneCloserOperations: REBUILDING_SECTION,
        topOrigins: REBUILDING_SECTION,
      };
    }
    return undefined;
  },
  useMutation: () => async () => ({ started: false }),
  useAction: () => async () => undefined,
  useConvex: () => ({ query: async () => undefined, mutation: async () => undefined }),
  usePaginatedQuery: () => ({ results: [], status: "LoadingFirstPage", loadMore: () => undefined, isLoading: true }),
}));
vi.mock("convex-helpers/react", () => ({
  usePaginatedQuery: (reference: Parameters<typeof getFunctionName>[0], args: unknown) => {
    fixture.queries.push([getFunctionName(reference), args]);
    return { results: [], status: "LoadingFirstPage", loadMore: () => undefined, isLoading: true };
  },
}));

import { DashboardPageClient } from "@/app/workspace/_components/dashboard-page-client";
import { SalesCallsPageClient } from "@/app/workspace/operations/sales-calls/_components/sales-calls-page-client";
import { BookedCallsPageClient } from "@/app/workspace/operations/booked-calls/_components/booked-calls-page-client";
import { QualificationsPageClient } from "@/app/workspace/operations/qualifications/_components/qualifications-page-client";
import { LeadGenActivityPageClient } from "@/app/workspace/lead-gen/_components/lead-gen-activity-page-client";
import { RoleProvider } from "@/components/auth/role-context";
import { TooltipProvider } from "@/components/ui/tooltip";

type Page = { name: string; component: ComponentType; readers: string[]; urlSync: boolean; operations: boolean };

const pages: Page[] = [
  { name: "Overview", component: DashboardPageClient, readers: ["dashboard/overview:getOverviewDashboard"], urlSync: false, operations: false },
  { name: "Sales calls", component: SalesCallsPageClient, readers: ["operations/salesCallsDashboard:getSalesCallsDashboard"], urlSync: true, operations: true },
  { name: "Booked calls", component: BookedCallsPageClient, readers: ["operations/bookedCallsDashboard:getBookedCallsDashboard"], urlSync: true, operations: true },
  { name: "Qualifications", component: QualificationsPageClient, readers: ["operations/qualificationsDashboard:getQualificationsDashboard"], urlSync: true, operations: true },
  {
    name: "My activity",
    component: LeadGenActivityPageClient,
    readers: ["leadGen/activity:getMyActivitySummary", "leadGen/activity:listMyRecentSubmissions"],
    urlSync: false,
    operations: false,
  },
];
const urlPages = pages.filter((page) => page.urlSync);
const statePages = pages.filter((page) => !page.urlSync);

// 00:59 on Nov 6 in Tegucigalpa (UTC-6): the 1 AM business day is still Nov 5.
const BEFORE_DAY_CHANGE = "2026-11-06T06:59:00Z";
// 01:01 on Nov 6: the business day is Nov 6, a Friday.
const AFTER_DAY_CHANGE = "2026-11-06T07:01:00Z";

function custom(start: string, end: string) {
  return { kind: "custom", startBusinessDate: start, endBusinessDateInclusive: end };
}

function render(page: Page, at: string) {
  vi.setSystemTime(new Date(at));
  return renderToStaticMarkup(
    createElement(
      // RoleProvider's props type requires `children` as a prop; pass it as an argument.
      RoleProvider as ComponentType<{ initialRole: "tenant_master" }>,
      { initialRole: "tenant_master" },
      createElement(TooltipProvider, null, createElement(page.component)),
    ),
  );
}

function callsTo(reader: string) {
  return fixture.queries.filter(([name]) => name === reader).map(([, args]) => args);
}

function expectReaderRange(page: Page, start: string, end: string) {
  for (const reader of page.readers) {
    const calls = callsTo(reader);
    expect(calls.length, `${reader} was never called`).toBeGreaterThan(0);
    for (const args of calls) {
      expect(args, reader).toEqual(expect.objectContaining({ range: custom(start, end) }));
    }
  }
}

function expectNoPresetSent() {
  for (const [name, args] of fixture.queries) {
    const range = typeof args === "object" && args !== null ? (args as { range?: { kind?: string } }).range : undefined;
    expect(range?.kind, `${name} got a preset range`).not.toBe("preset");
  }
}

/** The picker's toggle for `label`: Radix renders it as a radio, checked when picked. */
function presetToggle(html: string, label: string) {
  const match = html.match(new RegExp(`<button[^>]*>${label}</button>`));
  expect(match, `no "${label}" toggle in the picker`).not.toBeNull();
  return match![0];
}

beforeEach(() => {
  fixture.queries = [];
  fixture.search = "";
  fixture.initialRange = null;
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("live readers get the business dates of the range", () => {
  it.each(pages)("$name sends Nov 5 at 00:59, before the 1 AM day change", (page) => {
    const html = render(page, BEFORE_DAY_CHANGE);
    expectReaderRange(page, "2026-11-05", "2026-11-05");
    expectNoPresetSent();
    expect(presetToggle(html, "Today")).toContain('aria-checked="true"');
  });

  it.each(pages)("$name sends Nov 6 at 01:01, after the day change", (page) => {
    const html = render(page, AFTER_DAY_CHANGE);
    expectReaderRange(page, "2026-11-06", "2026-11-06");
    expectNoPresetSent();
    expect(presetToggle(html, "Today")).toContain('aria-checked="true"');
  });

  it.each(urlPages)("$name sends Monday to today for ?range=this_week", (page) => {
    fixture.search = "range=this_week";
    const html = render(page, AFTER_DAY_CHANGE);
    expectReaderRange(page, "2026-11-02", "2026-11-06");
    expectNoPresetSent();
    expect(presetToggle(html, "This week")).toContain('aria-checked="true"');
    expect(presetToggle(html, "Today")).toContain('aria-checked="false"');
  });

  // Nov 1..6 is 6 days, inside the 7-day live limit, so the Operations pages
  // read Convex live (not the snapshot job) and send explicit dates.
  it.each(urlPages)("$name sends the 1st to today for ?range=this_month", (page) => {
    fixture.search = "range=this_month";
    const html = render(page, AFTER_DAY_CHANGE);
    expectReaderRange(page, "2026-11-01", "2026-11-06");
    expectNoPresetSent();
    expect(presetToggle(html, "This month")).toContain('aria-checked="true"');
  });

  it.each(statePages)("$name sends Monday to today for This week", (page) => {
    fixture.initialRange = { kind: "preset", preset: "this_week" };
    const html = render(page, AFTER_DAY_CHANGE);
    expectReaderRange(page, "2026-11-02", "2026-11-06");
    expectNoPresetSent();
    expect(presetToggle(html, "This week")).toContain('aria-checked="true"');
  });

  it.each(statePages)("$name sends the 1st to today for This month", (page) => {
    fixture.initialRange = { kind: "preset", preset: "this_month" };
    const html = render(page, AFTER_DAY_CHANGE);
    expectReaderRange(page, "2026-11-01", "2026-11-06");
    expectNoPresetSent();
    expect(presetToggle(html, "This month")).toContain('aria-checked="true"');
  });

  // Late in the month, "This month" runs past 7 days: the Operations pages
  // skip the live reader and read the snapshot job instead (the job gets the
  // preset, which it resolves once when it runs).
  it.each(urlPages)("$name skips the live reader for a this_month over 7 days", (page) => {
    fixture.search = "range=this_month";
    render(page, "2026-11-20T18:00:00Z");
    for (const reader of page.readers) {
      const calls = callsTo(reader);
      expect(calls.length).toBeGreaterThan(0);
      for (const args of calls) expect(args).toBe("skip");
    }
  });

  it("Overview sends the 1st to today for a This month over 7 days", () => {
    fixture.initialRange = { kind: "preset", preset: "this_month" };
    render(pages[0], "2026-11-20T18:00:00Z");
    expectReaderRange(pages[0], "2026-11-01", "2026-11-20");
    expectNoPresetSent();
  });
});
