import { convexTest } from "convex-test";
import { expect, it } from "vitest";
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
} from "./booked-dashboard";

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

it("keeps booked calls live dashboard and worker-backed snapshot view models aligned", async () => {
  const t = convexTest({ schema, modules: convexTestModules });
  const fixture = await t.run(async (ctx) => {
    const tenantId = await ctx.db.insert("tenants", {
      companyName: "Booked parity",
      contactEmail: "booked-parity@example.invalid",
      workosOrgId: "org_booked_parity",
      status: "active",
      inviteExpiresAt: timestamp + 60_000,
      createdBy: "test",
    });
    const adminId = await ctx.db.insert("users", {
      tenantId,
      workosUserId: "booked-admin",
      email: "booked-admin@example.invalid",
      role: "tenant_admin",
      isActive: true,
    });
    const linkedUserId = await ctx.db.insert("users", {
      tenantId,
      workosUserId: "linked-dm-user",
      email: "linked-dm-user@example.invalid",
      fullName: "Linked User Name",
      profilePictureUrl: "https://example.invalid/linked-user.png",
      role: "closer",
      isActive: true,
    });
    const teamId = await ctx.db.insert("attributionTeams", {
      tenantId,
      slug: "north",
      displayName: "North Team",
      utmSource: "north",
      normalizedUtmSource: "north",
      isActive: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const activeCloserId = await ctx.db.insert("dmClosers", {
      tenantId,
      teamId,
      slug: "original-dm",
      displayName: "Original DM Display",
      utmMedium: "original-dm",
      normalizedUtmMedium: "original-dm",
      userId: linkedUserId,
      isActive: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const zeroCloserId = await ctx.db.insert("dmClosers", {
      tenantId,
      teamId,
      slug: "scheduled-zero",
      displayName: "Scheduled Zero",
      utmMedium: "scheduled-zero",
      normalizedUtmMedium: "scheduled-zero",
      isActive: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await ctx.db.insert("dmCloserSchedules", {
      tenantId,
      dmCloserId: activeCloserId,
      weekday: "friday",
      scheduledHours: 4,
      updatedByUserId: adminId,
      updatedAt: timestamp,
    });
    await ctx.db.insert("dmCloserSchedules", {
      tenantId,
      dmCloserId: zeroCloserId,
      weekday: "friday",
      scheduledHours: 2,
      updatedByUserId: adminId,
      updatedAt: timestamp,
    });
    const leadId = await ctx.db.insert("leads", {
      tenantId,
      fullName: "Booked Prospect",
      firstSeenAt: timestamp,
      updatedAt: timestamp,
      status: "active",
    });
    const opportunityId = await ctx.db.insert("opportunities", {
      tenantId,
      leadId,
      status: "scheduled",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    for (const [suffix, attributionTeamId] of [
      ["attributed", teamId],
      ["unattributed", undefined],
    ] as const) {
      await ctx.db.insert("meetings", {
        tenantId,
        opportunityId,
        assignedCloserId: adminId,
        calendlyEventUri: `https://example.invalid/event/${suffix}`,
        calendlyInviteeUri: `https://example.invalid/invitee/${suffix}`,
        scheduledAt: timestamp + 3_600_000,
        durationMinutes: 30,
        status: "scheduled",
        callClassification: "new",
        leadName: "Booked Prospect",
        createdAt: timestamp,
        attributionTeamId,
        dmCloserId: activeCloserId,
      });
    }
    return { activeCloserId, linkedUserId, teamId, zeroCloserId };
  });
  const authed = t.withIdentity({
    subject: "booked-admin",
    org_id: "org_booked_parity",
  });

  const live = await authed.query(
    api.operations.bookedCallsDashboard.getBookedCallsDashboard,
    { range },
  );
  expect(live.capped).toBe(false);
  expect(live.goal.totalTarget).toBeNull();
  expect(live.goal.teams).toEqual([
    expect.objectContaining({
      teamId: fixture.teamId,
      label: "North Team",
      dailyQuota: null,
      progress: 1,
    }),
  ]);
  expect(live.dmClosers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        key: fixture.activeCloserId,
        label: "Original DM Display",
        booked: 2,
        scheduledHours: 4,
        hourlyRateMinor: null,
        avatar: expect.objectContaining({
          id: fixture.linkedUserId,
          name: "Linked User Name",
          imageSource: "workos",
          source: "crm_user",
        }),
      }),
      expect.objectContaining({
        key: fixture.zeroCloserId,
        label: "Scheduled Zero",
        booked: 0,
        scheduledHours: 2,
        hourlyRateMinor: null,
      }),
    ]),
  );

  const { jobId } = await authed.mutation(
    api.operations.reports.jobs.requestDashboardReport,
    {
      reportKind: "booked-calls",
      range,
      requestToken: "booked-dashboard-parity",
    },
  );
  for (let step = 0; step < 20; step += 1) {
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
  expect(closers.isDone).toBe(true);
  expect(teams.isDone).toBe(true);
  expect(closers.page).toContainEqual(
    expect.objectContaining({
      rowKey: fixture.activeCloserId,
      payload: expect.objectContaining({
        label: "Original DM Display",
        teamId: fixture.teamId,
        teamLabel: "North Team",
        hourlyRateMinor: null,
        identityId: fixture.linkedUserId,
        identityName: "Linked User Name",
        identityImageSource: "workos",
      }),
    }),
  );
  expect(teams.page).toEqual([
    expect.objectContaining({
      rowKey: fixture.teamId,
      payload: expect.objectContaining({
        label: "North Team",
        dailyQuota: null,
        target: null,
        progress: 1,
      }),
    }),
  ]);

  const snapshot = bookedCallsDashboardFromSnapshot({
    summary: summary!,
    dmClosers: closers.page,
    teams: teams.page,
  });
  expect(snapshot).toEqual({
    data: bookedCallsDashboardFromLive(live),
    error: null,
  });
});
