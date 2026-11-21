import { describe, expect, it } from "vitest";
import { internal } from "../_generated/api";
import { timelineEventLabel } from "../leadCustomers/timeline";
import { hasPermission, type Permission } from "../lib/permissions";
import { addPinnedLine } from "../lib/pinnedLines";
import { getEventLabel } from "../reporting/lib/eventLabels";
import {
  FIXTURE_NOW,
  providerPaymentFixture,
  seedAppliedReceipt,
  seedReadyDecision,
} from "../../tests/providerPaymentFixtures";
import { seedProviderRow } from "../../tests/providerRowFixtures";

async function automationFixture() {
  const fixture = await providerPaymentFixture();
  const { t, tenantId, dealId, personId, adminId, closerId, programId, providerPaymentId } = fixture;
  const opportunityId = dealId!;
  const rows = await t.run(async (ctx) => {
    const paymentRecordId = await seedProviderRow(ctx, {
      tenantId, opportunityId, closerId, programId, providerPaymentId,
      amountMinor: 10000, recordedAt: FIXTURE_NOW, recorder: adminId,
    });
    const decisionId = await seedAppliedReceipt(ctx, {
      tenantId, opportunityId, leadId: personId, providerPaymentId,
      appliedPaymentRecordId: paymentRecordId, resolvedByUserId: adminId,
    });
    const correctionId = await ctx.db.insert("paymentCorrections", {
      tenantId, opportunityId, leadId: personId, paymentRecordId, providerPaymentId, decisionId,
      operation: "exclude",
      requestKey: "fixture-exclusion",
      level: "undo",
      cause: "wrong_match",
      result: "undo_booked",
      before: { paymentStatus: "recorded", dealPosition: "won", paymentReceivedAt: FIXTURE_NOW },
      after: { dealPosition: "booked", humanResultRevision: 2 },
      tasks: [],
      removedEnrollments: [],
      actorUserId: adminId,
      createdAt: FIXTURE_NOW + 1,
    });
    const lineId = await addPinnedLine(ctx, {
      tenantId, userId: closerId, opportunityId, paymentRecordId, decisionId, correctionId,
      kind: "win_removed",
      amountMinor: 10000,
      currency: "USD",
      createdAt: FIXTURE_NOW + 1,
    });
    return { decisionId, correctionId, lineId };
  });
  return { t, tenantId, ...rows };
}

describe("automation table cleanup", () => {
  it("deletes the tenant's automation rows and preserves another tenant's decision", async () => {
    const { t, tenantId, decisionId, correctionId, lineId } = await automationFixture();
    const otherDecisionId = await t.run(async (ctx) => {
      const otherTenantId = await ctx.db.insert("tenants", {
        companyName: "Other test tenant",
        contactEmail: "other@example.com",
        workosOrgId: "org_other_fixture",
        status: "active",
        inviteExpiresAt: 0,
        createdBy: "test",
      });
      return await seedReadyDecision(ctx, { tenantId: otherTenantId });
    });

    const result = await t.mutation(internal.admin.tenantsMutations.deleteTenantRuntimeDataBatch, { tenantId });

    expect(result.deletedCounts).toMatchObject({
      resultAutomationDecisions: 1,
      paymentCorrections: 1,
      closerPinnedLines: 1,
    });
    await t.run(async (ctx) => {
      expect(await ctx.db.get("resultAutomationDecisions", decisionId)).toBeNull();
      expect(await ctx.db.get("paymentCorrections", correctionId)).toBeNull();
      expect(await ctx.db.get("closerPinnedLines", lineId)).toBeNull();
      expect(await ctx.db.get("resultAutomationDecisions", otherDecisionId)).toMatchObject({ state: "ready" });
    });
  });

  it("counts and deletes the automation rows in the operational reset", async () => {
    const { t } = await automationFixture();
    const result = await t.action(internal.testing.operationalData.resetOperationalData, {
      confirmation: "DELETE_OPERATIONAL_DATA",
      dryRun: false,
    });

    const seeded = { resultAutomationDecisions: 1, paymentCorrections: 1, closerPinnedLines: 1 };
    expect(result).toMatchObject({
      mode: "executed",
      before: { counts: seeded },
      deletedCounts: seeded,
      after: { counts: { resultAutomationDecisions: 0, paymentCorrections: 0, closerPinnedLines: 0 } },
    });
  });
});

describe("automation labels", () => {
  it.each([
    ["payment.restored", "restored a payment", "Payment restored"],
    ["payment.flagged_not_my_sale", "flagged a payment as not their sale", "Flagged: not my sale"],
    ["payment.not_my_sale_cleared", "cleared a not-my-sale flag", "Not-my-sale flag cleared"],
  ])("labels %s in the activity feed and person timeline", (event, verb, label) => {
    expect(getEventLabel(event).verb).toBe(verb);
    expect(timelineEventLabel(event)).toBe(label);
  });

  it("registers settings changes and the restore icon in the activity feed", () => {
    expect(getEventLabel("automation.settings_changed").verb).toBe("changed automatic results settings");
    expect(getEventLabel("payment.restored").iconHint).toBe("undo-2");
  });
});

describe("automation permissions", () => {
  it.each([
    ["result-automation:view", true],
    ["result-automation:raise", false],
    ["result-automation:lower", true],
    ["result-automation:grade", true],
    ["result-automation:resolve-unsure", false],
  ] satisfies [Permission, boolean][])("checks the owner and admin grants for %s", (permission, adminAllowed) => {
    expect(hasPermission("tenant_master", permission)).toBe(true);
    expect(hasPermission("tenant_admin", permission)).toBe(adminAllowed);
    expect(hasPermission("closer", permission)).toBe(false);
  });
});
