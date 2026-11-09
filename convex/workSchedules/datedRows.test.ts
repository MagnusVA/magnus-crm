import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { businessDayStart, DEFAULT_BUSINESS_DAY } from "../../lib/businessDay";
import { bookingHarness } from "../../tests/bookingHarness";
import { expectMergedAnswer } from "../../tests/analyticsMerge";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { mergeBookedCallsDashboard, mergeQualificationsDashboard } from "../analytics/merge/operations";
import { weekOn, weekdays, type WeekHours, type Weekday } from "../lib/workSchedule";
import { readSourcePage } from "../operations/reports/readers";
import { reduceReportSourcePage } from "../operations/reports/reducers";
import type { ReportSourcePageRequest } from "../operations/reports/model";

// Dated schedules (convex/lib/workSchedule.ts): a save applies from today on,
// earlier days keep their hours, and goals count the days someone works.

const HOUR = 3_600_000;
// Tuesday 2026-11-03, noon in Tegucigalpa: business "today".
const TODAY = "2026-11-03";
const YESTERDAY = "2026-11-02";
const NOW = businessDayStart(TODAY, DEFAULT_BUSINESS_DAY) + 11 * HOUR;
// A full past week, Monday to Sunday.
const WEEK_START = "2026-10-26";
const WEEK_END = "2026-11-01";

type Week = WeekHours;

function weekOf(hours: number, days: readonly Weekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday"]): Week {
  return Object.fromEntries(weekdays.map((weekday) => [weekday, days.includes(weekday) ? hours : 0])) as Week;
}

