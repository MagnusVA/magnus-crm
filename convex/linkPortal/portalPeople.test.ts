/**
 * The DM portal works on a person, and a booking from a portal link joins
 * them (docs/plans/phase-2-person-first.md §4.3, §4.4, §10.3).
 */
import migrationsTest from "@convex-dev/migrations/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { bookingHarness, bookingPayload } from "../../tests/bookingHarness";
import { syncLeadStageEntries } from "../lib/leadLifecycle";
import { migrations } from "../migrations";
import { insertOpportunityAggregate } from "../reporting/writeHooks";

afterEach(() => vi.useRealTimers());

type Harness = Awaited<ReturnType<typeof setup>>;

const NOW = Date.parse("2026-10-10T12:00:00Z");
const PORTAL_SLUG = "portal";

async function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  const harness = await bookingHarness();
  migrationsTest.register(harness.t);
  const ids = await harness.t.run(async (ctx) => {
    const { tenantId } = harness;
    const admin = (await ctx.db
      .query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_admin"))
      .unique())!;
    const programId = await ctx.db.insert("tenantPrograms", {
      tenantId, name: "Program", normalizedName: "program", createdAt: 0,
      createdByUserId: admin._id, updatedAt: 0,
    });
    const eventTypeConfigId = await ctx.db.insert("eventTypeConfigs", {
      tenantId, calendlyEventTypeUri: "https://api.calendly.com/event_types/portal",
      displayName: "Strategy call", createdAt: 0, bookingProgramId: programId,
      bookingProgramName: "Program", bookingProgramMappingStatus: "mapped",
      bookingBaseUrl: "https://calendly.com/test/strategy", bookingUrlSource: "admin_entered",
      linkPortalEnabled: true,
    });
    const teamMemberId = await ctx.db.insert("teamMembers", { tenantId, displayName: "DM Closer", createdAt: 0, updatedAt: 0 });
    const teamId = await ctx.db.insert("attributionTeams", {
      tenantId, slug: "team", displayName: "Team", utmSource: "team", normalizedUtmSource: "team",
      isActive: true, createdAt: 0, updatedAt: 0,
    });
    const dmCloserId = await ctx.db.insert("dmClosers", {
      tenantId, teamId, slug: "dm", displayName: "DM", utmMedium: "dm", normalizedUtmMedium: "dm",
      isActive: true, teamMemberId, createdAt: 0, updatedAt: 0,
    });
    await ctx.db.insert("linkPortalConfigs", {
      tenantId, publicSlug: PORTAL_SLUG, isEnabled: true, sessionVersion: 1,
      sessionTtlSeconds: 3600, createdAt: 0, updatedAt: 0,
    });
    const campaignPresetId = await ctx.db.insert("linkPortalCampaignPresets", {
      tenantId, slug: "default", label: "Default", utmCampaign: "default",
      normalizedUtmCampaign: "default", isDefault: true, isActive: true, sortOrder: 0,
      createdAt: 0, updatedAt: 0,
    });
    return { eventTypeConfigId, dmCloserId, campaignPresetId, teamMemberId };
  });
  return { ...harness, ...ids };
}

const session = (h: Harness) => ({ tenantId: h.tenantId, publicSlug: PORTAL_SLUG, sessionVersion: 1, sessionIdHash: "session" });

async function copy(h: Harness, instagramHandle: string) {
  return await h.t.mutation(internal.linkPortal.copyMutations.insertCopyEvent, {
    ...session(h),
    eventTypeConfigId: h.eventTypeConfigId,
    dmCloserId: h.dmCloserId,
    campaignPresetId: h.campaignPresetId,
    instagramHandle,
  });
}

async function events(h: Harness, eventType: string) {
  return await h.t.run(async (ctx) =>
    (await ctx.db.query("domainEvents").take(200)).filter((event) => event.eventType === eventType),
  );
}

async function existingPerson(
  h: Harness,
  fields: { email?: string; handle?: string },
) {
  return await h.t.run(async (ctx) => {
    const at = NOW - 86_400_000;
    const state = { stage: "qualified" as const, enteredAt: { prospect: at, in_conversation: at, qualified: at } };
    const leadId = await ctx.db.insert("leads", {
      tenantId: h.tenantId, status: "active", email: fields.email, firstSeenAt: at, updatedAt: at,
      lifecycleStage: state.stage, lifecycleStageEnteredAt: state.enteredAt, disposition: "open",
      socialHandles: fields.handle ? [{ type: "instagram", handle: fields.handle }] : undefined,
    });
    await syncLeadStageEntries(ctx, h.tenantId, leadId, null, state);
    await insertOpportunityAggregate(ctx, await ctx.db.insert("opportunities", {
      tenantId: h.tenantId, leadId, status: "qualified_pending", source: "slack_qualified", qualifiedAt: at,
      qualifiedBy: { slackUserId: "U1", slackTeamId: "T1", submittedAt: at }, createdAt: at, updatedAt: at,
    }));
    for (const [type, value] of [["email", fields.email], ["instagram", fields.handle]] as const) {
      if (value) {
        await ctx.db.insert("leadIdentifiers", {
          tenantId: h.tenantId, leadId, type, value, rawValue: value, source: "manual_entry",
          confidence: "verified", createdAt: at,
        });
      }
    }
    return leadId;
  });
}

