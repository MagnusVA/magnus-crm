import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { insertOpportunityAggregate } from "../reporting/writeHooks";
import { bookingHarness } from "../../tests/bookingHarness";

afterEach(() => vi.useRealTimers());

type Harness = Awaited<ReturnType<typeof bookingHarness>>;

// A customer: a converted lead whose Slack deal was won.
async function customerWithWonDeal(harness: Harness) {
  const { t, tenantId } = harness;
  return await t.run(async (ctx) => {
    const now = Date.now();
    const leadId = await ctx.db.insert("leads", {
      tenantId,
      fullName: "Repeat Buyer",
      email: "repeat@example.com",
      status: "converted",
      firstSeenAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("leadIdentifiers", {
      tenantId,
      leadId,
      type: "instagram",
      value: "repeat.buyer",
      rawValue: "repeat.buyer",
      source: "slack_qualified",
      confidence: "inferred",
      createdAt: now,
    });
    const opportunityId = await ctx.db.insert("opportunities", {
      tenantId,
      leadId,
      status: "payment_received",
      source: "slack_qualified",
      qualifiedBy: { slackUserId: "U1", slackTeamId: "T1", submittedAt: now },
      paymentReceivedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await insertOpportunityAggregate(ctx, opportunityId);
    const installationId = await ctx.db.insert("slackInstallations", {
      tenantId, teamId: "T1", teamName: "Team", isEnterpriseInstall: false, appId: "A1",
      botUserId: "B1", botAccessToken: "xoxb", scopes: [], notifyChannelId: "C1",
      notifyChannelName: "qualified", installedByWorkosUserId: "user_slack",
      installedAt: 0, tokenExpiresAt: 0, refreshToken: "r", status: "active",
    });
    return { leadId, opportunityId, installationId };
  });
}

async function leadOpportunities(harness: Harness, leadId: Id<"leads">) {
  return await harness.t.run((ctx) =>
    ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", harness.tenantId).eq("leadId", leadId),
      )
      .take(10),
  );
}

describe("a second program", () => {
  it("lets a setter qualify a customer again in Slack", async () => {
    vi.useFakeTimers();
    const harness = await bookingHarness();
    const { leadId, opportunityId, installationId } =
      await customerWithWonDeal(harness);

    const result = await harness.t.mutation(internal.slack.createQualifiedLead.create, {
      tenantId: harness.tenantId,
      installationId,
      fullName: "Repeat Buyer",
      handle: "@repeat.buyer",
      country: "Mexico",
      leadType: "pt",
      qualifiedBy: { slackUserId: "U2", slackTeamId: "T1", submittedAt: Date.now() },
    });

    expect(result).toMatchObject({ kind: "created" });
    const opportunities = await leadOpportunities(harness, leadId);
    expect(opportunities.map((o) => [o._id === opportunityId, o.status]).sort()).toEqual([
      [false, "qualified_pending"],
      [true, "payment_received"],
    ]);
  });

  it("lets a closer open a side deal for a customer", async () => {
    vi.useFakeTimers();
    const harness = await bookingHarness();
    const { leadId } = await customerWithWonDeal(harness);

    const created = await harness.closer.mutation(
      api.opportunities.createManual.createManual,
      { clientRequestId: "second-program", existingLeadId: leadId },
    );

    expect(created).toMatchObject({ leadId, leadWasCreated: false });
    const opportunities = await leadOpportunities(harness, leadId);
    expect(opportunities.map((o) => o.status).sort()).toEqual([
      "payment_received",
      "scheduled",
    ]);
  });

  it("points a new-lead side deal at the customer's existing record", async () => {
    vi.useFakeTimers();
    const harness = await bookingHarness();
    await customerWithWonDeal(harness);

    await expect(
      harness.closer.mutation(api.opportunities.createManual.createManual, {
        clientRequestId: "second-program-new-lead",
        newLeadInput: { fullName: "Repeat Buyer", email: "repeat@example.com" },
      }),
    ).rejects.toThrow("opportunity.lead_already_exists");
  });

  it("still refuses a merged lead with no live target", async () => {
    vi.useFakeTimers();
    const harness = await bookingHarness();
    const leadId = await harness.t.run((ctx) =>
      ctx.db.insert("leads", {
        tenantId: harness.tenantId,
        email: "merged@example.com",
        status: "merged",
        firstSeenAt: 0,
        updatedAt: 0,
      }),
    );

    await expect(
      harness.closer.mutation(api.opportunities.createManual.createManual, {
        clientRequestId: "merged-lead",
        existingLeadId: leadId,
      }),
    ).rejects.toThrow("opportunity.lead_not_active");
  });

  it("offers customers in the side-deal lead picker", async () => {
    vi.useFakeTimers();
    const harness = await bookingHarness();
    const { leadId } = await customerWithWonDeal(harness);
    await harness.t.run(async (ctx) => {
      await ctx.db.patch("leads", leadId, { searchText: "repeat buyer repeat@example.com" });
    });

    const results = await harness.closer.query(api.leads.queries.searchLeadsForPicker, {
      searchTerm: "repeat",
    });
    const selected = await harness.closer.query(api.leads.queries.getLeadForPicker, {
      leadId,
    });

    expect(results.map((lead) => lead._id)).toEqual([leadId]);
    expect(selected).toMatchObject({ _id: leadId, status: "converted" });
  });
});
