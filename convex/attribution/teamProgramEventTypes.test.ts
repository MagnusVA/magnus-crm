import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { convexTestModules } from "../test.setup";

const PORTAL_SLUG = "team-routes";

describe("team program event types", () => {
  it("validates program and mode, and rejects closers", async () => {
    const fixture = await createFixture();

    await expect(
      fixture.admin.mutation(
        api.attribution.teamProgramEventTypes.setTeamProgramEventType,
        {
          teamId: fixture.teamA,
          programId: fixture.programId,
          mode: "extended",
          eventTypeConfigId: fixture.poolA,
        },
      ),
    ).rejects.toThrow("is not a Standard event type");

    await expect(
      fixture.admin.mutation(
        api.attribution.teamProgramEventTypes.setTeamProgramEventType,
        {
          teamId: fixture.teamA,
          programId: fixture.programId,
          mode: "normal",
          eventTypeConfigId: fixture.standardPool,
        },
      ),
    ).rejects.toThrow("is not a Priority event type");

    await expect(
      fixture.admin.mutation(
        api.attribution.teamProgramEventTypes.setTeamProgramEventType,
        {
          teamId: fixture.teamA,
          programId: fixture.otherProgramId,
          mode: "normal",
          eventTypeConfigId: fixture.poolA,
        },
      ),
    ).rejects.toThrow("is not mapped to");

    await expect(
      fixture.closer.mutation(
        api.attribution.teamProgramEventTypes.setTeamProgramEventType,
        {
          teamId: fixture.teamA,
          programId: fixture.programId,
          mode: "normal",
          eventTypeConfigId: fixture.poolA,
        },
      ),
    ).rejects.toThrow("Insufficient permissions");
  });

  it("shows a routed team only its event types and other teams the shared ones", async () => {
    const fixture = await createFixture();
    await routeTeamA(fixture);

    const bootstrap = await fixture.t.query(
      internal.linkPortal.portalQueries.getPortalBootstrapForSession,
      { tenantId: fixture.tenantId, publicSlug: PORTAL_SLUG, sessionVersion: 1 },
    );

    const closerA = bootstrap.dmClosers.find(
      (row) => row.id === fixture.dmCloserA,
    );
    const closerB = bootstrap.dmClosers.find(
      (row) => row.id === fixture.dmCloserB,
    );
    expect(closerA?.teamHasEventTypeRoutes).toBe(true);
    expect(closerB?.teamHasEventTypeRoutes).toBe(false);

    const poolA = bootstrap.bookablePrograms.find(
      (row) => row.eventTypeConfigId === fixture.poolA,
    );
    const shared = bootstrap.bookablePrograms.find(
      (row) => row.eventTypeConfigId === fixture.sharedPool,
    );
    expect(poolA).toMatchObject({ isShared: false, routedTeamIds: [fixture.teamA] });
    expect(shared).toMatchObject({ isShared: true, routedTeamIds: [] });
  });

  it("rejects copying a link for an event type the team can't use", async () => {
    const fixture = await createFixture();
    await routeTeamA(fixture);

    const copy = (
      dmCloserId: Id<"dmClosers">,
      eventTypeConfigId: Id<"eventTypeConfigs">,
    ) =>
      fixture.t.mutation(internal.linkPortal.copyMutations.insertCopyEvent, {
        tenantId: fixture.tenantId,
        publicSlug: PORTAL_SLUG,
        sessionVersion: 1,
        sessionIdHash: "session",
        eventTypeConfigId,
        dmCloserId,
        campaignPresetId: fixture.campaignId,
      });

    await expect(copy(fixture.dmCloserA, fixture.poolA)).resolves.toBeDefined();
    await expect(copy(fixture.dmCloserA, fixture.sharedPool)).rejects.toThrow(
      "not available for this team",
    );
    await expect(copy(fixture.dmCloserB, fixture.poolA)).rejects.toThrow(
      "not available for this team",
    );
    await expect(copy(fixture.dmCloserB, fixture.sharedPool)).resolves.toBeDefined();
  });

  it("ignores a route whose event type moved to another program", async () => {
    const fixture = await createFixture();
    await routeTeamA(fixture);
    await fixture.t.run(async (ctx) => {
      await ctx.db.patch("eventTypeConfigs", fixture.poolA, {
        bookingProgramId: fixture.otherProgramId,
      });
    });

    await expect(
      fixture.t.mutation(internal.linkPortal.copyMutations.insertCopyEvent, {
        tenantId: fixture.tenantId,
        publicSlug: PORTAL_SLUG,
        sessionVersion: 1,
        sessionIdHash: "session",
        eventTypeConfigId: fixture.poolA,
        dmCloserId: fixture.dmCloserA,
        campaignPresetId: fixture.campaignId,
      }),
    ).rejects.toThrow("not available for this team");
  });
});

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function routeTeamA(fixture: Fixture) {
  await fixture.admin.mutation(
    api.attribution.teamProgramEventTypes.setTeamProgramEventType,
    {
      teamId: fixture.teamA,
      programId: fixture.programId,
      mode: "normal",
      eventTypeConfigId: fixture.poolA,
    },
  );
}