async function bookFromLink(h: Harness, key: string, email: string, personId: Id<"leads">) {
  const payload = {
    ...bookingPayload(key, email),
    tracking: { utm_source: "team", utm_medium: "dm", utm_campaign: "default", utm_content: personId },
  };
  await h.t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId: h.tenantId,
    calendlyEventUri: payload.uri,
    eventType: "invitee.created",
    payload: JSON.stringify({ created_at: new Date(NOW + 60_000).toISOString(), payload }),
  });
  await h.t.finishAllScheduledFunctions(vi.runAllTimers);
  return await h.t.run(async (ctx) => {
    const meeting = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_calendlyInviteeUri", (q) => q.eq("tenantId", h.tenantId).eq("calendlyInviteeUri", payload.uri))
      .unique();
    return meeting && (await ctx.db.get("opportunities", meeting.opportunityId));
  });
}

describe("DM portal copy", () => {
  it("creates the person at In conversation and records the copy against them", async () => {
    const h = await setup();

    const { copyEventId, leadId } = await copy(h, "@Ana.Lead");

    const state = await h.t.run(async (ctx) => ({
      lead: await ctx.db.get("leads", leadId),
      copy: await ctx.db.get("linkPortalCopyEvents", copyEventId),
      identifiers: await ctx.db.query("leadIdentifiers").take(5),
      stats: await ctx.db.query("tenantStats").first(),
    }));
    expect(state.lead).toMatchObject({
      lifecycleStage: "in_conversation",
      lifecycleStageEnteredAt: { prospect: NOW, in_conversation: NOW },
    });
    expect(state.copy?.leadId).toBe(leadId);
    expect(state.identifiers).toMatchObject([{ leadId, type: "instagram", value: "ana.lead", source: "dm_portal" }]);
    expect(state.stats?.totalLeads ?? 0).toBe(0);
    const [touch] = await events(h, "lead.portal_link_copied");
    expect(touch).toMatchObject({ leadId, teamMemberId: h.teamMemberId, source: "pipeline" });
    expect(JSON.parse(touch.metadata!)).toMatchObject({ copyEventId, dmCloserId: h.dmCloserId });
    expect(await events(h, "lead.created")).toHaveLength(1);

    // A second link for the same handle is the same person.
    const second = await copy(h, "ana.lead");
    expect(second.leadId).toBe(leadId);
    expect(await events(h, "lead.created")).toHaveLength(1);
  });

  it("finds a qualified person by handle without moving their stage back", async () => {
    const h = await setup();
    const leadId = await existingPerson(h, { handle: "ana.lead" });

    expect((await copy(h, "ana.lead")).leadId).toBe(leadId);

    const lead = await h.t.run((ctx) => ctx.db.get("leads", leadId));
    expect(lead?.lifecycleStage).toBe("qualified");
  });

  it("refuses a copy without a usable handle", async () => {
    const h = await setup();

    await expect(copy(h, "na")).rejects.toThrow("Instagram handle");
    expect(await h.t.run((ctx) => ctx.db.query("linkPortalCopyEvents").take(1))).toEqual([]);
  });

  it("a portal note moves a prospect to In conversation", async () => {
    const h = await setup();
    const leadId = await h.t.run(async (ctx) => {
      const state = { stage: "prospect" as const, enteredAt: { prospect: NOW - 1_000 } };
      const id = await ctx.db.insert("leads", {
        tenantId: h.tenantId, status: "active", firstSeenAt: NOW - 1_000, updatedAt: NOW - 1_000,
        lifecycleStage: state.stage, lifecycleStageEnteredAt: state.enteredAt, disposition: "open",
      });
      await syncLeadStageEntries(ctx, h.tenantId, id, null, state);
      return id;
    });

    await h.t.mutation(internal.linkPortal.leadMutations.insertLeadNoteForSession, {
      ...session(h), dmCloserId: h.dmCloserId, leadId, content: "Replied to the story",
    });

    const lead = await h.t.run((ctx) => ctx.db.get("leads", leadId));
    expect(lead).toMatchObject({ lifecycleStage: "in_conversation", lifecycleStageEnteredAt: { in_conversation: NOW } });
    expect(await events(h, "lead.portal_note_added")).toMatchObject([{ leadId, teamMemberId: h.teamMemberId }]);
  });
});

