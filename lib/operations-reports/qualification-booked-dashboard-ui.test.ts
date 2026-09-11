// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("convex/react", () => ({ useQuery: () => undefined }));
vi.mock("@/app/workspace/_components/use-dashboard-range", () => ({
  useDashboardRange: () => ({
    range: { kind: "preset", preset: "this_month" },
    queryRange: { kind: "preset", preset: "this_month" },
    rangeLabel: "This month",
    validationMessage: undefined,
    setRange: () => {},
  }),
}));
vi.mock("@/app/workspace/_components/dashboard-date-range-filter", () => ({
  DashboardDateRangeFilter: () => null,
}));
vi.mock("@/app/workspace/operations/_components/operations-report-export-menu", () => ({
  OperationsReportExportMenu: () => null,
}));
vi.mock("@/app/workspace/operations/_components/report-job-status", () => ({
  OperationsReportJobStatus: () => null,
}));
vi.mock("@/app/workspace/operations/qualifications/_components/qualification-submissions-list", () => ({
  QualificationSubmissionsList: () => null,
}));
vi.mock("@/app/workspace/operations/qualifications/_components/qualifier-schedules-dialog", () => ({
  QualifierSchedulesDialog: () => null,
}));
vi.mock("@/app/workspace/reports/slack-qualifications/_components/team-goal-dialog", () => ({
  TeamGoalDialog: () => null,
}));
vi.mock("@/app/workspace/operations/booked-calls/_components/booked-calls-details-list", () => ({
  BookedCallsDetailsList: () => null,
}));
vi.mock("@/app/workspace/operations/booked-calls/_components/booking-goals-dialog", () => ({
  BookingGoalsDialog: () => null,
}));
vi.mock("@/app/workspace/operations/booked-calls/_components/dm-closer-schedules-dialog", () => ({
  DmCloserSchedulesDialog: () => null,
}));
vi.mock("@/app/workspace/operations/_components/use-operations-report-job", () => ({
  useOperationsDashboardReport: ({ reportKind }: { reportKind: string }) => ({
    jobId: "job",
    job: { status: "ready" },
    summary:
      reportKind === "qualifications"
        ? {
            generatedAt: 1,
            payload: {
              dailyQuota: 4,
              target: 80,
              progress: 7,
              businessDayCount: 20,
              qualifiedAfter: 100,
              qualifiedBefore: 200,
            },
          }
        : {
            generatedAt: 1,
            payload: {
              totalTarget: 80,
              progress: 9,
              businessDayCount: 20,
              start: 100,
              end: 200,
            },
          },
    requestError: null,
    cancel: () => {},
    refresh: () => {},
    retry: () => {},
  }),
  useAllOperationsReportRows: ({ section }: { section: string }) => ({
    isLoading: false,
    error: null,
    rows:
      section === "qualification_opener"
        ? [
            {
              rowKey: "opener-1",
              payload: {
                label: "Avery",
                qualified: 7,
                scheduledHours: 2,
                qualifiedPerHour: 3.5,
                lastEventAt: 150,
              },
            },
          ]
        : section === "booked_closer"
          ? [
              {
                rowKey: "closer-1",
                payload: {
                  label: "Avery",
                  teamLabel: "North",
                  booked: 9,
                  scheduledHours: 3,
                  bookedPerHour: 3,
                  hourlyRateMinor: 2500,
                },
              },
            ]
          : [
              {
                rowKey: "team-1",
                payload: {
                  label: "North",
                  dailyQuota: 4,
                  target: 80,
                  progress: 9,
                },
              },
            ],
  }),
}));

import { BookedCallsPageClient } from "@/app/workspace/operations/booked-calls/_components/booked-calls-page-client";
import { QualificationsPageClient } from "@/app/workspace/operations/qualifications/_components/qualifications-page-client";

function render(component: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(createElement(TooltipProvider, null, component));
}

describe("historical operations dashboards", () => {
  it("renders the original qualifications chart, goal, and contribution table", () => {
    const html = render(createElement(QualificationsPageClient));
    expect(html).toContain("Qualified per Opener");
    expect(html).toContain("Setter Contributions");
    expect(html).not.toContain("Historical qualification summary");
  });

  it("renders the original booked-calls chart, goal, and contribution table", () => {
    const html = render(createElement(BookedCallsPageClient));
    expect(html).toContain("Booked per DM Closer");
    expect(html).toContain("DM Closer Contributions");
    expect(html).not.toContain("Historical booked-call summary");
  });
});
