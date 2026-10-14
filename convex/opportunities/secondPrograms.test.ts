import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { rebuildLeadCustomerSearchRow } from "../leadCustomers/projection";
import { insertOpportunityAggregate } from "../reporting/writeHooks";
import { bookingHarness } from "../../tests/bookingHarness";

afterEach(() => vi.useRealTimers());

type Harness = Awaited<ReturnType<typeof bookingHarness>>;

const DAY_MS = 24 * 60 * 60 * 1000;

// A customer: a converted lead with a customer row and the won Slack deal
// that converted it.
async function customerWithWonDeal(harness: Harness) {
  const { t, tenantId } = harness;
  return await t.run(async (ctx) => {
    const now = Date.now();
    const users = await ctx.db
      .query("users")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(10);
    const adminId = users.find((user) => user.role === "tenant_admin")!._id;
    const leadId = await ctx.db.insert("leads", {
      tenantId,
      fullName: "Repeat Buyer",
      email: "repeat@example.com",
      status: "converted",
      searchText: "repeat buyer repeat@example.com",
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
    const programId = await ctx.db.insert("tenantPrograms", {
      tenantId,
      name: "First Program",
      normalizedName: "first program",
      createdAt: 0,
      createdByUserId: adminId,
      updatedAt: 0,
    });
    const customerId = await ctx.db.insert("customers", {
      tenantId,
      leadId,
      fullName: "Repeat Buyer",
      email: "repeat@example.com",
      convertedAt: now,
      convertedByUserId: adminId,
      winningOpportunityId: opportunityId,
      programId,
      programName: "First Program",
      status: "active",
      createdAt: now,
    });
    await rebuildLeadCustomerSearchRow(ctx, tenantId, leadId);
    const installationId = await ctx.db.insert("slackInstallations", {
      tenantId, teamId: "T1", teamName: "Team", isEnterpriseInstall: false, appId: "A1",
      botUserId: "B1", botAccessToken: "xoxb", scopes: [], notifyChannelId: "C1",
      notifyChannelName: "qualified", installedByWorkosUserId: "user_slack",
      installedAt: 0, tokenExpiresAt: 0, refreshToken: "r", status: "active",
    });
    return { leadId, opportunityId, customerId, programId, installationId };
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

function qualify(
  harness: Harness,
  installationId: Id<"slackInstallations">,
  slackUserId = "U2",
) {
  return harness.t.mutation(internal.slack.createQualifiedLead.create, {
    tenantId: harness.tenantId,
    installationId,
    fullName: "Repeat Buyer",
    handle: "@repeat.buyer",
    country: "Mexico",
    leadType: "pt",
    qualifiedBy: { slackUserId, slackTeamId: "T1", submittedAt: Date.now() },
  });
}

describe("a second program", () => {
  it("lets a setter qualify a customer again in Slack", async () => {
    vi.useFakeTimers();
    const harness = await bookingHarness();
    const { leadId, opportunityId, installationId } =
      await customerWithWonDeal(harness);

    expect(await qualify(harness, installationId)).toMatchObject({ kind: "created" });

    const opportunities = await leadOpportunities(harness, leadId);
    expect(opportunities.map((o) => [o._id === opportunityId, o.status]).sort()).toEqual([
      [false, "qualified_pending"],
      [true, "payment_received"],
    ]);
  });

  it("still treats a deal in progress as already booked", async () => {
    vi.useFakeTimers();
    const harness = await bookingHarness();
    const { leadId, installationId } = await customerWithWonDeal(harness);
    await qualify(harness, installationId);

    expect(await qualify(harness, installationId, "U3")).toMatchObject({
      kind: "duplicate_pending",
    });
    expect(await leadOpportunities(harness, leadId)).toHaveLength(2);
  });

  it("opens a new Slack deal when the pending one is past the join window", async () => {
    vi.useFakeTimers();
    const harness = await bookingHarness();
    const { leadId, installationId } = await customerWithWonDeal(harness);
    await qualify(harness, installationId);
    // The digest has listed it; it closes as stale tomorrow.
    vi.setSystemTime(Date.now() + 30.5 * DAY_MS);

    expect(await qualify(harness, installationId, "U3")).toMatchObject({ kind: "created" });
    const pending = (await leadOpportunities(harness, leadId)).filter(
      (o) => o.status === "qualified_pending",
    );
    expect(pending).toHaveLength(2);
  });

  it("records a customer's side-deal payment on the same customer", async () => {
    vi.useFakeTimers();
    const harness = await bookingHarness();
    const { leadId, customerId, programId } = await customerWithWonDeal(harness);

    const created = await harness.closer.mutation(
      api.opportunities.createManual.createManual,
      { clientRequestId: "second-program", existingLeadId: leadId },
    );
    expect(created).toMatchObject({ leadId, leadWasCreated: false });
    const { paymentId } = await harness.closer.mutation(
      api.sideDeals.logPayment.logPayment,
      {
        opportunityId: created.opportunityId,
        amount: 250,
        currency: "USD",
        programId,
        paymentType: "pif",
      },
    );

    const state = await harness.t.run(async (ctx) => ({
      payment: await ctx.db.get("paymentRecords", paymentId),
      customers: await ctx.db
        .query("customers")
        .withIndex("by_tenantId_and_leadId", (q) =>
          q.eq("tenantId", harness.tenantId).eq("leadId", leadId),
        )
        .take(5),
      lead: await ctx.db.get("leads", leadId),
    }));
    expect(state.payment?.customerId).toBe(customerId);
    expect(state.customers.map((customer) => customer._id)).toEqual([customerId]);
    expect(state.customers[0]).toMatchObject({ totalPaidMinor: 25000 });
    expect(state.lead?.status).toBe("converted");
    expect((await leadOpportunities(harness, leadId)).map((o) => o.status).sort()).toEqual([
      "payment_received",
      "payment_received",
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

  it("offers customers in the side-deal lead picker, but not merged leads", async () => {
    vi.useFakeTimers();
    const harness = await bookingHarness();
    const { leadId } = await customerWithWonDeal(harness);
    await harness.t.run(async (ctx) => {
      const mergedId = await ctx.db.insert("leads", {
        tenantId: harness.tenantId,
        fullName: "Repeat Buyer",
        email: "repeat.old@example.com",
        status: "merged",
        mergedIntoLeadId: leadId,
        searchText: "repeat buyer repeat.old@example.com",
        firstSeenAt: 0,
        updatedAt: 0,
      });
      await rebuildLeadCustomerSearchRow(ctx, harness.tenantId, mergedId);
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
