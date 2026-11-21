import { describe, expect, it } from "vitest";
import type { Id } from "../_generated/dataModel";
import { deriveDecision, type PaymentDecisionInput } from "./derive";
import { paymentVetoTuple } from "./receipts";

const providerPaymentId = "10001providerPayments" as Id<"providerPayments">;
const leadId = "10001leads" as Id<"leads">;
const opportunityId = "10001opportunities" as Id<"opportunities">;
const closerId = "10001users" as Id<"users">;
const otherCloserId = "10002users" as Id<"users">;
const programId = "10001tenantPrograms" as Id<"tenantPrograms">;
const taskId = "10001followUps" as Id<"followUps">;
const meetingId = "10001meetings" as Id<"meetings">;
const paymentRecordId = "10001paymentRecords" as Id<"paymentRecords">;
const bindingId = "10001paymentProviderBindings" as Id<"paymentProviderBindings">;
const now = 10 * 86_400_000;
const paidAt = now - 60_000;

type Changes = Partial<Omit<PaymentDecisionInput, "deal" | "payment" | "mapping">> & {
  deal?: Partial<NonNullable<PaymentDecisionInput["deal"]>> | null;
  payment?: Partial<PaymentDecisionInput["payment"]>;
  mapping?: Partial<PaymentDecisionInput["mapping"]>;
};

const ready = { kind: "ready", leadId, opportunityId, matchMethod: "email_one_open_deal" } as const;
const membership = { bindingId, version: 1, anchorCounts: true };

function input({ deal, payment, mapping, ...overrides }: Changes = {}): PaymentDecisionInput {
  return {
    now, autoImportAfter: paidAt - 2000, target: ready, standDown: false,
    settings: { mode: "ask", policyVersion: 1, activationVersion: 1 },
    payment: {
      _id: providerPaymentId, status: "paid", currency: "USD", totalMinor: 10000, paidAt,
      adverseState: "none", billingReason: "one_time", lineItemCount: 1, allocationRevision: 0,
      sourceUpdatedAt: paidAt, reviewState: "needs_person", fenced: false, financing: false,
      excludedOpportunityIds: [], ...payment,
    },
    deal: deal === null ? null : {
      _id: opportunityId, position: "booked", isSideDeal: false, systemLoss: null,
      createdAt: paidAt - 1000, assignedCloserId: closerId, humanResultRevision: 0,
      storedPaymentCount: 0, personDealCount: 1, blockingManualPaymentIds: [], pendingTasks: [], ...deal,
    },
    mapping: { programId, paymentType: "pif", bindingIds: [], bindingVersions: [], ...mapping },
    membership: null,
    ...overrides,
  };
}

function held(reason: Extract<PaymentDecisionInput["target"], { kind: "needs_person" }>["reason"]): PaymentDecisionInput["target"] {
  return { kind: "needs_person", reason, candidateLeadId: leadId, candidateOpportunityIds: [opportunityId] };
}