const range = (startBusinessDate: string, endBusinessDateInclusive: string) => ({
  range: { kind: "custom" as const, startBusinessDate, endBusinessDateInclusive },
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

async function setup() {
  const h = await bookingHarness({ leadGenTeam: true });
  const ids = await h.t.run(async (ctx) => {
    const worker = (await ctx.db
      .query("leadGenWorkers")
      .withIndex("by_tenantId_and_userId", (q) => q.eq("tenantId", h.tenantId))
      .first())!;
    const adminId = worker.userId;
    const workerId = worker._id;
    const installationId = await ctx.db.insert("slackInstallations", {
      tenantId: h.tenantId, teamId: "T1", teamName: "Team", isEnterpriseInstall: false, appId: "A1", botUserId: "B1",
      botAccessToken: "token", scopes: [], installedByWorkosUserId: "user_admin", installedAt: 0,
      tokenExpiresAt: 0, refreshToken: "refresh", status: "active",
    });
    const slackUser = (slackUserId: string, fields: Partial<Doc<"slackUsers">> = {}) =>
      ctx.db.insert("slackUsers", {
        tenantId: h.tenantId, installationId, slackUserId, slackTeamId: "T1", isBot: false, isDeleted: false,
        firstSeenAt: 0, lastSeenAt: 0, lastSyncedAt: 0, ...fields,
      });
    await slackUser("U1", { displayName: "Ana" });
    await slackUser("U2", { displayName: "Gone", isDeleted: true });
    const team = (slug: string) =>
      ctx.db.insert("attributionTeams", {
        tenantId: h.tenantId, slug, displayName: slug, utmSource: slug, normalizedUtmSource: slug,
        isActive: true, bookingDailyQuota: 2, createdAt: 0, updatedAt: 0,
      });
    const north = await team("north");
    const south = await team("south");
    const closer = (slug: string, teamId: Id<"attributionTeams">) =>
      ctx.db.insert("dmClosers", {
        tenantId: h.tenantId, teamId, slug, displayName: slug, utmMedium: slug, normalizedUtmMedium: slug,
        isActive: true, createdAt: 0, updatedAt: 0,
      });
    const northCloser = await closer("nora", north);
    const southCloser = await closer("sam", south);
    await ctx.db.patch("tenants", h.tenantId, { slackQualificationDailyTeamQuota: 3 });
    return { adminId, workerId, installationId, north, south, northCloser, southCloser };
  });
  return { h, ...ids };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** Undated rows: a week saved before schedules were dated, in force from the beginning. */
async function seedUndated(s: Setup, table: "dmCloserSchedules" | "slackQualifierSchedules" | "leadGenWorkerSchedules", week: Week) {
  await s.h.t.run(async (ctx) => {
    for (const weekday of weekdays) {
      const fields = { tenantId: s.h.tenantId, weekday, scheduledHours: week[weekday], updatedByUserId: s.adminId, updatedAt: 0 };
      if (table === "dmCloserSchedules") await ctx.db.insert(table, { ...fields, dmCloserId: s.northCloser });
      if (table === "slackQualifierSchedules") await ctx.db.insert(table, { ...fields, slackUserId: "U1" });
      if (table === "leadGenWorkerSchedules") await ctx.db.insert(table, { ...fields, workerId: s.workerId, userId: s.adminId });
    }
  });
}

async function closerRows(s: Setup, dmCloserId: Id<"dmClosers"> = s.northCloser) {
  return await s.h.t.run(async (ctx) =>
    await ctx.db
      .query("dmCloserSchedules")
      .withIndex("by_tenantId_and_dmCloserId_and_weekday_and_effectiveFrom", (q) =>
        q.eq("tenantId", s.h.tenantId).eq("dmCloserId", dmCloserId),
      )
      .take(100),
  );
}

const saveCloser = (s: Setup, scheduledHours: Week | null, dmCloserId: Id<"dmClosers"> = s.northCloser) =>
  s.h.admin.mutation(api.workSchedules.setDmCloserWeeklySchedule, { dmCloserId, scheduledHours });

describe("the dated schedule writer", () => {
  it("refuses a row past the history cap but still lets Undo delete one", async () => {
    const s = await setup();
    // 692 old Monday rows on past dates, plus a full undated week: 699 rows.
    await s.h.t.run(async (ctx) => {
      for (let i = 0; i < 692; i += 1) {
        const day = new Date(Date.UTC(2000, 0, 3 + i * 7)).toISOString().slice(0, 10);
        await ctx.db.insert("dmCloserSchedules", { tenantId: s.h.tenantId, dmCloserId: s.northCloser, weekday: "monday", scheduledHours: 1, effectiveFrom: day, updatedByUserId: s.adminId, updatedAt: 0 });
      }
    });
    await seedUndated(s, "dmCloserSchedules", weekOf(4)); // 699 rows
    // The dated Monday rows are newer than the undated week: Monday is 1 h now.
    const before = { ...weekOf(4), monday: 1 };
    await saveCloser(s, { ...before, tuesday: 6 }); // one insert: 700 rows
    await expect(saveCloser(s, { ...before, tuesday: 6, wednesday: 6 })).rejects.toThrow(/too many times/);
    expect((await saveCloser(s, before)).changedRows).toBe(1); // Undo deletes today's row
  });

  it("dates a first save today and sets all seven days, 0 h included", async () => {
    const s = await setup();
    expect(await saveCloser(s, weekOf(4))).toEqual({ changedRows: 7, effectiveFrom: TODAY });
    const rows = await closerRows(s);
    expect(rows).toHaveLength(7);
    expect(rows.every((row) => row.effectiveFrom === TODAY)).toBe(true);
    expect(weekOn(rows, TODAY)).toEqual(weekOf(4));
    expect(weekOn(rows, YESTERDAY)).toBeNull();
  });

  it("patches today's rows on a second edit the same day", async () => {
    const s = await setup();
    await saveCloser(s, weekOf(4));
    expect(await saveCloser(s, { ...weekOf(4), monday: 6 })).toEqual({ changedRows: 1, effectiveFrom: TODAY });
    const rows = await closerRows(s);
    expect(rows).toHaveLength(7);
    expect(weekOn(rows, TODAY)).toEqual({ ...weekOf(4), monday: 6 });
  });

  it("writes only the changed days, and Undo back to the earlier week deletes today's rows", async () => {
    const s = await setup();
    await seedUndated(s, "dmCloserSchedules", weekOf(4));
    const changed = { ...weekOf(4), monday: 8, saturday: 2 };
    expect((await saveCloser(s, changed)).changedRows).toBe(2);
    expect(await closerRows(s)).toHaveLength(9);
    expect((await saveCloser(s, weekOf(4))).changedRows).toBe(2);
    const rows = await closerRows(s);
    expect(rows).toHaveLength(7);
    expect(rows.every((row) => row.effectiveFrom === undefined)).toBe(true);
  });

  it("Undo to null drops today's change and leaves older rows", async () => {
    const s = await setup();
    await saveCloser(s, weekOf(4));
    expect(await saveCloser(s, null)).toEqual({ changedRows: 7, effectiveFrom: TODAY });
    expect(await closerRows(s)).toEqual([]);

    await seedUndated(s, "dmCloserSchedules", weekOf(5));
    expect((await saveCloser(s, null)).changedRows).toBe(0);
    expect(await closerRows(s)).toHaveLength(7);
  });

  it("leaves yesterday's hours alone", async () => {
    const s = await setup();
    await seedUndated(s, "dmCloserSchedules", weekOf(4));
    await s.h.t.run((ctx) =>
      ctx.db.insert("dmCloserSchedules", {
        tenantId: s.h.tenantId, dmCloserId: s.northCloser, weekday: "monday", scheduledHours: 5,
        effectiveFrom: YESTERDAY, updatedByUserId: s.adminId, updatedAt: 0,
      }),
    );
    await saveCloser(s, { ...weekOf(4), monday: 7, tuesday: 1 });
    const rows = await closerRows(s);
    expect(rows.find((row) => row.effectiveFrom === YESTERDAY)?.scheduledHours).toBe(5);
    expect(weekOn(rows, YESTERDAY)).toEqual({ ...weekOf(4), monday: 5 });
    expect(weekOn(rows, "2026-10-26")).toEqual(weekOf(4));
    expect(weekOn(rows, TODAY)).toEqual({ ...weekOf(4), monday: 7, tuesday: 1 });

    // Saving yesterday's week again deletes today's rows.
    await saveCloser(s, { ...weekOf(4), monday: 5 });
    expect((await closerRows(s)).some((row) => row.effectiveFrom === TODAY)).toBe(false);
  });

  it("lists the week in force today, one row per weekday", async () => {
    const s = await setup();
    await seedUndated(s, "dmCloserSchedules", weekOf(4));
    await saveCloser(s, { ...weekOf(4), monday: 7 });
    const listed = await s.h.admin.query(api.workSchedules.listDmCloserSchedules, {});
    const rows = listed.schedules.filter((row) => row.dmCloserId === s.northCloser);
    expect(rows).toHaveLength(7);
    expect(Object.fromEntries(rows.map((row) => [row.weekday, row.scheduledHours]))).toEqual({ ...weekOf(4), monday: 7 });
  });

  it("dates Slack qualifier and lead gen saves, and the legacy per-day save", async () => {
    const s = await setup();
    await seedUndated(s, "leadGenWorkerSchedules", weekOf(4));
    expect(
      await s.h.admin.mutation(api.workSchedules.setSlackQualifierWeeklySchedule, { slackUserId: "U1", scheduledHours: weekOf(3) }),
    ).toEqual({ changedRows: 7, effectiveFrom: TODAY });
    expect(
      await s.h.admin.mutation(api.workSchedules.setLeadGenWeeklySchedule, { workerId: s.workerId, scheduledHours: { ...weekOf(4), friday: 2 } }),
    ).toEqual({ changedRows: 1, effectiveFrom: TODAY });
    expect(
      await s.h.admin.mutation(api.leadGen.workers.setWorkerSchedule, { workerId: s.workerId, weekday: "monday", scheduledHours: 6 }),
    ).toEqual({ changedRows: 1, effectiveFrom: TODAY });

    const workerRows = await s.h.admin.query(api.leadGen.workers.listWorkerSchedules, { workerId: s.workerId });
    expect(Object.fromEntries(workerRows.map((row) => [row.weekday, row.scheduledHours]))).toEqual({ ...weekOf(4), monday: 6, friday: 2 });
    const dated = workerRows.filter((row) => row.effectiveFrom === TODAY).map((row) => row.weekday).sort();
    expect(dated).toEqual(["friday", "monday"]);
    const slack = await s.h.admin.query(api.workSchedules.listSlackQualifierSchedules, {});
    expect(slack.schedules.filter((row) => row.slackUserId === "U1")).toHaveLength(7);
  });
});

describe("readers after a save today", () => {
  it("Qualifications keeps yesterday's hours and per-hour figures", async () => {
    const s = await setup();
    await seedUndated(s, "slackQualifierSchedules", weekOf(4));
    await s.h.t.run(async (ctx) => {
      const submittedAt = businessDayStart(YESTERDAY, DEFAULT_BUSINESS_DAY) + 3 * HOUR;
      await ctx.db.insert("slackQualificationEvents", {
        tenantId: s.h.tenantId, installationId: s.installationId, resultKind: "unlinked",
        qualifiedBy: { slackUserId: "U1", slackTeamId: "T1", submittedAt },
        slackUserId: "U1", slackTeamId: "T1", fullNameSnapshot: "Lead", platform: "instagram", handleSnapshot: "lead",
        submittedAt, createdAt: submittedAt,
      });
    });
    const read = () => s.h.admin.query(api.operations.qualificationsDashboard.getQualificationsDashboard, range(YESTERDAY, YESTERDAY));
    const before = await read();
    expect(before.openers.find((row) => row.key === "U1")).toMatchObject({ scheduledHours: 4, qualifiedPerHour: 0.25 });

    await s.h.admin.mutation(api.workSchedules.setSlackQualifierWeeklySchedule, { slackUserId: "U1", scheduledHours: weekOf(8) });
    expect(await read()).toEqual(before);
    const today = await s.h.admin.query(api.operations.qualificationsDashboard.getQualificationsDashboard, range(TODAY, TODAY));
    expect(today.openers.find((row) => row.key === "U1")?.scheduledHours).toBe(8);
  });

  it("Booked Calls keeps yesterday's hours", async () => {
    const s = await setup();
    await seedUndated(s, "dmCloserSchedules", weekOf(4));
    const read = () => s.h.admin.query(api.operations.bookedCallsDashboard.getBookedCallsDashboard, range(YESTERDAY, YESTERDAY));
    const before = await read();
    expect(before.dmClosers.find((row) => row.key === s.northCloser)?.scheduledHours).toBe(4);

    await saveCloser(s, weekOf(6));
    expect(await read()).toEqual(before);
    const today = await s.h.admin.query(api.operations.bookedCallsDashboard.getBookedCallsDashboard, range(TODAY, TODAY));
    expect(today.dmClosers.find((row) => row.key === s.northCloser)?.scheduledHours).toBe(6);
  });

  it("Lead Gen keeps yesterday's hours and leads per hour", async () => {
    const s = await setup();
    await seedUndated(s, "leadGenWorkerSchedules", weekOf(4));
    await s.h.t.run(async (ctx) => {
      for (const dayKey of [YESTERDAY, TODAY]) {
        await ctx.db.insert("leadGenDailyStats", {
          tenantId: s.h.tenantId, statKey: `stat:${dayKey}`, dayKey, workerId: s.workerId, userId: s.adminId,
          source: "instagram", submissions: 8, uniqueProspectsSubmitted: 8, duplicateProspectSubmissions: 0,
          scheduledHours: 4, updatedAt: 0,
        });
      }
    });
    const read = (dayKey: string) => s.h.admin.query(api.leadGen.reporting.listWorkerPerformance, { startDayKey: dayKey, endDayKey: dayKey });
    const before = await read(YESTERDAY);
    expect(before[0]).toMatchObject({ scheduledHours: 4, leadsPerHour: 2 });

    await s.h.admin.mutation(api.workSchedules.setLeadGenWeeklySchedule, { workerId: s.workerId, scheduledHours: weekOf(2) });
    expect(await read(YESTERDAY)).toEqual(before);
    expect((await read(TODAY))[0]).toMatchObject({ scheduledHours: 2, leadsPerHour: 4 });
  });

  it("the report snapshot job counts a dated row only on the days it was in force", async () => {
    const s = await setup();
    await seedUndated(s, "dmCloserSchedules", weekOf(4));
    await saveCloser(s, { ...weekOf(4), monday: 10 });
    // Last Monday (Oct 26) and yesterday (Nov 2) under the undated week, today under the new one.
    const request: ReportSourcePageRequest = {
      tenantId: s.h.tenantId, reportKind: "booked-calls", sourceKey: "dm_closer_schedules",
      startTimestamp: businessDayStart(WEEK_START, DEFAULT_BUSINESS_DAY),
      endTimestampExclusive: businessDayStart("2026-11-04", DEFAULT_BUSINESS_DAY),
      startDayKey: WEEK_START, endDayKeyExclusive: "2026-11-04",
      sourceFilter: "all", teamId: null, workerId: null, cursor: null,
    };
    const page = await s.h.t.run((ctx) => readSourcePage(ctx, request));
    const monday = page.page.filter((row) => row.kind === "dm_closer_schedule" && row.weekday === "monday");
    expect(monday.map((row) => [row.kind === "dm_closer_schedule" ? row.scheduledHours : 0, row.kind === "dm_closer_schedule" ? row.occurrences : 0]).sort())
      .toEqual([[10, 0], [4, 2]].sort());
    const contributions = reduceReportSourcePage({
      sourceKey: "dm_closer_schedules",
      range: {
        input: { kind: "custom", startBusinessDate: WEEK_START, endBusinessDateInclusive: TODAY },
        startBusinessDate: WEEK_START, endBusinessDateInclusive: TODAY, endBusinessDateExclusive: "2026-11-04",
        startDayKey: WEEK_START, endDayKeyExclusive: "2026-11-04", dayCount: 9, label: "test",
        startTimestamp: request.startTimestamp, endTimestampExclusive: request.endTimestampExclusive,
        boundary: "tenant_business_day", businessDay: DEFAULT_BUSINESS_DAY,
      } as Parameters<typeof reduceReportSourcePage>[0]["range"],
      rows: page.page,
    });
    const hours = contributions
      .filter((row) => row.section === "booked_closer_schedule" && row.field === "scheduledHours")
      .reduce((sum, row) => sum + (typeof row.value === "number" ? row.value : 0), 0);
    // Two Mondays at 4 h, two Tuesdays at 4 h (one today), Wed–Fri once each.
    expect(hours).toBe(4 * 2 + 4 * 2 + 4 * 3);
  });
});

describe("goal days", () => {
  it("counts 5 for a Mon–Fri team over a full week, and every day for a team with no schedules", async () => {
    const s = await setup();
    await seedUndated(s, "dmCloserSchedules", weekOf(4));
    const dashboard = await s.h.admin.query(api.operations.bookedCallsDashboard.getBookedCallsDashboard, range(WEEK_START, WEEK_END));
    const north = dashboard.goal.teams.find((team) => team.teamId === s.north)!;
    const south = dashboard.goal.teams.find((team) => team.teamId === s.south)!;
    expect(north).toMatchObject({ goalDayCount: 5, target: 10 });
    expect(south).toMatchObject({ goalDayCount: 7, target: 14 });
    expect(dashboard.goal.totalTarget).toBe(24);
  });

  it("skips the days no Slack qualifier works, ignoring deleted Slack users", async () => {
    const s = await setup();
    await seedUndated(s, "slackQualifierSchedules", weekOf(4));
    await s.h.t.run(async (ctx) => {
      // A deleted Slack user's weekend hours don't make the weekend count.
      for (const weekday of ["saturday", "sunday"] as const) {
        await ctx.db.insert("slackQualifierSchedules", {
          tenantId: s.h.tenantId, slackUserId: "U2", weekday, scheduledHours: 6, updatedByUserId: s.adminId, updatedAt: 0,
        });
      }
    });
    const dashboard = await s.h.admin.query(api.operations.qualificationsDashboard.getQualificationsDashboard, range(WEEK_START, WEEK_END));
    expect(dashboard.goal).toMatchObject({ businessDayCount: 7, goalDayCount: 5, target: 15 });
  });

  it("counts every day until a qualifier has hours", async () => {
    const s = await setup();
    const dashboard = await s.h.admin.query(api.operations.qualificationsDashboard.getQualificationsDashboard, range(WEEK_START, WEEK_END));
    expect(dashboard.goal).toMatchObject({ goalDayCount: 7, target: 21 });
  });
});

describe("merges with goal days", () => {
  it("adds Booked Calls goal days across the split, and falls back to day counts", async () => {
    const s = await setup();
    await seedUndated(s, "dmCloserSchedules", weekOf(4));
    const answers = await expectMergedAnswer({
      t: s.h.t,
      identity: { subject: "user_admin", org_id: "org_test" },
      live: api.operations.bookedCallsDashboard.getBookedCallsDashboard,
      history: range(WEEK_START, "2026-10-29"),
      today: range("2026-10-30", WEEK_END),
      whole: range(WEEK_START, WEEK_END),
      merge: mergeBookedCallsDashboard,
    });
    expect(answers.history.goal.teams.find((team) => team.teamId === s.north)?.goalDayCount).toBe(4);
    expect(answers.today.goal.teams.find((team) => team.teamId === s.north)?.goalDayCount).toBe(1);

    // An answer cached before goal days counted every day of its window.
    const legacy = {
      ...answers.history,
      goal: { ...answers.history.goal, teams: answers.history.goal.teams.map(({ goalDayCount: _, ...team }) => team) },
    } as unknown as typeof answers.history;
    const merged = mergeBookedCallsDashboard(legacy, answers.today);
    expect(merged.goal.teams.find((team) => team.teamId === s.north)).toMatchObject({ goalDayCount: 4 + 1, target: 10 });
  });

  it("adds Qualifications goal days across the split", async () => {
    const s = await setup();
    await seedUndated(s, "slackQualifierSchedules", weekOf(4, ["monday", "saturday"]));
    await s.h.t.run(async (ctx) => {
      for (const dayKey of ["2026-10-26", "2026-10-31"]) {
        const submittedAt = businessDayStart(dayKey, DEFAULT_BUSINESS_DAY) + 3 * HOUR;
        await ctx.db.insert("slackQualificationEvents", {
          tenantId: s.h.tenantId, installationId: s.installationId, resultKind: "unlinked",
          qualifiedBy: { slackUserId: "U1", slackTeamId: "T1", submittedAt },
          slackUserId: "U1", slackTeamId: "T1", fullNameSnapshot: "Lead", platform: "instagram", handleSnapshot: "lead",
          submittedAt, createdAt: submittedAt,
        });
      }
    });
    const identity = { subject: "user_admin", org_id: "org_test" };
    const dashboards = await expectMergedAnswer({
      t: s.h.t,
      identity,
      live: api.operations.qualificationsDashboard.getQualificationsDashboard,
      history: range(WEEK_START, "2026-10-29"),
      today: range("2026-10-30", WEEK_END),
      whole: range(WEEK_START, WEEK_END),
      merge: mergeQualificationsDashboard,
    });
    expect(dashboards.whole.goal).toMatchObject({ goalDayCount: 2, target: 6 });
    const { goalDayCount: _, ...legacyGoal } = dashboards.history.goal;
    const legacy = { ...dashboards.history, goal: legacyGoal } as unknown as typeof dashboards.history;
    expect(mergeQualificationsDashboard(legacy, dashboards.today).goal)
      .toMatchObject({ goalDayCount: 4 + 1, target: 15 });
  });
});
