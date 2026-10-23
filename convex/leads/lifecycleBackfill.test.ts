import migrationsTest from "@convex-dev/migrations/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { leadStageTotals, syncLeadStageEntries } from "../lib/leadLifecycle";
import { migrations } from "../migrations";
import { bookingHarness, qualifiedLifecycle } from "../../tests/bookingHarness";

afterEach(() => vi.useRealTimers());

type Harness = Awaited<ReturnType<typeof bookingHarness>>;

const CAPTURED = Date.parse("2026-08-01T10:00:00Z");
const QUALIFIED = Date.parse("2026-08-03T10:00:00Z");
const BOOKED = Date.parse("2026-08-04T10:00:00Z");
const CALL = Date.parse("2026-08-06T15:00:00Z");
const PAID = Date.parse("2026-08-06T16:00:00Z");
const CUSTOMER_LIFECYCLE_STATE = {
  stage: "customer" as const,
  enteredAt: {
    prospect: CAPTURED,
    in_conversation: QUALIFIED,
    qualified: QUALIFIED,
    booked: BOOKED,
    showed: CALL,
    customer: PAID,
  },
};
const CUSTOMER_LIFECYCLE = {
  lifecycleStage: CUSTOMER_LIFECYCLE_STATE.stage,
  lifecycleStageEnteredAt: CUSTOMER_LIFECYCLE_STATE.enteredAt,
};

async function harnessWithMigrations() {
  const harness = await bookingHarness();
  migrationsTest.register(harness.t);
  return harness;
}

async function run(harness: Harness, name: string) {
  await harness.t.mutation(internal.migrations.run, { fn: `migrations:${name}` });
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
  const [status] = await harness.t.run((ctx) =>
    migrations.getStatus(ctx, { migrations: [`migrations:${name}`] as never }),
  );
  return status;
}

async function rerun(harness: Harness, name: string) {
  await harness.t.mutation(internal.migrations.run, { fn: `migrations:${name}`, reset: true });
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
  const [status] = await harness.t.run((ctx) =>
    migrations.getStatus(ctx, { migrations: [`migrations:${name}`] as never }),
  );
  return status;
}

async function userId(ctx: MutationCtx, workosUserId: string): Promise<Id<"users">> {
  return (await ctx.db
    .query("users")
    .withIndex("by_workosUserId", (q) => q.eq("workosUserId", workosUserId))
    .unique())!._id;
}

// A person captured by lead gen, qualified in Slack, booked, held and paid,
// with the lifecycle their records support.
async function legacyCustomer(harness: Harness) {
  return await harness.t.run(async (ctx) => {
    const { tenantId } = harness;
    const adminId = await userId(ctx, "user_admin");
    const closerId = await userId(ctx, "user_closer");
    const leadId = await ctx.db.insert("leads", {
      tenantId, email: "buyer@example.com", status: "converted", firstSeenAt: QUALIFIED, updatedAt: PAID,
      ...CUSTOMER_LIFECYCLE, disposition: "open",
    });
    await syncLeadStageEntries(ctx, tenantId, leadId, null, CUSTOMER_LIFECYCLE_STATE);
    const qualifiedBy = { slackUserId: "U1", slackTeamId: "T1", submittedAt: QUALIFIED };
    const opportunityId = await ctx.db.insert("opportunities", {
      tenantId, leadId, assignedCloserId: closerId, stage: "closed", outcome: "won", source: "slack_qualified",
      qualifiedBy, qualifiedAt: QUALIFIED, paymentReceivedAt: PAID, createdAt: QUALIFIED, updatedAt: PAID,
    });
    const installationId = await ctx.db.insert("slackInstallations", {
      tenantId, teamId: "T1", teamName: "Team", isEnterpriseInstall: false, appId: "A1", botUserId: "B1",
      botAccessToken: "xoxb", scopes: [], notifyChannelId: "C1", notifyChannelName: "qualified",
      installedByWorkosUserId: "user_slack", installedAt: 0, tokenExpiresAt: 0, refreshToken: "r", status: "active",
    });
    await ctx.db.insert("slackQualificationEvents", {
      tenantId, installationId, leadId, opportunityId, resultKind: "created_opportunity", qualifiedBy,
      slackUserId: "U1", slackTeamId: "T1", fullNameSnapshot: "Buyer", platform: "instagram",
      handleSnapshot: "buyer", submittedAt: QUALIFIED, createdAt: QUALIFIED,
    });
    const meetingId = await ctx.db.insert("meetings", {
      tenantId, opportunityId, assignedCloserId: closerId, calendlyEventUri: "e1", calendlyInviteeUri: "i1",
      scheduledAt: CALL, durationMinutes: 30, status: "held", createdAt: BOOKED, heldMarkedAt: PAID,
    });
    const programId = await ctx.db.insert("tenantPrograms", {
      tenantId, name: "Program", normalizedName: "program", createdAt: 0, createdByUserId: adminId, updatedAt: 0,
    });
    await ctx.db.insert("paymentRecords", {
      tenantId, opportunityId, meetingId, attributedCloserId: closerId, amountMinor: 100000, currency: "USD",
      recordedByUserId: closerId, programId, programName: "Program", paymentType: "pif",
      status: "recorded", recordedAt: PAID, origin: "closer_meeting",
    });
    const workerId = await ctx.db.insert("leadGenWorkers", {
      tenantId, userId: adminId, workosUserId: "user_admin", email: "admin@example.com", isActive: true,
      createdAt: 0, updatedAt: 0,
    });
    const prospectId = await ctx.db.insert("leadGenProspects", {
      tenantId, leadId, firstSource: "instagram", latestSource: "instagram", dedupeKey: "instagram:buyer",
      normalizedHandle: "buyer", rawHandle: "buyer", profileUrl: "https://instagram.com/buyer",
      firstCapturedByWorkerId: workerId, firstCapturedAt: CAPTURED, lastSubmittedByWorkerId: workerId,
      lastSubmittedAt: CAPTURED, latestOriginKind: "follower", contactAttemptCount: 1, distinctWorkerCount: 1,
      createdAt: CAPTURED, updatedAt: CAPTURED,
    });
    await ctx.db.insert("leadGenAuditMatches", {
      tenantId, prospectId, leadId, opportunityId, matchSource: "slack_qualification", matchStatus: "accepted",
      matchedVia: "social_handle", normalizedHandle: "buyer", createdAt: QUALIFIED, updatedAt: QUALIFIED,
    });
    return { leadId, opportunityId, meetingId, closerId, programId };
  });
}

