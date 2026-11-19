import { describe, expect, it } from "vitest";
import { bookingHarness, testLeadGenTeam } from "../../tests/bookingHarness";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const PORTAL_SLUG = "portal";
const CALENDLY = "https://api.calendly.com";

type CloserOverrides = Partial<Pick<Doc<"users">, "isActive" | "deletedAt" | "closerLinkInPortalAt">>;
type CalendarKind = "one-on-one" | "round_robin";

async function seedCloser(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  slug: string,
  { ready = true, kind = "one-on-one", ...overrides }: CloserOverrides & { ready?: boolean; kind?: CalendarKind } = {},
) {
  const url = `https://calendly.com/${slug}/sales`;
  const calendlyUserUri = `${CALENDLY}/users/${slug}`;
  const calendlyEventTypeUri = `${CALENDLY}/event_types/${slug}`;
  const userId = await ctx.db.insert("users", {
    tenantId,
    workosUserId: `user_${slug}`,
    email: `${slug}@example.com`,
    fullName: slug,
    role: "closer",
    isActive: true,
    closerLinkInPortalAt: NOW,
    calendlyUserUri,
    personalEventTypeUri: url,
    ...overrides,
  });
  const configId = await ctx.db.insert("eventTypeConfigs", {
    tenantId,
    displayName: "Personal sales call",
    calendlyEventTypeUri,
    calendlyOwnerUri: calendlyUserUri,
    calendlyKind: "solo",
    ...(kind === "round_robin" ? {
      calendlyOwnerUri: `${CALENDLY}/users/booking-admin`,
      calendlyPoolingType: "round_robin",
      calendlySoleHostUri: calendlyUserUri,
    } : {}),
    calendlySyncStatus: "active",
    bookingBaseUrl: url,
    calendlySchedulingUrl: `${url}?hide_gdpr_banner=1`,
    bookingUrlSource: "calendly_synced",
    programFromLinkAt: ready ? NOW : undefined,
    createdAt: NOW - 10_000,
  });
  return { userId, configId, calendlyUserUri, calendlyEventTypeUri, url };
}

async function setup(kind: CalendarKind = "one-on-one") {
  const { t, tenantId, admin } = await bookingHarness({ transactionLimits: true });
  const programId = await admin.mutation(api.tenantPrograms.mutations.upsertProgram, {
    name: "Coaching", linkCode: "coaching-vip",
  });
  const { teamId, campaignPresetId, phoneCloser, adminId } = await t.run(async (ctx) => {
    const admin = await ctx.db.query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_admin")).unique();
    if (!admin) throw new Error("Missing fixture admin");
    const teamId = await testLeadGenTeam(ctx, tenantId, "dm-team");
    const phoneCloser = await seedCloser(ctx, tenantId, "alex", { kind });
    await ctx.db.insert("linkPortalConfigs", {
      tenantId, publicSlug: PORTAL_SLUG, isEnabled: true, sessionVersion: 1,
      sessionTtlSeconds: 3600, createdAt: NOW, updatedAt: NOW,
    });
    const campaignPresetId = await ctx.db.insert("linkPortalCampaignPresets", {
      tenantId, slug: "october", label: "October", utmCampaign: "October Launch",
      normalizedUtmCampaign: "october launch", isDefault: true, isActive: true, sortOrder: 0,
      createdAt: NOW, updatedAt: NOW,
    });
    return { teamId, campaignPresetId, phoneCloser, adminId: admin._id };
  });
  const dmCloserId = await admin.mutation(api.attribution.dmClosers.createDmCloser, {
    teamId, displayName: "DM Setter", utmMedium: "dm-setter",
  });
  const session = { tenantId, publicSlug: PORTAL_SLUG, sessionVersion: 1 };

  function bootstrap() {
    return t.query(internal.linkPortal.portalQueries.getPortalBootstrapForSession, session);
  }

  function copy(phoneCloserUserId = phoneCloser.userId) {
    return t.mutation(internal.linkPortal.copyMutations.insertCloserLinkCopy, {
      ...session, sessionIdHash: "session", phoneCloserUserId, programId, dmCloserId, campaignPresetId,
    });
  }

  return { t, tenantId, admin, adminId, programId, phoneCloser, teamId, dmCloserId, campaignPresetId, bootstrap, copy };
}

