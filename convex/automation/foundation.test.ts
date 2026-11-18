import { validate } from "convex-helpers/validators";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { timelineEventLabel } from "../leadCustomers/timeline";
import { getEventLabel } from "../reporting/lib/eventLabels";
import schema from "../schema";
import {
  FIXTURE_NOW,
  automationPaymentFixture,
  insertProviderMeeting,
  seedAppliedReceipt,
  seedAutomationSample,
  seedReadyDecision,
  setKindAutomatic,
  setPaymentFixtureModes,
} from "../../tests/providerPaymentFixtures";
import {
  callEvidenceOf,
  modeAtLeastAsk,
  paymentEvidenceOf,
  paymentProposalOf,
  taskProposalOf,
} from "./proposals";
import { effectiveKindMode } from "./settings";

// Package F3: the widened schema reads every row shaped like today's, and
// nothing new is reachable.

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function stored<T extends { _id: unknown; _creationTime: unknown }>(doc: T) {
  const { _id, _creationTime, ...fields } = doc;
  void _id;
  void _creationTime;
  return fields;
}

describe("rows shaped like today's", () => {
  it("validate under the widened tables and read back through the new helpers and queries", async () => {
    const f = await automationPaymentFixture();
    const { t, tenantId, dealId, personId, providerPaymentId, closerId, adminId, productBindingId } = f;
    const ids = await t.run(async (ctx) => {
      await setPaymentFixtureModes(ctx, { tenantId, adminId });
      const readyId = await seedReadyDecision(ctx, {
        tenantId, providerPaymentId, opportunityId: dealId, leadId: personId,
        proposal: {
          amountMinor: 10_000, currency: "USD", paymentType: "pif", programId: f.programId,
          attributedCloserId: closerId, expiresFollowUpIds: [],
        },
      });
      const appliedId = await seedAppliedReceipt(ctx, {
        tenantId, providerPaymentId, opportunityId: dealId, leadId: personId, createdAt: FIXTURE_NOW + 1,
      });
      const meetingId = await insertProviderMeeting(ctx, {
        tenantId, opportunityId: dealId!, closerId, scheduledAt: FIXTURE_NOW + 3_600_000,
      });
      const followUpId = await ctx.db.insert("followUps", {
        tenantId, opportunityId: dealId!, leadId: personId, closerId, type: "manual_reminder",
        reason: "closer_initiated", status: "pending", contactMethod: "call",
        reminderScheduledAt: FIXTURE_NOW + 86_400_000, createdAt: FIXTURE_NOW, createdSource: "closer",
      });
      return { readyId, appliedId, meetingId, followUpId };
    });

    await t.run(async (ctx) => {
      const rows: Array<[keyof typeof schema.tables, Doc<"resultAutomationDecisions" | "meetings" | "followUps" | "paymentProviderBindings" | "tenants">]> = [
        ["resultAutomationDecisions", (await ctx.db.get("resultAutomationDecisions", ids.readyId))!],
        ["resultAutomationDecisions", (await ctx.db.get("resultAutomationDecisions", ids.appliedId))!],
        ["meetings", (await ctx.db.get("meetings", ids.meetingId))!],
        ["followUps", (await ctx.db.get("followUps", ids.followUpId))!],
        ["paymentProviderBindings", (await ctx.db.get("paymentProviderBindings", productBindingId))!],
        ["tenants", (await ctx.db.get("tenants", tenantId))!],
      ];
      for (const [table, doc] of rows) {
        expect({ table, valid: validate(schema.tables[table].validator, stored(doc)) }).toEqual({ table, valid: true });
      }
      const ready = (await ctx.db.get("resultAutomationDecisions", ids.readyId))!;
      expect(paymentProposalOf(ready)).toMatchObject({ amountMinor: 10_000, currency: "USD" });
      expect(taskProposalOf(ready)).toBeUndefined();
      expect(paymentEvidenceOf(ready)).toEqual(ready.evidence);
      expect(callEvidenceOf(ready)).toBeNull();
    });

    expect(await f.owner.query(api.automation.settings.getSettings, {})).toMatchObject({
      effective: { payment_win: "ask", additional_payment: "ask" },
    });
    const tasks = await f.closer.query(api.closer.followUpQueries.getCloserTasks, {});
    expect(tasks.reminders.map((task) => task._id)).toEqual([ids.followUpId]);
    expect(await f.owner.mutation(api.automation.grading.reveal, { decisionId: ids.readyId })).toMatchObject({
      kind: "payment_win", proposal: { amountMinor: 10_000 },
    });
  });

  it("accepts a task a call decision writes, and the closer's task list returns it", async () => {
    const f = await automationPaymentFixture();
    const followUpId = await f.t.run((ctx) => ctx.db.insert("followUps", {
      tenantId: f.tenantId, opportunityId: f.dealId!, leadId: f.personId, closerId: f.closerId,
      type: "manual_reminder", reason: "call_insights", status: "pending", contactMethod: "text",
      reminderScheduledAt: FIXTURE_NOW + 86_400_000, createdAt: FIXTURE_NOW, createdSource: "system",
      purpose: "payment_owed", expectedAmountMinor: 50_000, expectedCurrency: "USD",
      promisedPaymentAt: FIXTURE_NOW + 2 * 86_400_000, declineCode: "insufficient_funds",
    }));
    const tasks = await f.closer.query(api.closer.followUpQueries.getCloserTasks, {});
    expect(tasks.reminders).toEqual([expect.objectContaining({ _id: followUpId, reason: "call_insights" })]);
  });
});