describe("deriveDecision", () => {
  it.each([
    ["one open deal", {}],
    ["system loss with a trusted binding", {
      deal: { position: "lost", systemLoss: "no_show" }, target: { ...ready, matchMethod: "checkout_binding" },
    }],
    ["follow-up with a scheduling link", {
      deal: { position: "follow_up", pendingTasks: [{ _id: taskId, type: "scheduling_link", reason: "no_show_follow_up", closerId }] },
    }],
  ] satisfies [string, Changes][])("proposes a win for %s", (_name, fixtures) => {
    const result = deriveDecision(input(fixtures));
    expect(result).toMatchObject({ kind: "payment_win", wouldWrite: true, gates: [], confirmRoute: "billing" });
    expect(result?.proposal).toMatchObject({ amountMinor: 10000, currency: "USD", programId, attributedCloserId: closerId });
  });

  it.each([
    ["qualified only", { deal: { position: "qualified" }, target: held("qualified_only") }, "qualified_only"],
    ["side deal", { deal: { position: "call_held", isSideDeal: true }, target: held("side_deal") }, "side_deal"],
    ["lost by a person", { deal: { position: "lost" }, target: held("lost_by_person") }, "lost_by_person"],
    ["system loss without binding", { deal: { position: "lost", systemLoss: "stale" }, target: held("system_loss") }, "system_loss"],
    ["undone anchor", { deal: { position: "won" }, membership: { ...membership, anchorCounts: false } }, "won_deal_no_membership"],
    ["unmapped program", { mapping: { programId: undefined } }, "unmapped_product"],
    ["unmapped type", { mapping: { paymentType: undefined } }, "unmapped_product"],
    ["financing", { payment: { financing: true } }, "financing"],
    ["unbound renewal", { payment: { billingReason: "subscription_cycle" } }, "renewal_unbound"],
    ["unbound membership", { target: held("unbound_membership") }, "unbound_membership"],
    ["manual payment", { deal: { blockingManualPaymentIds: [paymentRecordId] } }, "unlinked_manual_payment"],
    ["no closer", { deal: { assignedCloserId: undefined } }, "no_closer"],
    ["credit conflict", { deal: { firstCountingCreditCloserId: otherCloserId } }, "credit_conflict"],
    ["task conflict", { deal: { pendingTasks: [{ _id: taskId, type: "manual_reminder", reason: "closer_initiated", closerId: otherCloserId }] } }, "task_closer_conflict"],
    ["40 stored payments", { deal: { storedPaymentCount: 40 } }, "capacity_hold"],
    ["100 deals", { deal: { personDealCount: 100 } }, "capacity_hold"],
    ["fenced", { payment: { fenced: true } }, "dispute"],
    ["refunded", { payment: { adverseState: "refunded" } }, "refund"],
    ["wrong match", { payment: { excludedOpportunityIds: [opportunityId] } }, "excluded_wrong_match"],
    ["stood down", { standDown: true }, "stood_down"],
    ["collected before the deal", { deal: { createdAt: paidAt + 1 } }, "deal_newer_than_payment"],
    ["seven days old", { now: paidAt + 7 * 86_400_000 }, "stale_payment"],
    ["at the import cutoff", { autoImportAfter: paidAt }, "historical"],
    ["multi-item", { payment: { lineItemCount: 2 } }, "multi_item"],
    ["unsupported currency", { payment: { totalMinor: undefined } }, "unsupported_currency"],
    ["unknown billing reason", { payment: { billingReason: "other" } }, "unknown_billing_reason"],
    ["wrong amount", { target: held("amount_mismatch") }, "amount_mismatch"],
    ["covers several", { factGates: ["covers_several"] }, "covers_several"],
  ] satisfies [string, Changes, string][])("abstains for %s", (_name, fixtures, gate) => {
    const result = deriveDecision(input(fixtures));
    expect(result).toMatchObject({ wouldWrite: false, gates: expect.arrayContaining([gate]) });
    expect(result?.proposal).toBeUndefined();
  });

  it.each([
    ["no open deal", "no_open_deal", []],
    ["several open deals", "several_open_deals", [opportunityId, "10002opportunities" as Id<"opportunities">]],
    ["unknown payer", "unknown_payer", []],
  ] as const)("leaves %s to Billing without choosing a deal", (_name, reason, candidates) => {
    expect(deriveDecision(input({
      target: { kind: "needs_person", reason, candidateLeadId: leadId, candidateOpportunityIds: [...candidates] },
    }))).toBeNull();
  });

  it("proposes an instalment on a won deal only with a counting membership anchor", () => {
    const result = deriveDecision(input({
      deal: { position: "won" }, membership, payment: { billingReason: "subscription_cycle" },
      target: { ...ready, matchMethod: "membership_binding" },
    }));
    expect(result).toMatchObject({ kind: "additional_payment", wouldWrite: true, confirmRoute: "billing" });
    expect(result?.vetoTuple).toEqual(paymentVetoTuple(providerPaymentId, opportunityId));
    expect(result?.vetoTuple).toEqual(deriveDecision(input())?.vetoTuple);
  });

  it("changes the fingerprint at meeting start and keeps it stable between temporal boundaries", () => {
    const deal = { currentMeeting: { _id: meetingId, scheduledAt: now + 100 } };
    const early = deriveDecision(input({ deal }));
    expect(early).toMatchObject({ confirmRoute: "billing" });
    expect(deriveDecision(input({ deal, now: now + 50 }))?.inputTuple).toEqual(early?.inputTuple);
    const starting = deriveDecision(input({ deal, now: now + 100 }));
    expect(starting).toMatchObject({ confirmRoute: "meeting", meetingId, noticeUserId: closerId });
    expect(starting?.inputTuple).not.toEqual(early?.inputTuple);
  });

  it("routes follow-up to the assigned closer's own pending manual reminder", () => {
    expect(deriveDecision(input({
      deal: {
        position: "follow_up",
        pendingTasks: [{ _id: taskId, type: "manual_reminder", reason: "closer_initiated", closerId }],
      },
    }))).toMatchObject({
      confirmRoute: "reminder", noticeUserId: closerId,
      proposal: { completesFollowUpId: taskId, expiresFollowUpIds: [] },
    });
  });
});