describe("DM portal closer links", () => {
  it("lists only ready and enabled phone closers and active programs with codes", async () => {
    const h = await setup();
    const archivedId = await h.admin.mutation(api.tenantPrograms.mutations.upsertProgram, {
      name: "Archived", linkCode: "archived",
    });
    await h.admin.mutation(api.tenantPrograms.mutations.archiveProgram, { programId: archivedId });
    const secondId = await h.admin.mutation(api.tenantPrograms.mutations.upsertProgram, {
      name: "Accelerator", linkCode: "accelerator",
    });
    await h.t.run(async (ctx) => {
      await seedCloser(ctx, h.tenantId, "switched-off", { closerLinkInPortalAt: undefined });
      await seedCloser(ctx, h.tenantId, "deactivated", { isActive: false });
      await seedCloser(ctx, h.tenantId, "deleted", { deletedAt: NOW });
      await seedCloser(ctx, h.tenantId, "not-ready", { ready: false });
      await ctx.db.insert("tenantPrograms", {
        tenantId: h.tenantId, name: "Legacy", normalizedName: "legacy",
        createdByUserId: h.adminId, createdAt: NOW, updatedAt: NOW,
      });
    });

    const state = await h.bootstrap();
    expect(state.phoneClosers).toMatchObject([{ id: h.phoneCloser.userId, displayName: "alex" }]);
    expect(state.closerLinkPrograms).toEqual([
      { id: secondId, name: "Accelerator" },
      { id: h.programId, name: "Coaching" },
    ]);
  });

  it.each(["one-on-one", "round_robin"] as const)(
    "lists a closer with a %s calendar, adds the DM team's UTMs, and audits the copy",
    async (kind) => {
      const h = await setup(kind);
      expect((await h.bootstrap()).phoneClosers).toMatchObject([{ id: h.phoneCloser.userId, displayName: "alex" }]);

      const { url, copyEventId } = await h.copy();

      const link = new URL(url);
      expect(link.origin + link.pathname).toBe(h.phoneCloser.url);
      expect(Object.fromEntries(link.searchParams)).toEqual({
        hide_gdpr_banner: "1",
        utm_source: "dm-team",
        utm_medium: "dm-setter",
        utm_campaign: "October Launch",
        utm_content: "coaching-vip",
      });
      expect(await h.t.run((ctx) => ctx.db.get("linkPortalCopyEvents", copyEventId))).toMatchObject({
        tenantId: h.tenantId,
        sessionIdHash: "session",
        eventTypeConfigId: h.phoneCloser.configId,
        linkHostUserId: h.phoneCloser.userId,
        bookingProgramId: h.programId,
        attributionTeamId: h.teamId,
        dmCloserId: h.dmCloserId,
        campaignPresetId: h.campaignPresetId,
        utmCampaign: "October Launch",
      });
    },
  );

  it("hides a round-robin closer and rejects copy until its sole host is restored", async () => {
    const h = await setup("round_robin");
    const { userId, configId, calendlyUserUri } = h.phoneCloser;
    expect((await h.bootstrap()).phoneClosers).toMatchObject([{ id: userId }]);

    await h.t.run((ctx) => ctx.db.patch("eventTypeConfigs", configId, { calendlySoleHostUri: undefined }));

    expect((await h.bootstrap()).phoneClosers).toEqual([]);
    await expect(h.copy()).rejects.toMatchObject({ data: { code: "link_portal.closer_unavailable" } });
    expect(await h.t.run((ctx) => ctx.db.query("linkPortalCopyEvents").take(1))).toEqual([]);

    await h.t.run((ctx) => ctx.db.patch("eventTypeConfigs", configId, { calendlySoleHostUri: calendlyUserUri }));

    expect((await h.bootstrap()).phoneClosers).toMatchObject([{ id: userId }]);
    await expect(h.copy()).resolves.toMatchObject({
      url: expect.stringContaining("utm_content=coaching-vip"),
    });
  });

  it.each(["deactivated", "switched off"] as const)("rejects a closer %s after bootstrap", async (change) => {
    const h = await setup();
    expect((await h.bootstrap()).phoneClosers.map((row) => row.id)).toEqual([h.phoneCloser.userId]);

    if (change === "deactivated") {
      // Keep the portal flag set to exercise the copy's active-login check.
      await h.t.run((ctx) => ctx.db.patch("users", h.phoneCloser.userId, { isActive: false }));
    } else {
      await h.admin.mutation(api.bookingSetup.closerLinks.setCloserLinkInPortal, {
        userId: h.phoneCloser.userId, inPortal: false,
      });
    }

    await expect(h.copy()).rejects.toMatchObject({ data: { code: "link_portal.closer_unavailable" } });
    expect(await h.t.run((ctx) => ctx.db.query("linkPortalCopyEvents").take(1))).toEqual([]);
  });

  it("rejects a ready and enabled closer from a different tenant", async () => {
    const h = await setup();
    const other = await h.t.run(async (ctx) => {
      const tenantId = await ctx.db.insert("tenants", {
        businessDayAppliedVersion: 0,
        companyName: "Other tenant",
        contactEmail: "owner@other.example",
        workosOrgId: "org_other",
        status: "active",
        inviteExpiresAt: 0,
        createdBy: "test",
      });
      return await seedCloser(ctx, tenantId, "foreign-closer");
    });

    await expect(h.copy(other.userId)).rejects.toMatchObject({ data: { code: "link_portal.closer_unavailable" } });
    expect(await h.t.run((ctx) => ctx.db.query("linkPortalCopyEvents").take(1))).toEqual([]);
  });

  it("rejects a program archived after bootstrap", async () => {
    const h = await setup();
    await h.admin.mutation(api.tenantPrograms.mutations.upsertProgram, { name: "Other" });
    expect((await h.bootstrap()).closerLinkPrograms).toContainEqual({ id: h.programId, name: "Coaching" });
    await h.admin.mutation(api.tenantPrograms.mutations.archiveProgram, { programId: h.programId });

    await expect(h.copy()).rejects.toMatchObject({ data: { code: "link_portal.program_unavailable" } });
    expect(await h.t.run((ctx) => ctx.db.query("linkPortalCopyEvents").take(1))).toEqual([]);
  });

  it("rejects a copy when an older config for the same event type belongs to a different closer", async () => {
    const h = await setup();
    await h.t.run(async (ctx) => {
      const other = await seedCloser(ctx, h.tenantId, "blair", { closerLinkInPortalAt: undefined });
      await ctx.db.patch("eventTypeConfigs", other.configId, {
        calendlyEventTypeUri: h.phoneCloser.calendlyEventTypeUri,
        createdAt: NOW - 20_000,
      });
    });

    expect.soft((await h.bootstrap()).phoneClosers.map((row) => row.id)).not.toContain(h.phoneCloser.userId);
    await expect(h.copy()).rejects.toMatchObject({ data: { code: "link_portal.closer_unavailable" } });
    expect(await h.t.run((ctx) => ctx.db.query("linkPortalCopyEvents").take(1))).toEqual([]);
  });
});
