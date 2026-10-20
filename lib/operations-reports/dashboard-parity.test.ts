import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import schema from "../../convex/schema";
import { convexTestModules } from "../../convex/test.setup";
import {
  qualificationDashboardFromLive,
  qualificationDashboardFromSnapshot,
} from "./qualification-dashboard";
import {
  bookedCallsDashboardFromLive,
  bookedCallsDashboardFromSnapshot,
  type BookedCallsDashboardViewModel,
} from "./booked-dashboard";
import {
  BOOKED_CALLS_ADMIN,
  BOOKED_CALLS_RANGE,
  seedBookedCallsFixture,
} from "../../tests/bookedCallsFixture";

const range = {
  kind: "custom" as const,
  startBusinessDate: "2026-08-14",
  endBusinessDateInclusive: "2026-08-14",
};
const timestamp = Date.parse("2026-08-14T18:00:00.000Z");

it("keeps qualifications live dashboard and worker-backed snapshot view models aligned", async () => {
  const t = convexTest({ schema, modules: convexTestModules });
  const fixture = await t.run(async (ctx) => {
    const tenantId = await ctx.db.insert("tenants", {
      companyName: "Qualification parity",
      contactEmail: "qualification-parity@example.invalid",
      workosOrgId: "org_qualification_parity",
      status: "active",
      inviteExpiresAt: timestamp + 60_000,
      createdBy: "test",
    });
    const adminId = await ctx.db.insert("users", {
      tenantId,
      workosUserId: "qualification-admin",
      email: "qualification-admin@example.invalid",
      role: "tenant_admin",
      isActive: true,
    });
    const installationId = await ctx.db.insert("slackInstallations", {
      tenantId,
      teamId: "qualification-team",
      teamName: "Qualification fixture",
      isEnterpriseInstall: false,
      appId: "qualification-app",
      botUserId: "qualification-bot",
      botAccessToken: "fixture",
      scopes: [],
      installedByWorkosUserId: "qualification-admin",
      installedAt: timestamp,
      tokenExpiresAt: 0,
      refreshToken: "fixture",
      status: "active",
    });
    const activeSlackUserId = await ctx.db.insert("slackUsers", {
      tenantId,
      installationId,
      slackUserId: "slack-active",
      slackTeamId: "qualification-team",
      username: "avery",
      displayName: "Avery Active",
      avatarUrl: "https://example.invalid/avery.png",
      isBot: false,
      isDeleted: false,
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      lastSyncedAt: timestamp,
    });
    const zeroSlackUserId = await ctx.db.insert("slackUsers", {
      tenantId,
      installationId,
      slackUserId: "slack-zero",
      slackTeamId: "qualification-team",
      username: "zoe",
      displayName: "Zoe Zero",
      isBot: false,
      isDeleted: false,
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      lastSyncedAt: timestamp,
    });
    for (const [slackUserId, scheduledHours] of [
      ["slack-active", 4],
      ["slack-zero", 2],
    ] as const) {
      await ctx.db.insert("slackQualifierSchedules", {
        tenantId,
        slackUserId,
        weekday: "friday",
        scheduledHours,
        updatedByUserId: adminId,
        updatedAt: timestamp,
      });
    }
    await ctx.db.insert("slackQualificationEvents", {
      tenantId,
      installationId,
      resultKind: "created_opportunity",
      qualifiedBy: {
        slackUserId: "slack-active",
        slackTeamId: "qualification-team",
        submittedAt: timestamp,
      },
      slackUserId: "slack-active",
      slackTeamId: "qualification-team",
      fullNameSnapshot: "Prospect Avery",
      platform: "instagram",
      handleSnapshot: "prospect-avery",
      submittedAt: timestamp,
      createdAt: timestamp,
    });
    return { activeSlackUserId, zeroSlackUserId };
  });
  const authed = t.withIdentity({
    subject: "qualification-admin",
    org_id: "org_qualification_parity",
  });

  const live = await authed.query(
    api.operations.qualificationsDashboard.getQualificationsDashboard,
    { range },
  );
  expect(live.capped).toBe(false);
  expect(live.goal.dailyQuota).toBeNull();
  expect(live.openers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        key: "slack-active",
        qualified: 1,
        scheduledHours: 4,
        avatar: expect.objectContaining({
          id: fixture.activeSlackUserId,
          name: "Avery Active",
          imageSource: "slack",
          source: "slack",
        }),
      }),
      expect.objectContaining({
        key: "slack-zero",
        qualified: 0,
        scheduledHours: 2,
        avatar: expect.objectContaining({
          id: fixture.zeroSlackUserId,
          name: "Zoe Zero",
          imageSource: "none",
          source: "slack",
        }),
      }),
    ]),
  );

  const { jobId } = await authed.mutation(
    api.operations.reports.jobs.requestDashboardReport,
    {
      reportKind: "qualifications",
      range,
      requestToken: "qualification-dashboard-parity",
    },
  );
  for (let step = 0; step < 20; step += 1) {
    await t.action(internal.operations.reports.worker.run, { jobId });
    const job = await t.run(async (ctx) => await ctx.db.get(jobId));
    if (job?.status === "ready") break;
    expect(job?.status).toBe("queued");
  }

  const [summary, openers] = await Promise.all([
    authed.query(api.operations.reports.jobs.getDashboardReportSummary, {
      jobId,
    }),
    authed.query(api.operations.reports.jobs.listDashboardReportRows, {
      jobId,
      section: "qualification_opener",
      paginationOpts: { cursor: null, numItems: 100 },
    }),
  ]);
  expect(summary).not.toBeNull();
  expect(openers.isDone).toBe(true);
  expect(openers.page).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        rowKey: "slack-active",
        payload: expect.objectContaining({
          label: "Avery Active",
          slackUsername: "avery",
          qualified: 1,
          scheduledHours: 4,
          identityId: fixture.activeSlackUserId,
          identityImageSource: "slack",
        }),
      }),
      expect.objectContaining({
        rowKey: "slack-zero",
        payload: expect.objectContaining({
          label: "Zoe Zero",
          qualified: 0,
          scheduledHours: 2,
          identityId: fixture.zeroSlackUserId,
        }),
      }),
    ]),
  );

  const snapshot = qualificationDashboardFromSnapshot({
    summary: summary!,
    openers: openers.page,
  });
  expect(snapshot).toEqual({
    data: qualificationDashboardFromLive(live),
    error: null,
  });
});

