import { afterEach, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import { bookingHarness, qualifiedLifecycle } from "../../tests/bookingHarness";

afterEach(() => vi.useRealTimers());

it.each(["different_leads", "different_email"] as const)(
  "rejects manual duplicate identity with the manual error (%s)",
  async (conflict) => {
    vi.useFakeTimers();
    const { t, tenantId, closer } = await bookingHarness();
    await t.run(async (ctx) => {
      const phoneLeadId = await ctx.db.insert("leads", { ...qualifiedLifecycle(Date.now()),
        tenantId,
        email: "phone-owner@example.com",
        status: "active",
        firstSeenAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.insert("leadIdentifiers", {
        tenantId,
        leadId: phoneLeadId,
        type: "phone",
        value: "+17789559253",
        rawValue: "+17789559253",
        source: "manual_entry",
        confidence: "verified",
        createdAt: Date.now(),
      });
      if (conflict === "different_leads")
        await ctx.db.insert("leads", { ...qualifiedLifecycle(Date.now()),
          tenantId,
          email: "submitted@example.com",
          status: "active",
          firstSeenAt: Date.now(),
          updatedAt: Date.now(),
        });
    });
    await expect(
      closer.mutation(api.opportunities.createManual.createManual, {
        clientRequestId: "manual-duplicate",
        newLeadInput: {
          fullName: "Test Lead",
          email: "submitted@example.com",
          phone: "+17789559253",
        },
      }),
    ).rejects.toThrow("opportunity.lead_already_exists");
    // A rejected manual create must not add aliases or an opportunity.
    const state = await t.run(async (ctx) => ({
      identifiers: await ctx.db.query("leadIdentifiers").take(2),
      opportunities: await ctx.db.query("opportunities").take(1),
    }));
    expect(state.identifiers).toHaveLength(1);
    expect(state.opportunities).toHaveLength(0);
  },
);

it("rejects a placeholder email for a new side-deal lead", async () => {
  vi.useFakeTimers();
  const { t, closer } = await bookingHarness();
  await expect(
    closer.mutation(api.opportunities.createManual.createManual, {
      clientRequestId: "manual-placeholder-email",
      newLeadInput: { fullName: "Test Lead", email: "Email@Gmail.com" },
    }),
  ).rejects.toThrow("opportunity.placeholder_email");
  const state = await t.run(async (ctx) => ({
    leads: await ctx.db.query("leads").take(1),
    opportunities: await ctx.db.query("opportunities").take(1),
  }));
  expect(state.leads).toHaveLength(0);
  expect(state.opportunities).toHaveLength(0);
});

it("asks for the lead's email when a payment would convert a lead without one", async () => {
  vi.useFakeTimers();
  const { t, tenantId, closer } = await bookingHarness();
  const { leadId, programId } = await t.run(async (ctx) => {
    const users = await ctx.db
      .query("users")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(10);
    const adminId = users.find((user) => user.role === "tenant_admin")!._id;
    // What a booking with only a placeholder email now leaves behind.
    const leadId = await ctx.db.insert("leads", { ...qualifiedLifecycle(Date.now()),
      tenantId,
      fullName: "No Email",
      status: "active",
      firstSeenAt: Date.now(),
      updatedAt: Date.now(),
    });
    const programId = await ctx.db.insert("tenantPrograms", {
      tenantId,
      name: "Program",
      normalizedName: "program",
      createdAt: 0,
      createdByUserId: adminId,
      updatedAt: 0,
    });
    return { leadId, programId };
  });
  const { opportunityId } = await closer.mutation(
    api.opportunities.createManual.createManual,
    { clientRequestId: "no-email", existingLeadId: leadId },
  );

  await expect(
    closer.mutation(api.sideDeals.logPayment.logPayment, {
      opportunityId,
      amount: 100,
      currency: "USD",
      programId,
      paymentType: "pif",
    }),
  ).rejects.toThrow("customer.lead_email_missing");
  const payments = await t.run((ctx) => ctx.db.query("paymentRecords").take(1));
  expect(payments).toHaveLength(0);
});