describe("the automatic level", () => {
  it("can't be set through setKindMode", async () => {
    const f = await automationPaymentFixture();
    await expect(f.owner.mutation(api.automation.settings.setKindMode, {
      kind: "payment_win", mode: "automatic" as never,
    })).rejects.toThrow(/Validator error: Expected one of literal/);
    expect(await f.t.run(async (ctx) => (await ctx.db.get("tenants", f.tenantId))?.resultAutomation ?? null)).toBeNull();
  });

  it("reads a hand-stored automatic with no certificate as ask, everywhere", async () => {
    const f = await automationPaymentFixture();
    await f.t.run((ctx) => setKindAutomatic(ctx, { tenantId: f.tenantId, adminId: f.adminId, kind: "payment_win" }));
    const tenant = (await f.t.run((ctx) => ctx.db.get("tenants", f.tenantId)))!;
    expect(tenant.resultAutomation?.kinds.payment_win.mode).toBe("automatic");
    expect(effectiveKindMode(tenant, "payment_win")).toBe("ask");
    expect((await f.owner.query(api.automation.settings.getSettings, {})).effective.payment_win).toBe("ask");
  });

  it("reads ask under a lapsed rule version or a breaker, and for a call kind with no call rule yet", async () => {
    const f = await automationPaymentFixture();
    const sampleId = await f.t.run((ctx) => seedAutomationSample(ctx, {
      tenantId: f.tenantId, status: "certified", certifiedAt: FIXTURE_NOW, target: 1,
    }));
    const modeWith = async (args: { ruleVersion?: string; breaker?: boolean }) => {
      await f.t.run((ctx) => setKindAutomatic(ctx, {
        tenantId: f.tenantId, adminId: f.adminId, kind: "payment_win", sampleId, ...args,
      }));
      return effectiveKindMode((await f.t.run((ctx) => ctx.db.get("tenants", f.tenantId)))!, "payment_win");
    };
    expect(await modeWith({ ruleVersion: "payment-rule@0" })).toBe("ask");
    expect(await modeWith({ breaker: true })).toBe("ask");
    // The reader as the contract writes it: only promoteKind (not built yet) writes this pointer.
    expect(await modeWith({})).toBe("automatic");

    const tenant = (await f.t.run((ctx) => ctx.db.get("tenants", f.tenantId)))!;
    const callBack = {
      ...tenant.resultAutomation!.kinds.payment_win,
      automatic: { ...tenant.resultAutomation!.kinds.payment_win.automatic!, ruleVersion: "call-rule@1" },
    };
    const withCallKind = {
      ...tenant, resultAutomation: { ...tenant.resultAutomation!, kinds: { ...tenant.resultAutomation!.kinds, call_back: callBack } },
    };
    // A call kind reads as off while Call insights is not switched on for the
    // tenant, whatever is stored (this fixture has no Call insights settings).
    expect(effectiveKindMode(withCallKind, "call_back")).toBe("off");
  });

  it("lowers a hand-stored automatic kind like any other level", async () => {
    const f = await automationPaymentFixture();
    await f.t.run((ctx) => setKindAutomatic(ctx, { tenantId: f.tenantId, adminId: f.adminId, kind: "payment_win" }));
    await f.admin.mutation(api.automation.settings.setKindMode, { kind: "payment_win", mode: "shadow" });
    const policy = (await f.t.run((ctx) => ctx.db.get("tenants", f.tenantId)))!.resultAutomation!.kinds.payment_win;
    expect(policy).toMatchObject({ mode: "shadow", policyVersion: 2 });
    expect(policy.automatic).toBeUndefined();
  });

  it("treats ask and automatic as at least ask", () => {
    expect(["off", "shadow", "ask", "automatic"].map((mode) => modeAtLeastAsk(mode as never)))
      .toEqual([false, false, true, true]);
  });
});

