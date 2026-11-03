import { convexTest } from "convex-test";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { convexTestModules } from "../convex/test.setup";
import { registerComponents } from "./bookingHarness";

// One tenant with two programs, three portal-visible event types (pool-a,
// shared-pool and a Standard pool in Program X), two DM teams with one DM
// closer each, an enabled portal and a default campaign.
export const PORTAL_SLUG = "team-routes";

export type Fixture = Awaited<ReturnType<typeof createFixture>>;

export async function routeTeamA(fixture: Fixture) {
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

export async function createFixture() {
  const t = convexTest({ schema, modules: convexTestModules });
  registerComponents(t);
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