async function createFixture() {
  const t = convexTest({ schema, modules: convexTestModules });
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const tenantId = await ctx.db.insert("tenants", {
      companyName: "Tenant A",
      contactEmail: "a@example.invalid",
      workosOrgId: "org_a",
      status: "active",
      inviteExpiresAt: now + 60_000,
      createdBy: "test",
    });
    const adminId = await ctx.db.insert("users", {
      tenantId,
      workosUserId: "admin_a",
      email: "admin-a@example.invalid",
      role: "tenant_admin",
      isActive: true,
    });
    await ctx.db.insert("users", {
      tenantId,
      workosUserId: "closer_a",
      email: "closer-a@example.invalid",
      role: "closer",
      isActive: true,
    });

    const insertProgram = (name: string) =>
      ctx.db.insert("tenantPrograms", {
        tenantId,
        name,
        normalizedName: name.toLowerCase(),
        createdAt: now,
        createdByUserId: adminId,
        updatedAt: now,
      });
    const programId = await insertProgram("Program X");
    const otherProgramId = await insertProgram("Program Y");

    const insertEventType = (displayName: string, isExtended = false) =>
      ctx.db.insert("eventTypeConfigs", {
        tenantId,
        calendlyEventTypeUri: `https://api.calendly.com/event_types/${displayName}`,
        displayName,
        isExtended,
        createdAt: now,
        bookingProgramId: programId,
        bookingProgramName: "Program X",
        bookingProgramMappingStatus: "mapped",
        bookingBaseUrl: `https://calendly.com/test/${displayName}`,
        bookingUrlSource: "admin_entered",
        linkPortalEnabled: true,
      });
    const poolA = await insertEventType("pool-a");
    const sharedPool = await insertEventType("shared-pool");
    const standardPool = await insertEventType("standard-pool", true);

    const insertTeam = (slug: string) =>
      ctx.db.insert("attributionTeams", {
        tenantId,
        slug,
        displayName: slug,
        utmSource: slug,
        normalizedUtmSource: slug,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });
    const teamA = await insertTeam("team-a");
    const teamB = await insertTeam("team-b");

    const insertDmCloser = (teamId: Id<"attributionTeams">, slug: string) =>
      ctx.db.insert("dmClosers", {
        tenantId,
        teamId,
        slug,
        displayName: slug,
        utmMedium: slug,
        normalizedUtmMedium: slug,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });
    const dmCloserA = await insertDmCloser(teamA, "dm-a");
    const dmCloserB = await insertDmCloser(teamB, "dm-b");

    await ctx.db.insert("linkPortalConfigs", {
      tenantId,
      publicSlug: PORTAL_SLUG,
      isEnabled: true,
      sessionVersion: 1,
      sessionTtlSeconds: 3600,
      createdAt: now,
      updatedAt: now,
    });
    const campaignId = await ctx.db.insert("linkPortalCampaignPresets", {
      tenantId,
      slug: "default",
      label: "Default",
      utmCampaign: "default",
      normalizedUtmCampaign: "default",
      isDefault: true,
      isActive: true,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });

    return {
      tenantId,
      programId,
      otherProgramId,
      poolA,
      sharedPool,
      standardPool,
      teamA,
      teamB,
      dmCloserA,
      dmCloserB,
      campaignId,
    };
  });

  return {
    t,
    ...ids,
    admin: t.withIdentity({ subject: "admin_a", org_id: "org_a" }),
    closer: t.withIdentity({ subject: "closer_a", org_id: "org_a" }),
  };
}