describe("lifecycle assert", () => {
  it("passes for a person whose stage matches their records, and names one that doesn't", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
    const harness = await harnessWithMigrations();
    const { leadId } = await legacyCustomer(harness);
    await harness.t.run(async (ctx) => {
      await ctx.db.insert("leads", {
        tenantId: harness.tenantId, status: "merged", mergedIntoLeadId: leadId, firstSeenAt: 0, updatedAt: 0,
        lifecycleStage: "qualified", lifecycleStageEnteredAt: { qualified: 0 }, disposition: "open",
      });
    });

    const passed = await run(harness, "assertLeadLifecycle");
    expect(passed?.error).toBeUndefined();
    expect(passed?.isDone).toBe(true);
    expect(await harness.t.run((ctx) => leadStageTotals(ctx, harness.tenantId))).toEqual({
      prospect: 1, in_conversation: 1, qualified: 1, booked: 1, showed: 1, customer: 1,
    });

    await harness.t.run((ctx) =>
      ctx.db.patch("leads", leadId, { lifecycleStageEnteredAt: { ...CUSTOMER_LIFECYCLE_STATE.enteredAt, showed: PAID } }),
    );
    expect((await rerun(harness, "assertLeadLifecycle"))?.error).toContain("differ from its records");
  });

  it("takes the Customer stage from payments only (D9)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
    const harness = await harnessWithMigrations();
    await legacyCustomer(harness);
    expect((await run(harness, "assertLeadLifecycle"))?.error).toBeUndefined();

    // With the payment disputed, nothing supports the stage.
    await harness.t.run(async (ctx) => {
      const payment = (await ctx.db.query("paymentRecords").first())!;
      await ctx.db.patch("paymentRecords", payment._id, { status: "disputed" });
    });
    expect((await rerun(harness, "assertLeadLifecycle"))?.error).toContain("differ from its records");
  });
});

