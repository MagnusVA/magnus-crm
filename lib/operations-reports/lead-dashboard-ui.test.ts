// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("convex/react", () => ({ useQuery: () => undefined }));
vi.mock("@/app/workspace/_components/use-dashboard-range", () => ({
  useDashboardRange: () => ({ range: { kind: "preset", preset: "this_month" }, queryRange: { kind: "preset", preset: "this_month" }, rangeLabel: "This month", setRange: () => {} }),
}));
vi.mock("@/app/workspace/_components/dashboard-date-range-filter", () => ({ DashboardDateRangeFilter: () => null }));
vi.mock("@/app/workspace/operations/_components/operations-report-export-menu", () => ({ OperationsReportExportMenu: () => null }));
vi.mock("@/app/workspace/operations/_components/report-job-status", () => ({ OperationsReportJobStatus: () => null }));
vi.mock("@/app/workspace/operations/lead-gen/_components/raw-submissions-table", () => ({ RawSubmissionsTable: () => null }));
vi.mock("@/app/workspace/operations/_components/use-operations-report-job", () => ({
  useOperationsDashboardReport: () => ({ jobId: "job", job: { status: "ready" }, summary: { generatedAt: 1, payload: { submissions: 42, scheduledHours: 6, leadsPerHour: 7 } } }),
  useOperationsReportRows: () => ({ rows: [], isLoading: false }),
  useAllOperationsReportRows: () => ({ rows: [], isLoading: false, error: null }),
}));

import { LeadGenAdminPageClient } from "@/app/workspace/operations/lead-gen/_components/lead-gen-admin-page-client";

describe("Lead Gen historical UI", () => {
  it("keeps original KPI cards, team performance, and Top Posts & Reels", () => {
    const html = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(LeadGenAdminPageClient)));
    expect(html).toContain("Total Submissions");
    expect(html).toContain("Specialists Active");
    expect(html).toContain("Scheduled Hours");
    expect(html).toContain("Specialist Performance");
    expect(html).toContain("Top Posts &amp; Reels");
    expect(html).not.toContain("Historical lead-gen summary");
  });
});
