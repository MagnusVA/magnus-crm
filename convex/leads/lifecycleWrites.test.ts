import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { bookingHarness, bookingPayload } from "../../tests/bookingHarness";
import { countLeadStageEntries } from "../lib/leadLifecycle";

afterEach(() => vi.useRealTimers());

type Harness = Awaited<ReturnType<typeof bookingHarness>>;

const NOW = Date.parse("2026-10-10T12:00:00Z");
const OCTOBER = [Date.parse("2026-10-01T00:00:00Z"), Date.parse("2026-11-01T00:00:00Z")] as const;

async function slackInstallation(harness: Harness): Promise<Id<"slackInstallations">> {
  return await harness.t.run(async (ctx) =>
    await ctx.db.insert("slackInstallations", {
      tenantId: harness.tenantId, teamId: "T1", teamName: "Team", isEnterpriseInstall: false,
      appId: "A1", botUserId: "B1", botAccessToken: "xoxb", scopes: [], notifyChannelId: "C1",
      notifyChannelName: "qualified", installedByWorkosUserId: "user_slack", installedAt: 0,
      tokenExpiresAt: 0, refreshToken: "r", status: "active",
    }),
  );
}

async function qualify(harness: Harness, handle: string, submittedAt: number) {
  const installationId = await slackInstallation(harness);
  return await harness.t.mutation(internal.slack.createQualifiedLead.create, {
    tenantId: harness.tenantId,
    installationId,
    fullName: "Ana Lead",
    handle,
    country: "Honduras",
    leadType: "pt",
    qualifiedBy: { slackUserId: "U1", slackTeamId: "T1", submittedAt },
  });
}

async function book(harness: Harness, key: string, createdAt: string, email = "lead@example.com") {
  const payload = bookingPayload(key, email);
  await harness.t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId: harness.tenantId,
    calendlyEventUri: payload.uri,
    eventType: "invitee.created",
    payload: JSON.stringify({ created_at: createdAt, payload }),
  });
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function program(harness: Harness): Promise<Id<"tenantPrograms">> {
  return await harness.t.run(async (ctx) => {
    const admin = (await ctx.db
      .query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_admin"))
      .unique())!;
    return await ctx.db.insert("tenantPrograms", {
      tenantId: harness.tenantId,
      name: "Program",
      normalizedName: "program",
      createdAt: 0,
      createdByUserId: admin._id,
      updatedAt: 0,
    });
  });
}

async function onlyLead(harness: Harness) {
  return await harness.t.run(async (ctx) => {
    const leads = await ctx.db.query("leads").take(2);
    expect(leads).toHaveLength(1);
    return leads[0];
  });
}

async function stageCount(harness: Harness, stage: "qualified" | "booked" | "showed" | "customer") {
  return await harness.t.run((ctx) =>
    countLeadStageEntries(ctx, harness.tenantId, stage, OCTOBER[0], OCTOBER[1]),
  );
}