describe("team member and event link backfills", () => {
  it("gives every role record a team member, then links older events to person and actor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
    const harness = await harnessWithMigrations();
    const { leadId, opportunityId, meetingId, closerId } = await legacyCustomer(harness);
    const ids = await harness.t.run(async (ctx) => {
      const { tenantId } = harness;
      const teamId = await ctx.db.insert("attributionTeams", {
        tenantId, slug: "a", displayName: "A", utmSource: "a", normalizedUtmSource: "a", isActive: true,
        createdAt: 0, updatedAt: 0,
      });
      const linkedDm = await ctx.db.insert("dmClosers", {
        tenantId, teamId, slug: "dana", displayName: "Dana", utmMedium: "dana", normalizedUtmMedium: "dana",
        userId: closerId, isActive: true, createdAt: 0, updatedAt: 0,
      });
      const ownDm = await ctx.db.insert("dmClosers", {
        tenantId, teamId, slug: "eli", displayName: "Eli", utmMedium: "eli", normalizedUtmMedium: "eli",
        isActive: true, createdAt: 0, updatedAt: 0,
      });
      const installationId = (await ctx.db.query("slackInstallations").first())!._id;
      const slackUser = await ctx.db.insert("slackUsers", {
        tenantId, installationId, slackUserId: "U1", slackTeamId: "T1", realName: "Sam Setter", isBot: false,
        isDeleted: false, firstSeenAt: 0, lastSeenAt: 0, lastSyncedAt: 0,
      });
      const event = (fields: { entityType: "lead" | "opportunity" | "meeting"; entityId: string; eventType: string; occurredAt: number; actorUserId?: Id<"users">; source?: "closer" | "pipeline" }) =>
        ctx.db.insert("domainEvents", { tenantId, source: fields.source ?? "pipeline", ...fields });
      const leadEvent = await event({ entityType: "lead", entityId: leadId, eventType: "lead.created", occurredAt: QUALIFIED });
      const slackCreated = await event({ entityType: "opportunity", entityId: opportunityId, eventType: "opportunity.created", occurredAt: QUALIFIED });
      const closerEvent = await event({
        entityType: "opportunity", entityId: opportunityId, eventType: "opportunity.status_changed",
        occurredAt: PAID, actorUserId: closerId, source: "closer",
      });
      await event({ entityType: "meeting", entityId: meetingId, eventType: "meeting.created", occurredAt: BOOKED });
      return { linkedDm, ownDm, slackUser, leadEvent, slackCreated, closerEvent };
    });

    for (const name of [
      "backfillUserTeamMembers", "backfillLeadGenWorkerTeamMembers",
      "backfillDmCloserTeamMembers", "backfillSlackUserTeamMembers",
    ]) {
      expect((await run(harness, name))?.isDone).toBe(true);
    }
    for (const name of [
      "assertUserTeamMembers", "assertLeadGenWorkerTeamMembers", "assertDmCloserTeamMembers",
      "assertSlackUserTeamMembers", "assertTeamMembersHeld",
    ]) {
      expect((await run(harness, name))?.error, name).toBeUndefined();
    }
    expect((await run(harness, "assertDomainEventLinks"))?.error).toContain("expected");
    expect((await run(harness, "backfillDomainEventLinks"))?.isDone).toBe(true);
    expect((await rerun(harness, "assertDomainEventLinks"))?.error).toBeUndefined();

    const state = await harness.t.run(async (ctx) => ({
      closer: await ctx.db.get("users", closerId),
      linkedDm: await ctx.db.get("dmClosers", ids.linkedDm),
      ownDm: await ctx.db.get("dmClosers", ids.ownDm),
      slackUser: await ctx.db.get("slackUsers", ids.slackUser),
      leadEvent: await ctx.db.get("domainEvents", ids.leadEvent),
      slackCreated: await ctx.db.get("domainEvents", ids.slackCreated),
      closerEvent: await ctx.db.get("domainEvents", ids.closerEvent),
    }));
    expect(state.linkedDm?.teamMemberId).toBe(state.closer?.teamMemberId);
    expect(state.ownDm?.teamMemberId).not.toBe(state.closer?.teamMemberId);
    expect(state.leadEvent?.leadId).toBe(leadId);
    expect(state.slackCreated).toMatchObject({ leadId, teamMemberId: state.slackUser?.teamMemberId });
    expect(state.closerEvent).toMatchObject({ leadId, teamMemberId: state.closer?.teamMemberId });
  });

  it("gives a deal event the split took apart to the person whose meeting caused it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
    const harness = await harnessWithMigrations();
    const ids = await harness.t.run(async (ctx) => {
      const { tenantId } = harness;
      const closerId = await userId(ctx, "user_closer");
      const keeper = await ctx.db.insert("leads", { ...qualifiedLifecycle(0), tenantId, status: "active", firstSeenAt: 0, updatedAt: 0 });
      const extracted = await ctx.db.insert("leads", { ...qualifiedLifecycle(0), tenantId, status: "active", firstSeenAt: 0, updatedAt: 0 });
      const kept = await ctx.db.insert("opportunities", { tenantId, leadId: keeper, stage: "booked", outcome: "open", source: "calendly", createdAt: 0, updatedAt: 0 });
      const splitOut = await ctx.db.insert("opportunities", { tenantId, leadId: extracted, stage: "closed", outcome: "lost", source: "calendly", createdAt: 0, updatedAt: 0 });
      const keeperMeeting = await ctx.db.insert("meetings", {
        tenantId, opportunityId: kept, assignedCloserId: closerId, calendlyEventUri: "k", calendlyInviteeUri: "k",
        scheduledAt: CALL, durationMinutes: 30, status: "scheduled", createdAt: BOOKED,
      });
      const movedMeeting = await ctx.db.insert("meetings", {
        tenantId, opportunityId: splitOut, assignedCloserId: closerId, calendlyEventUri: "m", calendlyInviteeUri: "m",
        scheduledAt: CALL, durationMinutes: 30, status: "canceled", createdAt: QUALIFIED,
      });
      const insert = (entityType: "opportunity" | "meeting", entityId: string, eventType: string, occurredAt: number) =>
        ctx.db.insert("domainEvents", { tenantId, entityType, entityId, eventType, occurredAt, source: "pipeline" });
      // Before the split, both people's meetings sat on `kept`.
      await insert("meeting", movedMeeting, "meeting.canceled", QUALIFIED + 1);
      const causedByMoved = await insert("opportunity", kept, "opportunity.status_changed", QUALIFIED + 1);
      await insert("meeting", keeperMeeting, "meeting.created", BOOKED);
      const causedByKeeper = await insert("opportunity", kept, "opportunity.status_changed", BOOKED);
      const created = await insert("opportunity", kept, "opportunity.created", QUALIFIED + 1);
      return { keeper, extracted, causedByMoved, causedByKeeper, created };
    });

    await run(harness, "backfillDomainEventLinks");
    expect((await run(harness, "assertDomainEventLinks"))?.error).toBeUndefined();

    const events = await harness.t.run(async (ctx) => ({
      causedByMoved: await ctx.db.get("domainEvents", ids.causedByMoved),
      causedByKeeper: await ctx.db.get("domainEvents", ids.causedByKeeper),
      created: await ctx.db.get("domainEvents", ids.created),
    }));
    expect(events.causedByMoved?.leadId).toBe(ids.extracted);
    expect(events.causedByKeeper?.leadId).toBe(ids.keeper);
    // The deal itself stayed with its keeper (split rule O1).
    expect(events.created?.leadId).toBe(ids.keeper);
  });

  it("joins a team member to a user's only once the admin approves the pair", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
    const harness = await harnessWithMigrations();
    const { slackUserRowId, closerId, adminId } = await harness.t.run(async (ctx) => {
      const closerId = await userId(ctx, "user_closer");
      await ctx.db.patch("users", closerId, { fullName: "Sam Setter" });
      const installationId = await ctx.db.insert("slackInstallations", {
        tenantId: harness.tenantId, teamId: "T1", teamName: "Team", isEnterpriseInstall: false, appId: "A1",
        botUserId: "B1", botAccessToken: "xoxb", scopes: [], notifyChannelId: "C1", notifyChannelName: "q",
        installedByWorkosUserId: "user_slack", installedAt: 0, tokenExpiresAt: 0, refreshToken: "r", status: "active",
      });
      const slackUserRowId = await ctx.db.insert("slackUsers", {
        tenantId: harness.tenantId, installationId, slackUserId: "U1", slackTeamId: "T1", realName: "Sam Setter",
        isBot: false, isDeleted: false, firstSeenAt: 0, lastSeenAt: 0, lastSyncedAt: 0,
      });
      return { slackUserRowId, closerId, adminId: await userId(ctx, "user_admin") };
    });
    await run(harness, "backfillUserTeamMembers");
    await run(harness, "backfillSlackUserTeamMembers");

    const { candidates } = await harness.t.query(internal.teamMembers.linking.nameLinkCandidates, {
      tenantId: harness.tenantId,
    });
    expect(candidates).toEqual([
      expect.objectContaining({ fromRecord: slackUserRowId, intoUserId: closerId, match: "full_name" }),
    ]);
    const before = await harness.t.run((ctx) => ctx.db.get("slackUsers", slackUserRowId));
    expect(before?.teamMemberId).not.toBe(candidates[0].intoTeamMemberId);

    await harness.t.mutation(internal.teamMembers.linking.applyApprovedLinks, {
      tenantId: harness.tenantId,
      approvedByUserId: adminId,
      links: [{ fromTeamMemberId: candidates[0].fromTeamMemberId, intoTeamMemberId: candidates[0].intoTeamMemberId }],
    });

    const after = await harness.t.run(async (ctx) => ({
      slackUser: await ctx.db.get("slackUsers", slackUserRowId),
      oldTeamMember: await ctx.db.get("teamMembers", candidates[0].fromTeamMemberId),
    }));
    expect(after.slackUser?.teamMemberId).toBe(candidates[0].intoTeamMemberId);
    expect(after.oldTeamMember).toBeNull();
    expect((await run(harness, "assertTeamMembersHeld"))?.error).toBeUndefined();
  });
});
