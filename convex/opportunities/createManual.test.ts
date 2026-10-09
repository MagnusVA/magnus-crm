import { afterEach, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import { bookingHarness } from "../../tests/bookingHarness";

afterEach(() => vi.useRealTimers());

it.each(["different_leads", "different_email"] as const)(
  "rejects manual duplicate identity with the manual error (%s)",
  async (conflict) => {
    vi.useFakeTimers();
    const { t, tenantId, closer } = await bookingHarness();
    await t.run(async (ctx) => {
      const phoneLeadId = await ctx.db.insert("leads", {
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
        await ctx.db.insert("leads", {
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
