import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { ScalarRecord } from "@/convex/operations/reports/contracts";
import type { DashboardAdapterResult } from "./qualification-dashboard";
import { dashboardIdentity } from "./dashboard-identity";

type BookedCallsDashboard = FunctionReturnType<
  typeof api.operations.bookedCallsDashboard.getBookedCallsDashboard
>;
type LiveDmCloser = BookedCallsDashboard["dmClosers"][number];
type LiveGoal = BookedCallsDashboard["goal"];
type LiveGoalTeam = LiveGoal["teams"][number];
type LiveWindow = BookedCallsDashboard["window"];

type DashboardReportSummary = NonNullable<
  FunctionReturnType<typeof api.operations.reports.jobs.getDashboardReportSummary>
>;
type DashboardReportRow = FunctionReturnType<
  typeof api.operations.reports.jobs.listDashboardReportRows
>["page"][number];

export type DmCloserViewModel = Pick<
  LiveDmCloser,
  | "key"
  | "label"
  | "teamLabel"
  | "booked"
  | "scheduledHours"
  | "bookedPerHour"
  | "hourlyRateMinor"
  | "avatar"
>;

export type BookingGoalTeamViewModel = Pick<
  LiveGoalTeam,
  "label" | "dailyQuota" | "target" | "progress"
> & {
  /** The team's id, for links into Team › Teams; null on answers that don't carry it. */
  teamId: string | null;
  /** Days in the range someone on the team works; absent on answers from before goals counted them. */
  goalDayCount?: number;
  /** Whether the range's last day is one of the goal's days; absent on older answers. */
  goalCountsLastDay?: boolean;
  /**
   * The part of progress no DM closer is credited with, and the UTMs it came
   * with (null when the path can't tell them). Null when unknown: an answer
   * or snapshot from before the breakdown existed.
   */
  teamOnly: NonNullable<LiveGoalTeam["teamOnly"]> | null;
};

export type BookedCallsDashboardViewModel = {
  dmClosers: DmCloserViewModel[];
  goal: Pick<LiveGoal, "totalTarget" | "progress" | "businessDayCount"> & {
    teams: BookingGoalTeamViewModel[];
  };
  window: LiveWindow;
};

export type BookedCallsSnapshotInput = {
  summary: Pick<DashboardReportSummary, "payload">;
  dmClosers: Pick<DashboardReportRow, "rowKey" | "payload">[];
  teams: Pick<DashboardReportRow, "rowKey" | "payload">[];
};

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

function readDmCloser(
  row: Pick<DashboardReportRow, "rowKey" | "payload">,
): DmCloserViewModel {
  const context = `DM closer ${row.rowKey}`;
  const payload = row.payload;
  const label = requireString(payload, "label", context);
  return {
    key: row.rowKey,
    label,
    teamLabel: requireString(payload, "teamLabel", context),
    booked: requireNumber(payload, "booked", context),
    scheduledHours: requireNullableNumber(payload, "scheduledHours", context),
    bookedPerHour: requireNullableNumber(payload, "bookedPerHour", context),
    hourlyRateMinor: requireNullableNumber(payload, "hourlyRateMinor", context),
    avatar: requireAvatar(payload, row.rowKey, label),
  };
}

function readBookingGoalTeam(
  row: Pick<DashboardReportRow, "rowKey" | "payload">,
): BookingGoalTeamViewModel {
  const context = `Booking team ${row.rowKey}`;
  const payload = row.payload;
  return {
    label: requireString(payload, "label", context),
    teamId: typeof payload.teamId === "string" ? payload.teamId : null,
    dailyQuota: requireNullableNumber(payload, "dailyQuota", context),
    target: requireNullableNumber(payload, "target", context),
    progress: requireNumber(payload, "progress", context),
    ...(typeof payload.goalDayCount === "number" ? { goalDayCount: payload.goalDayCount } : {}),
    ...(typeof payload.goalCountsLastDay === "boolean" ? { goalCountsLastDay: payload.goalCountsLastDay } : {}),
    teamOnly:
      typeof payload.teamOnlyBooked === "number"
        ? { booked: payload.teamOnlyBooked, sources: null }
        : null,
  };
}

export function bookedCallsDashboardFromLive(
  dashboard: BookedCallsDashboard,
): BookedCallsDashboardViewModel {
  return {
    dmClosers: dashboard.dmClosers.map((closer) => ({
      key: closer.key,
      label: closer.label,
      teamLabel: closer.teamLabel,
      booked: closer.booked,
      scheduledHours: closer.scheduledHours,
      bookedPerHour: closer.bookedPerHour,
      hourlyRateMinor: closer.hourlyRateMinor,
      avatar: closer.avatar,
    })),
    goal: {
      totalTarget: dashboard.goal.totalTarget,
      progress: dashboard.goal.progress,
      businessDayCount: dashboard.goal.businessDayCount,
      teams: dashboard.goal.teams.map((team) => ({
        label: team.label,
        teamId: team.teamId,
        dailyQuota: team.dailyQuota,
        target: team.target,
        progress: team.progress,
        ...(team.goalDayCount === undefined ? {} : { goalDayCount: team.goalDayCount }),
        ...(team.goalCountsLastDay === undefined ? {} : { goalCountsLastDay: team.goalCountsLastDay }),
        teamOnly: team.teamOnly ?? null,
      })),
    },
    window: dashboard.window,
  };
}

export function bookedCallsDashboardFromSnapshot(
  input: BookedCallsSnapshotInput,
): DashboardAdapterResult<BookedCallsDashboardViewModel> {
  try {
    const { payload } = input.summary;
    const context = "Booked-calls summary";
    return {
      data: {
        dmClosers: input.dmClosers.map(readDmCloser),
        goal: {
          totalTarget: requireNullableNumber(payload, "totalTarget", context),
          progress: requireNumber(payload, "progress", context),
          businessDayCount: requireNumber(payload, "businessDayCount", context),
          teams: input.teams.map(readBookingGoalTeam),
        },
        window: {
          start: requireNumber(payload, "start", context),
          end: requireNumber(payload, "end", context),
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
          : "The historical booked-calls report has invalid dashboard data.",
    };
  }
}