describe("automationSamples cleanup", () => {
  it("deletes the tenant's samples in the tenant reset and keeps another tenant's", async () => {
    const f = await automationPaymentFixture();
    const { sampleId, otherSampleId } = await f.t.run(async (ctx) => {
      const otherTenantId = await ctx.db.insert("tenants", {
        companyName: "Other test tenant", contactEmail: "other@example.com", workosOrgId: "org_other_fixture",
        status: "active", inviteExpiresAt: 0, createdBy: "test",
      });
      return {
        sampleId: await seedAutomationSample(ctx, { tenantId: f.tenantId }),
        otherSampleId: await seedAutomationSample(ctx, { tenantId: otherTenantId }),
      };
    });

    const result = await f.t.mutation(internal.admin.tenantsMutations.deleteTenantRuntimeDataBatch, { tenantId: f.tenantId });

    expect(result.deletedCounts).toMatchObject({ automationSamples: 1 });
    await f.t.run(async (ctx) => {
      expect(await ctx.db.get("automationSamples", sampleId)).toBeNull();
      expect(await ctx.db.get("automationSamples", otherSampleId)).toMatchObject({ status: "collecting" });
    });
  });

  it("counts and deletes samples in the operational reset", async () => {
    const f = await automationPaymentFixture();
    await f.t.run((ctx) => seedAutomationSample(ctx, { tenantId: f.tenantId }));
    const result = await f.t.action(internal.testing.operationalData.resetOperationalData, {
      confirmation: "DELETE_OPERATIONAL_DATA",
      dryRun: false,
    });
    expect(result).toMatchObject({
      mode: "executed",
      before: { counts: { automationSamples: 1 } },
      deletedCounts: { automationSamples: 1 },
      after: { counts: { automationSamples: 0 } },
    });
  });
});

describe("phase 3 event labels", () => {
  it.each([
    ["automation.notice_acknowledged", "acknowledged a refusal notice", "Refusal notice seen"],
    ["automation.notice_stopped", "stopped a refusal", "Refusal stopped"],
    ["meeting.attendance_withdrawn", "withdrew a held mark", "Held mark withdrawn"],
    ["automation.alert_answered", "answered a payment check", "Answered a payment check"],
    ["automation.kind_promoted", "switched a kind to automatic", "Switched a kind to automatic"],
    ["automation.breaker_tripped", "Automatic results paused a kind", "Automatic results paused a kind"],
    ["automation.audit_recorded", "audited an automatic result", "Audited an automatic result"],
  ])("labels %s in the activity feed and person timeline", (event, verb, label) => {
    expect(getEventLabel(event).verb).toBe(verb);
    expect(timelineEventLabel(event)).toBe(label);
  });
});