// The fixture's booking rows are the ones the pipeline writes for each booking
// (recordBookingAttribution). The copied columns are either set the way the
// pipeline still writes them or left unset; the numbers must not change.
describe.each(["pipeline", "none"] as const)(
  "booked calls parity with copies: %s",
  (copies) => {
    it("keeps the live dashboard and the worker-backed snapshot aligned", async () => {
      const t = convexTest({ schema, modules: convexTestModules });
      const fixture = await t.run(
        async (ctx) => await seedBookedCallsFixture(ctx, { copies }),
      );
      const authed = t.withIdentity(BOOKED_CALLS_ADMIN);

      const live = await authed.query(
        api.operations.bookedCallsDashboard.getBookedCallsDashboard,
        { range: BOOKED_CALLS_RANGE },
      );
      expect(live.capped).toBe(false);
      expect(live.goal.totalTarget).toBe(3);
      // South's only first booking named a team and no DM closer (D9).
      expect(live.goal.teams).toEqual([
        expect.objectContaining({ teamId: fixture.teams.north, progress: 3 }),
        expect.objectContaining({ teamId: fixture.teams.south, progress: 1 }),
      ]);
      expect(live.totalBooked).toBe(3);
      expect(live.goal.progress).toBe(4);
      expect(live.dmClosers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: fixture.dmClosers.northA,
            label: "Avery North",
            teamLabel: "North Team",
            booked: 1,
            scheduledHours: 4,
            hourlyRateMinor: null,
            avatar: expect.objectContaining({
              id: fixture.linkedUserId,
              name: "Avery Linked",
              imageSource: "workos",
              source: "crm_user",
            }),
          }),
          expect.objectContaining({
            key: fixture.dmClosers.southC,
            label: "Casey South",
            teamLabel: "South Team",
            booked: 0,
            scheduledHours: 2,
          }),
        ]),
      );
      expect(live.dmClosers.reduce((sum, row) => sum + row.booked, 0)).toBe(3);

      const { jobId } = await authed.mutation(
        api.operations.reports.jobs.requestDashboardReport,
        {
          reportKind: "booked-calls",
          range: BOOKED_CALLS_RANGE,
          requestToken: `booked-dashboard-parity-${copies}`,
        },
      );
      for (let step = 0; step < 40; step += 1) {
        await t.action(internal.operations.reports.worker.run, { jobId });
        const job = await t.run(async (ctx) => await ctx.db.get(jobId));
        if (job?.status === "ready") break;
        expect(job?.status).toBe("queued");
      }

      const [summary, closers, teams] = await Promise.all([
        authed.query(api.operations.reports.jobs.getDashboardReportSummary, {
          jobId,
        }),
        authed.query(api.operations.reports.jobs.listDashboardReportRows, {
          jobId,
          section: "booked_closer",
          paginationOpts: { cursor: null, numItems: 100 },
        }),
        authed.query(api.operations.reports.jobs.listDashboardReportRows, {
          jobId,
          section: "booking_team",
          paginationOpts: { cursor: null, numItems: 100 },
        }),
      ]);
      expect(summary).not.toBeNull();
      expect(summary!.payload).toMatchObject({ totalBooked: 3, progress: 4 });
      expect(closers.isDone).toBe(true);
      expect(teams.isDone).toBe(true);
      expect(closers.page).toContainEqual(
        expect.objectContaining({
          rowKey: fixture.dmClosers.northA,
          payload: expect.objectContaining({
            label: "Avery North",
            teamId: fixture.teams.north,
            teamLabel: "North Team",
            booked: 1,
            hourlyRateMinor: null,
            identityId: fixture.linkedUserId,
            identityName: "Avery Linked",
            identityImageSource: "workos",
          }),
        }),
      );
      expect(
        Object.fromEntries(
          closers.page.map((row) => [row.rowKey, row.payload.booked]),
        ),
      ).toEqual({
        [fixture.dmClosers.northA]: 1,
        [fixture.dmClosers.northA2]: 1,
        [fixture.dmClosers.northB]: 1,
        [fixture.dmClosers.southC]: 0,
      });
      expect(
        Object.fromEntries(
          teams.page.map((row) => [row.rowKey, row.payload.progress]),
        ),
      ).toEqual({ [fixture.teams.north]: 3, [fixture.teams.south]: 1 });
      expect(teams.page).toContainEqual(
        expect.objectContaining({
          rowKey: fixture.teams.south,
          payload: expect.objectContaining({
            label: "South Team",
            dailyQuota: 1,
            target: 1,
            progress: 1,
          }),
        }),
      );

      const snapshot = bookedCallsDashboardFromSnapshot({
        summary: summary!,
        dmClosers: closers.page,
        teams: teams.page,
      });
      expect(snapshot.error).toBeNull();
      // Rows that tie on their count can come back in another order.
      expect(inStableOrder(snapshot.data!)).toEqual(
        inStableOrder(bookedCallsDashboardFromLive(live)),
      );
    });
  },
);

function inStableOrder(view: BookedCallsDashboardViewModel) {
  return {
    ...view,
    dmClosers: [...view.dmClosers].sort((a, b) => a.key.localeCompare(b.key)),
    goal: {
      ...view.goal,
      teams: [...view.goal.teams].sort((a, b) =>
        a.label.localeCompare(b.label),
      ),
    },
  };
}
