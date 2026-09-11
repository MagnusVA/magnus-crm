import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { ScalarRecord } from "@/convex/operations/reports/contracts";
import { dashboardIdentity } from "./dashboard-identity";

type QualificationsDashboard = FunctionReturnType<
  typeof api.operations.qualificationsDashboard.getQualificationsDashboard
>;
type LiveOpener = QualificationsDashboard["openers"][number];
type LiveGoal = QualificationsDashboard["goal"];
type LiveWindow = QualificationsDashboard["window"];

type DashboardReportSummary = NonNullable<
  FunctionReturnType<typeof api.operations.reports.jobs.getDashboardReportSummary>
>;
type DashboardReportRow = FunctionReturnType<
  typeof api.operations.reports.jobs.listDashboardReportRows
>["page"][number];

export type QualificationOpenerViewModel = Pick<
  LiveOpener,
  | "key"
  | "label"
  | "qualified"
  | "qualifiedPerHour"
  | "scheduledHours"
  | "lastEventAt"
  | "avatar"
>;

export type QualificationDashboardViewModel = {
  openers: QualificationOpenerViewModel[];
  goal: Pick<
    LiveGoal,
    "dailyQuota" | "target" | "progress" | "businessDayCount"
  >;
  window: LiveWindow;
};

export type QualificationSnapshotInput = {
  summary: Pick<DashboardReportSummary, "payload">;
  openers: Pick<DashboardReportRow, "rowKey" | "payload">[];
};

export type DashboardAdapterResult<T> =
  | { data: T; error: null }
  | { data: null; error: string };

function requireString(payload: ScalarRecord, key: string, context: string) {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${context} is missing its ${key} field.`);
  }
  return value;
}

function requireNumber(payload: ScalarRecord, key: string, context: string) {
  const value = payload[key];
  if (typeof value !== "number") {
    throw new Error(`${context} is missing its ${key} field.`);
  }
  return value;
}

function requireNullableNumber(
  payload: ScalarRecord,
  key: string,
  context: string,
) {
  const value = payload[key];
  if (value !== null && typeof value !== "number") {
    throw new Error(`${context} has an invalid ${key} field.`);
  }
  return value;
}

function requireAvatar(
  payload: ScalarRecord,
  fallbackId: string,
  fallbackName: string,
) {
  return dashboardIdentity(payload, fallbackId, fallbackName);
}

function readQualificationOpener(
  row: Pick<DashboardReportRow, "rowKey" | "payload">,
): QualificationOpenerViewModel {
  const context = `Qualification opener ${row.rowKey}`;
  const payload = row.payload;
  const label = requireString(payload, "label", context);
  return {
    key: row.rowKey,
    label,
    qualified: requireNumber(payload, "qualified", context),
    scheduledHours: requireNullableNumber(payload, "scheduledHours", context),
    qualifiedPerHour: requireNullableNumber(
      payload,
      "qualifiedPerHour",
      context,
    ),
    lastEventAt: requireNullableNumber(payload, "lastEventAt", context),
    avatar: requireAvatar(payload, row.rowKey, label),
  };
}

export function qualificationDashboardFromLive(
  dashboard: QualificationsDashboard,
): QualificationDashboardViewModel {
  return {
    openers: dashboard.openers.map((opener) => ({
      key: opener.key,
      label: opener.label,
      qualified: opener.qualified,
      scheduledHours: opener.scheduledHours,
      qualifiedPerHour: opener.qualifiedPerHour,
      lastEventAt: opener.lastEventAt,
      avatar: opener.avatar,
    })),
    goal: {
      dailyQuota: dashboard.goal.dailyQuota,
      target: dashboard.goal.target,
      progress: dashboard.goal.progress,
      businessDayCount: dashboard.goal.businessDayCount,
    },
    window: dashboard.window,
  };
}

export function qualificationDashboardFromSnapshot(
  input: QualificationSnapshotInput,
): DashboardAdapterResult<QualificationDashboardViewModel> {
  try {
    const { payload } = input.summary;
    const context = "Qualification summary";
    return {
      data: {
        openers: input.openers.map(readQualificationOpener),
        goal: {
          dailyQuota: requireNullableNumber(payload, "dailyQuota", context),
          target: requireNullableNumber(payload, "target", context),
          progress: requireNumber(payload, "progress", context),
          businessDayCount: requireNumber(payload, "businessDayCount", context),
        },
        window: {
          qualifiedAfter: requireNumber(payload, "qualifiedAfter", context),
          qualifiedBefore: requireNumber(payload, "qualifiedBefore", context),
        },
      },
      error: null,
    };
  } catch (error) {
    return {
      data: null,
      error:
        error instanceof Error
          ? error.message
          : "The historical qualifications report has invalid dashboard data.",
    };
  }
}