describe("lifecycle write paths", () => {
  it("a Slack qualification creates the person at Qualified, at the submission time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const harness = await bookingHarness();
    const submittedAt = NOW - 2_000;

    await qualify(harness, "ana.lead", submittedAt);

    const lead = await onlyLead(harness);
    expect(lead.lifecycleStage).toBe("qualified");
    expect(lead.lifecycleStageEnteredAt).toEqual({
      prospect: submittedAt,
      in_conversation: submittedAt,
      qualified: submittedAt,
    });
    expect(lead.disposition).toBe("open");
    expect(await stageCount(harness, "qualified")).toBe(1);
    expect(await stageCount(harness, "booked")).toBe(0);
  });

  it("a booking from a DM link creates the person at Booked, at the booking time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const harness = await bookingHarness();

    await book(harness, "direct", "2026-10-09T15:00:00Z");

    const bookedAt = Date.parse("2026-10-09T15:00:00Z");
    const lead = await onlyLead(harness);
    expect(lead.lifecycleStage).toBe("booked");
    expect(lead.lifecycleStageEnteredAt).toEqual({
      prospect: bookedAt,
      in_conversation: bookedAt,
      qualified: bookedAt,
      booked: bookedAt,
    });
    expect(await stageCount(harness, "qualified")).toBe(1);
    expect(await stageCount(harness, "booked")).toBe(1);
  });

  it("a booking moves a Slack-qualified person to Booked and keeps their qualification time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const harness = await bookingHarness();
    const submittedAt = NOW - 2_000;
    await qualify(harness, "ana.lead", submittedAt);
    await harness.t.run(async (ctx) => {
      const lead = (await ctx.db.query("leads").first())!;
      await ctx.db.patch("leads", lead._id, { email: "lead@example.com" });
      await ctx.db.insert("leadIdentifiers", {
        tenantId: harness.tenantId, leadId: lead._id, type: "email", value: "lead@example.com",
        rawValue: "lead@example.com", source: "manual_entry", confidence: "verified", createdAt: submittedAt,
      });
    });

    vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
    await book(harness, "after-slack", "2026-10-11T11:00:00Z");

    const lead = await onlyLead(harness);
    expect(lead.lifecycleStage).toBe("booked");
    expect(lead.lifecycleStageEnteredAt).toEqual({
      prospect: submittedAt,
      in_conversation: submittedAt,
      qualified: submittedAt,
      booked: Date.parse("2026-10-11T11:00:00Z"),
    });
    expect(await stageCount(harness, "qualified")).toBe(1);
    expect(await stageCount(harness, "booked")).toBe(1);
  });

  it("a closer's payment on a held call reaches Showed at the call time and Customer at the payment", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T11:00:00Z"));
    const harness = await bookingHarness();
    await book(harness, "held", "2026-09-30T10:00:00Z");
    const programId = await program(harness);
    const { opportunityId, meetingId } = await harness.t.run(async (ctx) => {
      const meeting = (await ctx.db.query("meetings").first())!;
      return { opportunityId: meeting.opportunityId, meetingId: meeting._id };
    });

    vi.setSystemTime(new Date("2026-10-01T12:40:00Z"));
    await harness.closer.mutation(api.closer.payments.logPayment, {
      opportunityId,
      meetingId,
      amount: 1000,
      currency: "USD",
      programId,
      paymentType: "pif",
    });

    const bookedAt = Date.parse("2026-09-30T10:00:00Z");
    const lead = await onlyLead(harness);
    expect(lead.status).toBe("converted");
    expect(lead.lifecycleStage).toBe("customer");
    expect(lead.lifecycleStageEnteredAt).toEqual({
      prospect: bookedAt,
      in_conversation: bookedAt,
      qualified: bookedAt,
      booked: bookedAt,
      // The call's start (bookingPayload), not when the closer logged it.
      showed: Date.parse("2026-10-01T12:00:00Z"),
      customer: Date.parse("2026-10-01T12:40:00Z"),
    });
    expect(await stageCount(harness, "showed")).toBe(1);
    expect(await stageCount(harness, "customer")).toBe(1);
  });

  it("a side deal starts the person at Showed, and voiding its only payment takes them back there", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const harness = await bookingHarness();
    const programId = await program(harness);

    const created = await harness.closer.mutation(api.opportunities.createManual.createManual, {
      clientRequestId: "side-deal",
      newLeadInput: { fullName: "Side Deal", email: "side@example.com" },
    });
    const showed = await onlyLead(harness);
    expect(showed.lifecycleStage).toBe("showed");
    expect(showed.lifecycleStageEnteredAt).toEqual({
      prospect: NOW,
      in_conversation: NOW,
      qualified: NOW,
      booked: NOW,
      showed: NOW,
    });

    vi.setSystemTime(new Date(NOW + 60_000));
    const { paymentId } = await harness.closer.mutation(api.sideDeals.logPayment.logPayment, {
      opportunityId: created.opportunityId,
      amount: 500,
      currency: "USD",
      programId,
      paymentType: "pif",
    });
    expect((await onlyLead(harness)).lifecycleStage).toBe("customer");
    expect(await stageCount(harness, "customer")).toBe(1);

    await harness.admin.mutation(api.sideDeals.voidPayment.voidPayment, {
      paymentId,
      reason: "Logged on the wrong person",
    });
    const voided = await onlyLead(harness);
    expect(voided.status).toBe("active");
    expect(voided.lifecycleStage).toBe("showed");
    expect(voided.lifecycleStageEnteredAt).toEqual(showed.lifecycleStageEnteredAt);
    expect(await stageCount(harness, "customer")).toBe(0);
  });

  it("leaves a lead the backfill hasn't reached alone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T11:00:00Z"));
    const harness = await bookingHarness();
    const leadId = await harness.t.run(async (ctx) =>
      await ctx.db.insert("leads", {
        tenantId: harness.tenantId,
        email: "lead@example.com",
        status: "active",
        firstSeenAt: Date.parse("2026-09-01T00:00:00Z"),
        updatedAt: Date.parse("2026-09-01T00:00:00Z"),
      }),
    );

    await book(harness, "legacy", "2026-09-30T10:00:00Z");

    const lead = await harness.t.run((ctx) => ctx.db.get("leads", leadId));
    expect(lead?.lifecycleStage).toBeUndefined();
    expect(lead?.lifecycleStageEnteredAt).toBeUndefined();
    expect(
      await harness.t.run((ctx) =>
        countLeadStageEntries(ctx, harness.tenantId, "booked", 0, Date.parse("2027-01-01T00:00:00Z")),
      ),
    ).toBe(0);
  });

  it("a merge keeps the earlier qualification and counts the person once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const harness = await bookingHarness();
    const earlier = NOW - 5 * 24 * 60 * 60 * 1000;
    await qualify(harness, "ana.old", earlier);
    await qualify(harness, "ana.new", NOW - 2_000);
    const [source, target] = await harness.t.run(async (ctx) => {
      const leads = await ctx.db.query("leads").take(3);
      return [leads[0]._id, leads[1]._id];
    });

    await harness.admin.mutation(api.leads.merge.mergeLead, {
      sourceLeadId: source,
      targetLeadId: target,
    });

    const merged = await harness.t.run((ctx) => ctx.db.get("leads", target));
    expect(merged?.lifecycleStage).toBe("qualified");
    expect(merged?.lifecycleStageEnteredAt).toEqual({
      prospect: earlier,
      in_conversation: earlier,
      qualified: earlier,
    });
    expect(await stageCount(harness, "qualified")).toBe(1);
  });

  it("an expired Slack deal marks the person unresponsive, and a new qualification reopens them", async () => {
    vi.useFakeTimers();
    const qualifiedAt = Date.parse("2026-10-20T12:00:00Z");
    vi.setSystemTime(new Date(qualifiedAt));
    const harness = await bookingHarness();
    await qualify(harness, "ana.lead", qualifiedAt);

    const expiredAt = Date.parse("2026-11-21T12:30:00Z");
    vi.setSystemTime(new Date(expiredAt));
    await harness.t.mutation(internal.slack.staleExpiry.expireStaleSlackOpportunities, {});
    await harness.t.finishAllScheduledFunctions(vi.runAllTimers);

    const expired = await onlyLead(harness);
    expect(expired.lifecycleStage).toBe("qualified");
    expect(expired).toMatchObject({
      disposition: "unresponsive",
      dispositionSource: "system",
      dispositionSetAt: expiredAt,
    });

    const requalifiedAt = Date.parse("2026-11-25T09:00:00Z");
    vi.setSystemTime(new Date(requalifiedAt));
    await qualify(harness, "ana.lead", requalifiedAt);

    const reopened = await onlyLead(harness);
    expect(reopened).toMatchObject({ disposition: "open", dispositionSetAt: requalifiedAt });
    expect(reopened.lifecycleStageEnteredAt?.qualified).toBe(qualifiedAt);
  });

  it("a lead gen capture before the qualification sets an earlier Prospect time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const harness = await bookingHarness();
    const capturedAt = Date.parse("2026-09-15T08:00:00Z");
    await harness.t.run(async (ctx) => {
      const user = (await ctx.db
        .query("users")
        .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_admin"))
        .unique())!;
      const workerId = await ctx.db.insert("leadGenWorkers", {
        tenantId: harness.tenantId, userId: user._id, workosUserId: "user_admin",
        email: "admin@example.com", isActive: true, createdAt: 0, updatedAt: 0,
      });
      await ctx.db.insert("leadGenProspects", {
        tenantId: harness.tenantId, firstSource: "instagram", latestSource: "instagram",
        dedupeKey: "instagram:ana.lead", normalizedHandle: "ana.lead", rawHandle: "ana.lead",
        profileUrl: "https://instagram.com/ana.lead", firstCapturedByWorkerId: workerId,
        firstCapturedAt: capturedAt, lastSubmittedByWorkerId: workerId, lastSubmittedAt: capturedAt,
        latestOriginKind: "follower", contactAttemptCount: 1, distinctWorkerCount: 1,
        createdAt: capturedAt, updatedAt: capturedAt,
      });
    });

    await qualify(harness, "ana.lead", NOW - 2_000);
    await harness.t.finishAllScheduledFunctions(vi.runAllTimers);

    const lead = await onlyLead(harness);
    expect(lead.lifecycleStage).toBe("qualified");
    expect(lead.lifecycleStageEnteredAt).toEqual({
      prospect: capturedAt,
      in_conversation: NOW - 2_000,
      qualified: NOW - 2_000,
    });
  });
});
