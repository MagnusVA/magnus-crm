// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { REPORT_RANGE_PRESETS, type ReportRangePreset } from "./analyticsRange";

vi.mock("next/navigation", () => ({
  usePathname: () => "/workspace/reports/scorecard",
  useRouter: () => ({ replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

import { parseRangeFromSearchParams } from "@/app/workspace/_components/use-dashboard-range";
import { freshnessSummary } from "@/app/workspace/_components/analytics/analytics-freshness";
import type { AnalyticsFreshness } from "@/app/workspace/_components/analytics/use-analytics-report";
import { navForRole, reportNavItems } from "@/app/workspace/_components/workspace-nav";

describe("range in the URL", () => {
  const parse = (search: string, presets: readonly ReportRangePreset[] = ["today", "this_week", "this_month"]) =>
    parseRangeFromSearchParams(new URLSearchParams(search), {}, presets);

  it("reads every Reports preset back from ?range=", () => {
    for (const preset of REPORT_RANGE_PRESETS) {
      expect(parse(`range=${preset}`, REPORT_RANGE_PRESETS)).toEqual({ kind: "preset", preset });
    }
  });

  it("keeps the dashboards to their three presets", () => {
    expect(parse("range=this_month")).toEqual({ kind: "preset", preset: "this_month" });
    expect(parse("range=last_week")).toBeNull();
    expect(parse("range=year_to_date")).toBeNull();
  });

  it("reads a valid custom range and ignores anything else", () => {
    expect(parse("range=custom&from=2026-10-01&to=2026-10-31")).toEqual({
      kind: "custom",
      startBusinessDate: "2026-10-01",
      endBusinessDateInclusive: "2026-10-31",
    });
    expect(parse("range=custom&from=2026-10-31&to=2026-10-01")).toBeNull();
    expect(parse("range=whenever", REPORT_RANGE_PRESETS)).toBeNull();
  });
});

describe("freshness line", () => {
  const asOf = Date.parse("2026-11-05T08:00:00Z");
  const warehouse = (liveToday: boolean, liveYesterday: boolean): AnalyticsFreshness => ({
    source: "warehouse",
    state: "ready",
    asOf,
    refreshing: false,
    liveToday,
    liveYesterday,
    errorMessage: null,
    retry: () => {},
  });
  const label = (items: AnalyticsFreshness[]) => {
    const summary = freshnessSummary(items, asOf + 60_000);
    return summary.kind === "line" ? summary.label : summary.kind;
  };

  it("says today is live for a split", () => {
    expect(label([warehouse(true, false)])).toMatch(/^Today live · earlier days as of /);
  });

  it("says today and yesterday are live overnight", () => {
    expect(label([warehouse(true, true), warehouse(true, false)])).toMatch(/^Today and yesterday live · earlier days as of /);
  });

  it("keeps the other lines", () => {
    expect(label([{ source: "live" }])).toBe("Live");
    expect(label([warehouse(false, false)])).toMatch(/^Data as of /);
  });
});

describe("Reports navigation", () => {
  it("lists the six admin pages in order", () => {
    expect(reportNavItems.map((item) => [item.label, item.href])).toEqual([
      ["Scorecard", "/workspace/reports/scorecard"],
      ["Calls", "/workspace/reports/calls"],
      ["People", "/workspace/reports/people"],
      ["Attribution", "/workspace/reports/attribution"],
      ["Pipeline", "/workspace/reports/pipeline"],
      ["Log", "/workspace/reports/log"],
    ]);
  });

  it("gives closers and lead generators My report, and admins none", () => {
    const myReport = (items: ReturnType<typeof navForRole>) =>
      items.filter((item) => item.href === "/workspace/reports/people/me").map((item) => item.label);
    expect(myReport(navForRole("closer", false, false))).toEqual(["My report"]);
    expect(myReport(navForRole("lead_generator", false, false))).toEqual(["My report"]);
    expect(myReport(navForRole("tenant_admin", true, true))).toEqual([]);
  });
});
