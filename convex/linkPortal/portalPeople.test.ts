/**
 * Portal notes and edits are touches on their person; a copied link names
 * no one (docs/plans/phase-2-person-first.md §4.3).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import { bookingHarness, bookingPayload } from "../../tests/bookingHarness";
import { collectLifecycleEvidence, syncLeadStageEntries } from "../lib/leadLifecycle";
import { insertOpportunityAggregate } from "../reporting/writeHooks";

afterEach(() => vi.useRealTimers());

type Harness = Awaited<ReturnType<typeof setup>>;

const NOW = Date.parse("2026-10-10T12:00:00Z");
const PORTAL_SLUG = "portal";

async function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  const harness = await bookingHarness();
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

async function copy(h: Harness) {
  return await h.t.mutation(internal.linkPortal.copyMutations.insertCopyEvent, {
    ...session(h),
    eventTypeConfigId: h.eventTypeConfigId,
    dmCloserId: h.dmCloserId,
    campaignPresetId: h.campaignPresetId,
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

describe("DM portal copy", () => {
  it("records the copied link without naming or creating a person", async () => {
    const h = await setup();
    const leadId = await existingPerson(h, { handle: "ana.lead" });

    const copyEventId = await copy(h);

    const state = await h.t.run(async (ctx) => ({
      copy: await ctx.db.get("linkPortalCopyEvents", copyEventId),
      leads: await ctx.db.query("leads").take(5),
    }));
    expect(state.copy?.leadId).toBeUndefined();
    expect(state.leads.map((lead) => lead._id)).toEqual([leadId]);
    expect(state.leads[0].lifecycleStage).toBe("qualified");
    expect(await events(h, "lead.portal_link_copied")).toEqual([]);
  });

  it("limits how many links a DM closer records in a minute", async () => {
    const h = await setup();
    for (let i = 0; i < 10; i++) {
      await copy(h);
    }

    await expect(copy(h)).rejects.toThrow("Too many links");
    vi.setSystemTime(new Date(NOW + 61_000));
    await expect(copy(h)).resolves.toBeDefined();
  });

  it("dates In conversation from the first portal note, however many notes follow", async () => {
    const h = await setup();
    const leadId = await existingPerson(h, { handle: "ana.lead" });
    await h.t.run(async (ctx) => {
      await ctx.db.insert("leadNotes", {
        tenantId: h.tenantId, leadId, content: "First", createdAt: NOW - 10_000,
        authorKind: "dm_closer", dmCloserId: h.dmCloserId,
      });
      for (let i = 0; i < 210; i++) {
        await ctx.db.insert("leadNotes", { tenantId: h.tenantId, leadId, content: `n${i}`, createdAt: NOW, authorKind: "user" });
      }
    });

    const evidence = await h.t.run(async (ctx) => {
      const lead = await ctx.db.get("leads", leadId);
      return (await collectLifecycleEvidence(ctx, lead!)).evidence;
    });

    expect(evidence).toContainEqual({ stage: "in_conversation", at: NOW - 10_000 });
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

describe("booking from a link copied while the portal named the person", () => {
  it("ignores the person ID in utm_content and matches by identifiers only", async () => {
    const h = await setup();
    const linkPersonId = await existingPerson(h, { handle: "ana.lead" });
    const payload = {
      ...bookingPayload("legacy-link", "stranger@example.com"),
      tracking: { utm_source: "team", utm_medium: "dm", utm_campaign: "default", utm_content: linkPersonId },
    };

    await h.t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
      tenantId: h.tenantId,
      calendlyEventUri: payload.uri,
      eventType: "invitee.created",
      payload: JSON.stringify({ created_at: new Date(NOW + 60_000).toISOString(), payload }),
    });
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);

    const opportunity = await h.t.run(async (ctx) => {
      const meeting = await ctx.db
        .query("meetings")
        .withIndex("by_tenantId_and_calendlyInviteeUri", (q) => q.eq("tenantId", h.tenantId).eq("calendlyInviteeUri", payload.uri))
        .unique();
      return meeting && (await ctx.db.get("opportunities", meeting.opportunityId));
    });
    expect(opportunity).not.toBeNull();
    expect(opportunity?.leadId).not.toBe(linkPersonId);
    expect(opportunity?.potentialDuplicateLeadId).toBeUndefined();
  });
});