describe("booking from a portal link", () => {
  it("joins the link's person when the booking's identifiers find nobody", async () => {
    const h = await setup();
    const { leadId } = await copy(h, "ana.lead");

    const opportunity = await bookFromLink(h, "joins", "ana@example.com", leadId);

    expect(opportunity?.leadId).toBe(leadId);
    expect(opportunity?.potentialDuplicateLeadId).toBeUndefined();
    const state = await h.t.run(async (ctx) => ({
      lead: await ctx.db.get("leads", leadId),
      leads: await ctx.db.query("leads").take(5),
      emailIdentifier: await ctx.db
        .query("leadIdentifiers")
        .withIndex("by_tenantId_and_type_and_value", (q) =>
          q.eq("tenantId", h.tenantId).eq("type", "email").eq("value", "ana@example.com"),
        )
        .unique(),
    }));
    expect(state.leads).toHaveLength(1);
    expect(state.lead).toMatchObject({ email: "ana@example.com", lifecycleStage: "booked" });
    expect(state.emailIdentifier?.leadId).toBe(leadId);
  });

  it("goes to the person the identifiers find, and flags the link's person", async () => {
    const h = await setup();
    const { leadId: linkPersonId } = await copy(h, "ana.lead");
    const otherId = await existingPerson(h, { email: "other@example.com" });

    const opportunity = await bookFromLink(h, "identifiers-win", "other@example.com", linkPersonId);

    expect(opportunity?.leadId).toBe(otherId);
    expect(opportunity?.potentialDuplicateLeadId).toBe(linkPersonId);
  });

  it("creates a new person when the link's person has another email, and flags the link's person", async () => {
    const h = await setup();
    const linkPersonId = await existingPerson(h, { email: "first@example.com", handle: "ana.lead" });

    const opportunity = await bookFromLink(h, "forwarded", "stranger@example.com", linkPersonId);

    expect(opportunity?.leadId).not.toBe(linkPersonId);
    expect(opportunity?.potentialDuplicateLeadId).toBe(linkPersonId);
  });
});

async function run(h: Harness, name: string) {
  await h.t.mutation(internal.migrations.run, { fn: `migrations:${name}` });
  await h.t.finishAllScheduledFunctions(vi.runAllTimers);
  const [status] = await h.t.run((ctx) =>
    migrations.getStatus(ctx, { migrations: [`migrations:${name}`] as never }),
  );
  return status;
}

describe("portal touch backfill", () => {
  it("gives each earlier portal note and edit its touch, once", async () => {
    const h = await setup();
    const leadId = await existingPerson(h, { handle: "ana.lead" });
    await h.t.run(async (ctx) => {
      await ctx.db.insert("leadNotes", {
        tenantId: h.tenantId, leadId, content: "Earlier note", createdAt: NOW - 500,
        authorKind: "dm_closer", dmCloserId: h.dmCloserId,
      });
      await ctx.db.insert("linkPortalLeadEdits", {
        tenantId: h.tenantId, leadId, dmCloserId: h.dmCloserId, sessionIdHash: "s",
        createdAt: NOW - 400, changedFields: ["initialSource"],
      });
    });

    expect((await run(h, "assertPortalNoteTouches")).state).toBe("failed");
    expect((await run(h, "backfillPortalNoteTouches")).state).toBe("success");
    expect((await run(h, "backfillPortalEditTouches")).state).toBe("success");
    await h.t.mutation(internal.migrations.run, { fn: "migrations:backfillPortalNoteTouches", reset: true });
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);
    await h.t.mutation(internal.migrations.run, { fn: "migrations:assertPortalNoteTouches", reset: true });
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);
    const [noteAssert] = await h.t.run((ctx) =>
      migrations.getStatus(ctx, { migrations: ["migrations:assertPortalNoteTouches"] as never }),
    );
    expect(noteAssert.state).toBe("success");
    expect((await run(h, "assertPortalEditTouches")).state).toBe("success");
    expect((await run(h, "assertLeadLifecycle")).state).toBe("success");

    expect(await events(h, "lead.portal_note_added")).toHaveLength(1);
    expect(await events(h, "lead.portal_profile_updated")).toHaveLength(1);
  });
});
