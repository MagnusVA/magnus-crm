import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { bookingHarness, bookingPayload } from "../../tests/bookingHarness";

afterEach(() => vi.useRealTimers());

type Harness = Awaited<ReturnType<typeof bookingHarness>>;

const NOW = Date.parse("2026-10-10T12:00:00Z");

async function userByEmail(harness: Harness, email: string) {
  return await harness.t.run(async (ctx) =>
    await ctx.db
      .query("users")
      .withIndex("by_tenantId_and_email", (q) => q.eq("tenantId", harness.tenantId).eq("email", email))
      .unique(),
  );
}

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

async function dmTeam(harness: Harness): Promise<Id<"attributionTeams">> {
  return await harness.t.run(async (ctx) =>
    await ctx.db.insert("attributionTeams", {
      tenantId: harness.tenantId, slug: "team-a", displayName: "Team A", utmSource: "team-a",
      normalizedUtmSource: "team-a", isActive: true, createdAt: 0, updatedAt: 0,
    }),
  );
}

describe("team members", () => {
  it("an invited lead generator and their lead gen worker share one team member", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const harness = await bookingHarness();

    await harness.t.mutation(internal.workos.userMutations.createInvitedUser, {
      tenantId: harness.tenantId,
      workosUserId: "pending:setter@example.com",
      email: "setter@example.com",
      fullName: "Sam Setter",
      role: "lead_generator",
      invitationStatus: "pending",
    });

    const user = await userByEmail(harness, "setter@example.com");
    const state = await harness.t.run(async (ctx) => ({
      teamMember: user?.teamMemberId ? await ctx.db.get("teamMembers", user.teamMemberId) : null,
      worker: await ctx.db
        .query("leadGenWorkers")
        .withIndex("by_tenantId_and_userId", (q) => q.eq("tenantId", harness.tenantId).eq("userId", user!._id))
        .unique(),
    }));
    expect(state.teamMember).toMatchObject({ tenantId: harness.tenantId, displayName: "Sam Setter" });
    expect(state.worker?.teamMemberId).toBe(user?.teamMemberId);
  });

  it("a DM closer linked to a user shares their team member, and gets its own once unlinked", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const harness = await bookingHarness();
    const teamId = await dmTeam(harness);
    const closer = await userByEmail(harness, "closer@example.com");

    const dmCloserId = await harness.admin.mutation(api.attribution.dmClosers.createDmCloser, {
      teamId,
      displayName: "Dana DM",
      utmMedium: "dana",
      userId: closer!._id,
    });
    const linked = await harness.t.run(async (ctx) => ({
      dmCloser: await ctx.db.get("dmClosers", dmCloserId),
      user: await ctx.db.get("users", closer!._id),
    }));
    expect(linked.user?.teamMemberId).toBeDefined();
    expect(linked.dmCloser?.teamMemberId).toBe(linked.user?.teamMemberId);

    await harness.admin.mutation(api.attribution.dmClosers.updateDmCloser, {
      dmCloserId,
      teamId,
      displayName: "Dana DM",
      utmMedium: "dana",
      userId: null,
    });
    const unlinked = await harness.t.run(async (ctx) => {
      const dmCloser = await ctx.db.get("dmClosers", dmCloserId);
      return {
        dmCloser,
        teamMember: dmCloser?.teamMemberId ? await ctx.db.get("teamMembers", dmCloser.teamMemberId) : null,
      };
    });
    expect(unlinked.dmCloser?.teamMemberId).not.toBe(linked.user?.teamMemberId);
    expect(unlinked.teamMember).toMatchObject({ displayName: "Dana DM" });
  });
});

describe("domain event links", () => {
  it("a Slack qualification credits the setter and names the person on the deal's events", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const harness = await bookingHarness();
    const installationId = await slackInstallation(harness);

    await harness.t.mutation(internal.slack.createQualifiedLead.create, {
      tenantId: harness.tenantId,
      installationId,
      fullName: "Ana Lead",
      handle: "ana.lead",
      country: "Honduras",
      leadType: "pt",
      qualifiedBy: { slackUserId: "U1", slackTeamId: "T1", submittedAt: NOW - 2_000 },
    });

    const state = await harness.t.run(async (ctx) => ({
      lead: await ctx.db.query("leads").first(),
      slackUser: await ctx.db.query("slackUsers").first(),
      events: await ctx.db.query("domainEvents").take(20),
    }));
    const created = state.events.find((event) => event.eventType === "opportunity.created");
    expect(state.slackUser?.teamMemberId).toBeDefined();
    expect(created).toMatchObject({
      leadId: state.lead?._id,
      teamMemberId: state.slackUser?.teamMemberId,
    });
  });

  it("booking and payment events name the person, and the acting closer's team member", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T11:00:00Z"));
    const harness = await bookingHarness();
    const payload = bookingPayload("linked");
    await harness.t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
      tenantId: harness.tenantId,
      calendlyEventUri: payload.uri,
      eventType: "invitee.created",
      payload: JSON.stringify({ created_at: "2026-09-30T10:00:00Z", payload }),
    });
    await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
    const { opportunityId, meetingId, programId, closerTeamMemberId } = await harness.t.run(async (ctx) => {
      const meeting = (await ctx.db.query("meetings").first())!;
      const admin = (await ctx.db
        .query("users")
        .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_admin"))
        .unique())!;
      const closer = (await ctx.db
        .query("users")
        .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_closer"))
        .unique())!;
      const closerTeamMemberId = await ctx.db.insert("teamMembers", {
        tenantId: harness.tenantId, displayName: "Closer", createdAt: 0, updatedAt: 0,
      });
      await ctx.db.patch("users", closer._id, { teamMemberId: closerTeamMemberId });
      const programId = await ctx.db.insert("tenantPrograms", {
        tenantId: harness.tenantId, name: "Program", normalizedName: "program",
        createdAt: 0, createdByUserId: admin._id, updatedAt: 0,
      });
      return { opportunityId: meeting.opportunityId, meetingId: meeting._id, programId, closerTeamMemberId };
    });

    vi.setSystemTime(new Date("2026-10-01T12:40:00Z"));
    await harness.closer.mutation(api.closer.payments.logPayment, {
      opportunityId, meetingId, amount: 1000, currency: "USD", programId, paymentType: "pif",
    });

    const state = await harness.t.run(async (ctx) => ({
      lead: await ctx.db.query("leads").first(),
      events: await ctx.db.query("domainEvents").take(50),
    }));
    const byType = (eventType: string) => state.events.find((event) => event.eventType === eventType);
    expect(byType("meeting.created")?.leadId).toBe(state.lead?._id);
    expect(byType("opportunity.created")?.leadId).toBe(state.lead?._id);
    expect(byType("payment.recorded")).toMatchObject({
      leadId: state.lead?._id,
      teamMemberId: closerTeamMemberId,
    });
    // The conversion: the person's status change and their first enrollment.
    expect(byType("lead.status_changed")).toMatchObject({
      leadId: state.lead?._id,
      teamMemberId: closerTeamMemberId,
      toStatus: "converted",
    });
    expect(byType("enrollment.created")).toMatchObject({
      leadId: state.lead?._id,
      teamMemberId: closerTeamMemberId,
    });
    expect(byType("customer.converted")).toBeUndefined();
    expect(byType("lead.created")?.leadId).toBe(state.lead?._id);
  });
});
