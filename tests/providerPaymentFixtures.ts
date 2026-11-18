import { anyApi, type ApiFromModules } from "convex/server";
import { PAYMENT_RULE_VERSION } from "../convex/automation/derive";
import { paymentVetoKey } from "../convex/automation/receipts";
import type { Doc, Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";
import { sha256Hex, stableJson } from "../convex/lib/stableHash";
import { stageOfPosition, type DealPosition, type SystemLossReason } from "../convex/opportunities/stages";
import { bookingHarness, qualifiedLifecycle } from "./bookingHarness";
import { insertProgram } from "./enrollmentFixtures";
import { insertOpportunityAggregate } from "../convex/reporting/writeHooks";

export const FIXTURE_NOW = Date.parse("2026-11-17T19:00:00Z");
export const FIXTURE_PAID_AT = FIXTURE_NOW - 60 * 60 * 1000;
export const PAYER_EMAIL = "river@example.com";
export const PRODUCT_ID = "prod_fixture";
export const VARIANT_ID = "plan_fixture";

export async function insertProviderPerson(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  fields: Partial<Omit<Doc<"leads">, "_id" | "_creationTime" | "tenantId">> = {},
) {
  return await ctx.db.insert("leads", {
    ...qualifiedLifecycle(FIXTURE_PAID_AT - 1000),
    tenantId,
    firstSeenAt: FIXTURE_PAID_AT - 1000,
    updatedAt: FIXTURE_PAID_AT - 1000,
    fullName: "River Patel",
    email: PAYER_EMAIL,
    status: "active",
    ...fields,
  });
}

export async function insertProviderIdentifier(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
  type: "email" | "phone",
  value: string,
  confidence: Doc<"leadIdentifiers">["confidence"] = "verified",
) {
  return await ctx.db.insert("leadIdentifiers", {
    tenantId, leadId, type, value, rawValue: value, confidence,
    source: "manual_entry", createdAt: FIXTURE_PAID_AT - 1000,
  });
}

export async function insertProviderFact(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  connectionId: Id<"tenantPaymentConnections">,
  fields: Partial<Omit<Doc<"providerPayments">, "_id" | "_creationTime" | "tenantId" | "connectionId">> = {},
) {
  return await ctx.db.insert("providerPayments", {
    tenantId,
    connectionId,
    externalPaymentId: "pay_fixture",
    status: "paid",
    sourceUpdatedAt: FIXTURE_PAID_AT,
    sourceCreatedAt: FIXTURE_PAID_AT,
    refreshGeneration: 1,
    allocationRevision: 0,
    adverseReviewRevision: 0,
    adverseFenceRevision: 0,
    firstSeenAt: FIXTURE_NOW - 2000,
    paidAt: FIXTURE_PAID_AT,
    totalMinor: 10000,
    currency: "USD",
    decimals: 2,
    refundedMinor: 0,
    adverseState: "none",
    billingReason: "one_time",
    productId: PRODUCT_ID,
    variantId: VARIANT_ID,
    productTitle: "Sales training",
    variantTitle: "Pay in full",
    lineItemCount: 1,
    paymentMethodType: "card",
    failedAttemptCount: 0,
    payerEmail: PAYER_EMAIL,
    reviewState: "not_actionable",
    ...fields,
  });
}

type Binding = Doc<"paymentProviderBindings">["binding"];

export async function insertProviderDeal(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    leadId: Id<"leads">;
    position?: DealPosition;
    lostReason?: SystemLossReason;
    source?: Doc<"opportunities">["source"];
    assignedCloserId?: Id<"users">;
    latestMeetingAt?: number;
  },
) {
  const { tenantId, leadId, source = "calendly", lostReason, assignedCloserId, latestMeetingAt } = args;
  const position = args.position ?? (source === "side_deal" ? "call_held" : "booked");
  const opportunityId = await ctx.db.insert("opportunities", {
    ...stageOfPosition(position),
    source, lostReason,
    tenantId, leadId, assignedCloserId, latestMeetingAt,
    createdAt: FIXTURE_PAID_AT - 1000,
    updatedAt: FIXTURE_PAID_AT - 1000,
  });
  await insertOpportunityAggregate(ctx, opportunityId);
  return opportunityId;
}

export async function insertProviderBinding(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    connectionId: Id<"tenantPaymentConnections">;
    adminId: Id<"users">;
    externalId: string;
    binding: Binding;
    enabled?: boolean;
  },
) {
  const { tenantId, connectionId, adminId, externalId, binding, enabled = true } = args;
  return await ctx.db.insert("paymentProviderBindings", {
    tenantId, connectionId, externalId, kind: binding.kind, binding, enabled,
    opportunityId: "opportunityId" in binding ? binding.opportunityId : undefined,
    version: 1, setByUserId: adminId, setAt: FIXTURE_NOW - 1000,
  });
}

type DecisionFixture = Pick<Doc<"resultAutomationDecisions">, "tenantId"> & Partial<Omit<
  Doc<"resultAutomationDecisions">,
  "_id" | "_creationTime" | "tenantId" | "mode" | "state"
>>;

async function seedDecision(
  ctx: MutationCtx,
  state: "ready" | "applied",
  args: DecisionFixture,
) {
  const {
    kind = "payment_win",
    createdAt = FIXTURE_NOW,
    humanResultRevision = 0,
    inputKey,
    vetoKey,
    ...fields
  } = args;
  const subject = [kind, fields.providerPaymentId, fields.opportunityId];
  return await ctx.db.insert("resultAutomationDecisions", {
    kind,
    mode: "ask",
    state,
    inputKey: inputKey ?? await sha256Hex(stableJson(["fixture", state, ...subject, humanResultRevision, createdAt])),
    vetoKey: vetoKey ?? (fields.providerPaymentId && fields.opportunityId
      ? await paymentVetoKey(fields.providerPaymentId, fields.opportunityId)
      : await sha256Hex(stableJson(subject))),
    ruleVersion: PAYMENT_RULE_VERSION,
    policyVersion: 1,
    activationVersion: 1,
    humanResultRevision,
    wouldWrite: true,
    gates: [],
    confirmRoute: "billing",
    evidence: {
      allocationRevision: 0,
      sourceUpdatedAt: FIXTURE_PAID_AT,
      bindingIds: [],
      bindingVersions: [],
    },
    createdAt,
    ...fields,
  });
}

export async function seedReadyDecision(ctx: MutationCtx, args: DecisionFixture) {
  return await seedDecision(ctx, "ready", args);
}

export async function seedAppliedReceipt(ctx: MutationCtx, args: DecisionFixture) {
  return await seedDecision(ctx, "applied", {
    resolvedAt: args.createdAt ?? FIXTURE_NOW,
    appliedVia: "billing",
    humanResultRevisionAfter: (args.humanResultRevision ?? 0) + 1,
    ...args,
  });
}

export async function providerPaymentFixture(
  options: {
    dealPosition?: DealPosition | null;
    lostReason?: SystemLossReason;
    source?: Doc<"opportunities">["source"];
    fact?: Parameters<typeof insertProviderFact>[3];
  } = {},
) {
  const harness = await bookingHarness({ transactionLimits: true });
  const { tenantId } = harness;
  const ids = await harness.t.run(async (ctx) => {
    await ctx.db.patch("tenants", tenantId, { billingOpsEnabled: true });
    const users = await ctx.db.query("users").withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId)).take(10);
    const adminId = users.find((user) => user.role === "tenant_admin")!._id;
    const closerId = users.find((user) => user.role === "closer")!._id;
    const personId = await insertProviderPerson(ctx, tenantId);
    const dealId = options.dealPosition === null ? undefined : await insertProviderDeal(ctx, {
      tenantId,
      leadId: personId,
      position: options.dealPosition,
      lostReason: options.lostReason,
      source: options.source,
      assignedCloserId: closerId,
      latestMeetingAt: FIXTURE_PAID_AT + 1000,
    });
    const programId = await insertProgram(ctx, tenantId, "Sales training");
    const connectionId = await ctx.db.insert("tenantPaymentConnections", {
      tenantId,
      provider: "whop",
      environment: "sandbox",
      accountId: "biz_fixture",
      credentialKind: "account_key",
      apiKey: "fixture-key",
      keyLast4: "-key",
      apiVersionDate: "2026-11-16-2",
      status: "connected",
      disputeAccess: "ok",
      autoImportAfter: FIXTURE_NOW - 30 * 86_400_000,
      connectedByUserId: adminId,
      connectedAt: FIXTURE_NOW - 30 * 86_400_000,
      lastSuccessfulSweepAt: FIXTURE_NOW - 1000,
    });
    const productBindingId = await insertProviderBinding(ctx, {
      tenantId, connectionId, adminId, externalId: PRODUCT_ID,
      binding: { kind: "product_program", programId },
    });
    const variantBindingId = await insertProviderBinding(ctx, {
      tenantId, connectionId, adminId, externalId: VARIANT_ID,
      binding: { kind: "variant_type", paymentType: "pif" },
    });
    const providerPaymentId = await insertProviderFact(ctx, tenantId, connectionId, options.fact);
    return { adminId, closerId, personId, dealId, connectionId, providerPaymentId, programId, productBindingId, variantBindingId };
  });
  return { ...harness, ...ids };
}

export async function setPaymentFixtureModes(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    adminId: Id<"users">;
    winMode?: "off" | "shadow" | "ask";
    additionalMode?: "off" | "shadow" | "ask";
    enabled?: boolean;
    pausedAt?: number;
  },
) {
  const stamp = {
    policyVersion: 1,
    changedAt: FIXTURE_NOW,
    changedByUserId: args.adminId,
  };
  await ctx.db.patch("tenants", args.tenantId, {
    resultAutomation: {
      enabled: args.enabled ?? true,
      activationVersion: 1,
      pausedAt: args.pausedAt,
      changedAt: stamp.changedAt,
      changedByUserId: stamp.changedByUserId,
      kinds: {
        payment_win: { ...stamp, mode: args.winMode ?? "ask" },
        additional_payment: { ...stamp, mode: args.additionalMode ?? "ask" },
      },
    },
  });
}

export async function insertPaymentFixtureConnection(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  connectedByUserId: Id<"users">,
) {
  return await ctx.db.insert("tenantPaymentConnections", {
    tenantId,
    provider: "whop",
    environment: "sandbox",
    accountId: "biz_writer_fixture",
    credentialKind: "account_key",
    apiKey: "fixture-key",
    keyLast4: "-key",
    apiVersionDate: "2026-11-16-2",
    status: "connected",
    disputeAccess: "ok",
    autoImportAfter: FIXTURE_PAID_AT - 86_400_000,
    connectedByUserId,
    connectedAt: FIXTURE_PAID_AT - 86_400_000,
  });
}

export const automationFixtureApi = (anyApi as unknown as ApiFromModules<{
  "automation/decisions": typeof import("../convex/automation/decisions");
  "automation/settings": typeof import("../convex/automation/settings");
  "automation/grading": typeof import("../convex/automation/grading");
  "automation/scorecard": typeof import("../convex/automation/scorecard");
  "automation/sweep": typeof import("../convex/automation/sweep");
}>).automation;

export async function automationPaymentFixture(
  options?: Parameters<typeof providerPaymentFixture>[0],
) {
  const fixture = await providerPaymentFixture(options);
  const ownerId = await fixture.t.run((ctx) => ctx.db.insert("users", {
    tenantId: fixture.tenantId, workosUserId: "user_owner", email: "owner@example.com",
    role: "tenant_master", isActive: true,
  }));
  const owner = fixture.t.withIdentity({ subject: "user_owner", org_id: "org_test" });
  return { ...fixture, owner, ownerId };
}

// ─── Taking a payment out and putting it back (package X) ───────────────
// Imports for the helpers below; ES modules hoist them.
import { evaluateSubject as xEvaluateSubject } from "../convex/automation/decisions";
import { api as xApi } from "../convex/_generated/api";
import { syncPersonEnrollments as xSyncPersonEnrollments } from "../convex/lib/enrollments";
import {
  computeLatestActivityAt as xComputeLatestActivityAt,
  transitionOpportunity as xTransitionOpportunity,
} from "../convex/lib/opportunityActivity";
import { refreshSoldProgramCachesForOpportunity as xRefreshSoldProgramCaches } from "../convex/lib/soldProgramCache";
import { systemLossReasonOf as xSystemLossReasonOf } from "../convex/opportunities/stages";
import { setActiveAllocation as xSetActiveAllocation } from "../convex/payments/allocation";
import { markAttendanceOwed as xMarkAttendanceOwed } from "../convex/payments/attendanceDebt";
import { insertMeetingAggregate as xInsertMeetingAggregate } from "../convex/reporting/writeHooks";
import { insertCloserMeeting as xInsertCloserMeeting } from "./closerPipelineFixtures";
import { seedProviderRow as xSeedProviderRow } from "./providerRowFixtures";

/** A meeting on the deal, counted by the meeting aggregate, that becomes its current booking. */
export async function insertProviderMeeting(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    opportunityId: Id<"opportunities">;
    closerId: Id<"users">;
    status?: Doc<"meetings">["status"];
    scheduledAt: number;
  },
) {
  const meetingId = await xInsertCloserMeeting(ctx, { ...args, status: args.status ?? "scheduled" });
  await xInsertMeetingAggregate(ctx, meetingId);
  return meetingId;
}

/**
 * A Whop payment a person confirmed in Billing on the deal, written the way
 * the apply core writes it: the provider row, the move to won (from a system
 * loss through `provider_payment_after_system_loss`), the active allocation,
 * the sold program, enrollments, attendance owed, the tasks it expired, and
 * its apply receipt with the before-fields one-tap undo reads and the
 * human-result revision the confirmation left.
 */
export async function seedBillingWin(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    opportunityId: Id<"opportunities">;
    providerPaymentId: Id<"providerPayments">;
    programId: Id<"tenantPrograms">;
    closerId: Id<"users">;
    approverId: Id<"users">;
    recordedAt: number;
    expireTaskIds?: Id<"followUps">[];
  },
): Promise<{ paymentRecordId: Id<"paymentRecords">; decisionId: Id<"resultAutomationDecisions"> }> {
  const deal = (await ctx.db.get("opportunities", args.opportunityId))!;
  const payment = (await ctx.db.get("providerPayments", args.providerPaymentId))!;
  const systemLoss = xSystemLossReasonOf(deal);
  const position = systemLoss ? "system_loss" : deal.outcome === "won" ? "won" : deal.stage === "follow_up" ? "follow_up" : "booked";
  const meetings = await ctx.db.query("meetings")
    .withIndex("by_opportunityId", (q) => q.eq("opportunityId", deal._id)).take(20);
  const tasks: Array<{ followUpId: Id<"followUps">; status: Doc<"followUps">["status"] }> = [];
  for (const followUpId of args.expireTaskIds ?? []) {
    const task = (await ctx.db.get("followUps", followUpId))!;
    tasks.push({ followUpId, status: task.status });
    await ctx.db.patch("followUps", followUpId, { status: "expired" });
  }
  const before = {
    position,
    systemLossReason: systemLoss ?? undefined,
    lostAt: deal.lostAt,
    latestActivityAt: deal.latestActivityAt ?? xComputeLatestActivityAt(deal),
    meetings: meetings.map((meeting) => ({ meetingId: meeting._id, status: meeting.status })),
    tasks,
  } as const;

  const paymentRecordId = await xSeedProviderRow(ctx, {
    tenantId: args.tenantId,
    opportunityId: args.opportunityId,
    closerId: args.closerId,
    programId: args.programId,
    amountMinor: payment.totalMinor ?? 0,
    currency: payment.currency,
    recordedAt: args.recordedAt,
    recorder: args.approverId,
    providerPaymentId: payment._id,
    providerPaidAt: payment.paidAt,
  });
  if (deal.outcome !== "won") {
    await xTransitionOpportunity(ctx, args.opportunityId, {
      to: { stage: "closed", outcome: "won" },
      fields: { paymentReceivedAt: args.recordedAt, updatedAt: args.recordedAt },
      exception: systemLoss ? "provider_payment_after_system_loss" : undefined,
      source: "admin",
      actorUserId: args.approverId,
      occurredAt: args.recordedAt,
    });
  }
  await xSetActiveAllocation(ctx, {
    payment,
    record: (await ctx.db.get("paymentRecords", paymentRecordId))!,
    expectedAllocationRevision: payment.allocationRevision,
    reviewState: "recorded",
    matchMethod: "person",
    actorUserId: args.approverId,
    now: args.recordedAt,
  });
  await xRefreshSoldProgramCaches(ctx, { tenantId: args.tenantId, opportunityId: args.opportunityId });
  await xSyncPersonEnrollments(ctx, {
    tenantId: args.tenantId, leadId: deal.leadId, now: args.recordedAt, source: "admin", actorUserId: args.approverId,
  });
  if (deal.outcome !== "won") await xMarkAttendanceOwed(ctx, args.opportunityId);

  const revision = deal.humanResultRevision ?? 0;
  const decisionId = await seedAppliedReceipt(ctx, {
    tenantId: args.tenantId,
    providerPaymentId: payment._id,
    opportunityId: args.opportunityId,
    leadId: deal.leadId,
    assignedCloserId: deal.assignedCloserId,
    appliedPaymentRecordId: paymentRecordId,
    resolvedByUserId: args.approverId,
    humanResultRevision: revision,
    humanResultRevisionAfter: revision + 1,
    createdAt: args.recordedAt,
    before,
  });
  await ctx.db.patch("paymentRecords", paymentRecordId, { automationDecisionId: decisionId });
  // The confirmation's own human result, as noteHumanResult writes it.
  await ctx.db.patch("opportunities", args.opportunityId, { humanResultRevision: revision + 1 });
  return { paymentRecordId, decisionId };
}

/**
 * The closer confirms the fixture's Whop payment on its deal with "Record
 * payment · call attended" (`logPayment` with the confirm intent): a
 * scheduled meeting that started half an hour ago becomes held.
 */
export async function confirmAttendedWhopWin(
  fixture: Awaited<ReturnType<typeof providerPaymentFixture>>,
  options: { paymentType?: Doc<"paymentRecords">["paymentType"] } = {},
) {
  const { t, tenantId, closerId, providerPaymentId } = fixture;
  const opportunityId = fixture.dealId!;
  const { meetingId, decisionId } = await t.run(async (ctx) => {
    await setPaymentFixtureModes(ctx, fixture);
    await ctx.db.patch("providerPayments", providerPaymentId, { reviewState: "needs_person" });
    const meetingId = await insertProviderMeeting(ctx, {
      tenantId, opportunityId, closerId, scheduledAt: FIXTURE_NOW - 1_800_000,
    });
    if (options.paymentType) {
      await ctx.db.patch("paymentProviderBindings", fixture.variantBindingId, {
        binding: { kind: "variant_type", paymentType: options.paymentType },
      });
    }
    const { decisionId } = await xEvaluateSubject(ctx, { tenantId, providerPaymentId, now: FIXTURE_NOW, cause: "sweep" });
    if (!decisionId) throw new Error("Expected a ready Whop decision for the fixture");
    return { meetingId, decisionId };
  });
  const payment = (await t.run((ctx) => ctx.db.get("providerPayments", providerPaymentId)))!;
  const paymentRecordId = await fixture.closer.mutation(xApi.closer.payments.logPayment, {
    opportunityId,
    meetingId,
    programId: fixture.programId,
    amount: (payment.totalMinor ?? 0) / 100,
    currency: payment.currency,
    paymentType: options.paymentType ?? "pif",
    provider: { kind: "confirm", providerPaymentId, decisionId, expectedAllocationRevision: payment.allocationRevision },
  });
  return { paymentRecordId, meetingId, decisionId };
}

import { insertPaymentAggregate as xInsertPaymentAggregate } from "../convex/reporting/writeHooks";

/** A manual later payment on a won deal, through the payment, sold-program and enrollment hooks. */
export async function seedManualPayment(
  ctx: MutationCtx,
  f: { tenantId: Id<"tenants">; closerId: Id<"users">; personId: Id<"leads"> },
  args: {
    opportunityId: Id<"opportunities">;
    programId: Id<"tenantPrograms">;
    recordedAt: number;
    amountMinor?: number;
    origin?: Doc<"paymentRecords">["origin"];
  },
) {
  const id = await ctx.db.insert("paymentRecords", {
    tenantId: f.tenantId, opportunityId: args.opportunityId, attributedCloserId: f.closerId,
    recordedByUserId: f.closerId, amountMinor: args.amountMinor ?? 5000, currency: "USD",
    programId: args.programId, programName: "Program", paymentType: "split", status: "recorded",
    statusChangedAt: args.recordedAt, recordedAt: args.recordedAt, origin: args.origin ?? "closer_additional",
  });
  await xInsertPaymentAggregate(ctx, id);
  await xRefreshSoldProgramCaches(ctx, { tenantId: f.tenantId, opportunityId: args.opportunityId });
  await xSyncPersonEnrollments(ctx, { tenantId: f.tenantId, leadId: f.personId, source: "closer", actorUserId: f.closerId });
  return id;
}

export const paymentConfirmationApi = (anyApi as unknown as ApiFromModules<{
  "payments/confirm": typeof import("../convex/payments/confirm");
  "payments/notMySale": typeof import("../convex/payments/notMySale");
  "closer/attendanceOnly": typeof import("../convex/closer/attendanceOnly");
  "closer/pinnedLines": typeof import("../convex/closer/pinnedLines");
}>);

export async function paymentConfirmationFixture(
  options?: Parameters<typeof automationPaymentFixture>[0],
) {
  const f = await automationPaymentFixture({
    ...options,
    fact: { reviewState: "needs_person", ...options?.fact },
  });
  if (!f.dealId) throw new Error("Payment confirmation needs a deal");
  await f.t.run((ctx) => setPaymentFixtureModes(ctx, f));
  return { ...f, dealId: f.dealId };
}

export async function seedReadablePaymentRecording(
  ctx: MutationCtx & Pick<import("../convex/_generated/server").ActionCtx, "storage">,
  args: {
    tenantId: Id<"tenants">;
    meetingId: Id<"meetings">;
    closerId: Id<"users">;
    ownerId: Id<"users">;
  },
) {
  const { tenantId, meetingId, closerId, ownerId } = args;
  await ctx.db.patch("tenants", tenantId, {
    secondOpinion: { mode: "on", monthlyCapUsd: 40, changedAt: FIXTURE_NOW, changedByUserId: ownerId },
  });
  const connectionId = await ctx.db.insert("tenantFathomConnections", {
    tenantId, apiKey: "fixture", keyLast4: "ture", webhookSecret: "fixture", webhookId: "fixture",
    connectionStatus: "connected", triggeredFor: [], connectedByUserId: ownerId, connectedAt: FIXTURE_NOW,
  });
  const transcriptStorageId = await ctx.storage.store(new Blob(["[]"], { type: "application/json" }));
  return await ctx.db.insert("callRecordings", {
    tenantId, connectionId, meetingId, transcriptStorageId, transcriptLineCount: 0, matchStatus: "matched",
    recordedByUserId: closerId, recordedByEmail: "closer@example.com", inviteeEmails: [PAYER_EMAIL],
    fathomRecordingId: 1, title: "Sales call", url: "https://fathom.video/calls/1", shareUrl: "https://fathom.video/share/1",
    recordingStartAt: FIXTURE_NOW - 3600_000, recordingEndAt: FIXTURE_NOW - 1800_000, createdAt: FIXTURE_NOW,
  });
}

// ─── Call decisions and certificate samples (phase 3, package F3) ───────
// Imports for the helpers below; ES modules hoist them.
import {
  CALL_CHECKS_VERSION as f3ChecksVersion,
  DEFAULT_EXTRACTION_MODEL as f3Model,
  EVIDENCE_PROMPT_VERSION as f3PromptVersion,
  THRESHOLDS_VERSION as f3ThresholdsVersion,
} from "../convex/callInsights/validators";
import { TAXONOMY_VERSION as f3TaxonomyVersion } from "../lib/callInsights/taxonomy";

export const CALL_RULE_FIXTURE_VERSION = "call-rule@1";
const CALL_SLOT_ENDED_AT = FIXTURE_NOW - 1800_000;
let callDecisionFixtureSeq = 0;

/** A published serving run on the recording, with one prospect refusal in its evidence. */
export async function seedCallRun(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    meetingId: Id<"meetings">;
    recordingId: Id<"callRecordings">;
    quote?: string;
    quotesPurgedAt?: number;
  },
) {
  return await ctx.db.insert("callInsightRuns", {
    tenantId: args.tenantId,
    recordingId: args.recordingId,
    meetingId: args.meetingId,
    purpose: "serve",
    generation: 1,
    inputKey: `fixture-run-${args.meetingId}-${args.recordingId}`,
    trigger: "recording_matched",
    kind: "full",
    status: "answered",
    attempt: 1,
    config: {
      model: f3Model, promptVersion: f3PromptVersion, taxonomyVersion: f3TaxonomyVersion,
      thresholdsVersion: f3ThresholdsVersion, itemCheck: false, callEvidence: true,
    },
    receipts: [],
    evidence: {
      recordingScope: "whole",
      scopeLines: [0],
      statements: [{ kind: "declines", quote: args.quote ?? "Synthetic refusal line.", lineIndex: 0, atSeconds: 60, speaker: "Prospect" }],
      prospectStance: "refused",
      closerStance: "continues",
      nextStep: "none",
      dropped: { quoteNotFound: 0, amountNotInQuote: 0, cardNumber: 0, overLimit: 0 },
    },
    quotesPurgedAt: args.quotesPurgedAt,
    createdAt: FIXTURE_NOW,
  });
}

/** The evidence a call decision stores: references to its run, never words. */
export function callEvidenceRef(args: { runId: Id<"callInsightRuns">; recordingId: Id<"callRecordings"> }) {
  return {
    type: "call" as const,
    runId: args.runId,
    recordingId: args.recordingId,
    generation: 1,
    promptVersion: f3PromptVersion,
    model: f3Model,
    thresholdsVersion: f3ThresholdsVersion,
    checksVersion: f3ChecksVersion,
    readTrigger: "recording_matched" as const,
    publishedAt: FIXTURE_NOW,
    slotEndedAt: CALL_SLOT_ENDED_AT,
  };
}

type CallDecisionKind = "call_back" | "payment_owed" | "refusal_loss" | "paid_on_call_alert";
type CallDecisionFixture = {
  tenantId: Id<"tenants">;
  kind: CallDecisionKind;
  opportunityId: Id<"opportunities">;
  leadId: Id<"leads">;
  meetingId: Id<"meetings">;
  closerId: Id<"users">;
  runId: Id<"callInsightRuns">;
  recordingId: Id<"callRecordings">;
} & Partial<Omit<Doc<"resultAutomationDecisions">, "_id" | "_creationTime" | "tenantId" | "kind">>;

/** The proposal each call kind stores, with synthetic values. */
export function callProposalFixture(kind: CallDecisionKind, closerId: Id<"users">, meetingId: Id<"meetings">) {
  if (kind === "refusal_loss") return { type: "refusal" as const, closerId, meetingId };
  if (kind === "paid_on_call_alert") return { type: "alert" as const, closerId, meetingId, graceEndsAt: CALL_SLOT_ENDED_AT + 7200_000 };
  return {
    type: "task" as const, purpose: kind, closerId, meetingId, contactMethod: "call" as const,
    reminderScheduledAt: FIXTURE_NOW + 86_400_000,
    ...(kind === "payment_owed"
      ? { expectedAmountMinor: 50_000, expectedCurrency: "USD", promisedPaymentAt: FIXTURE_NOW + 2 * 86_400_000 }
      : {}),
  };
}

/** A call decision row as the call rule will store one: ready at ask unless the fields say otherwise. */
export async function seedCallDecision(ctx: MutationCtx, args: CallDecisionFixture) {
  const { kind, closerId, runId, recordingId, ...fields } = args;
  const family = kind === "refusal_loss" ? "refusal" : kind === "paid_on_call_alert" ? "alert" : "task";
  callDecisionFixtureSeq += 1;
  return await ctx.db.insert("resultAutomationDecisions", {
    kind,
    mode: "ask",
    state: "ready",
    inputKey: await sha256Hex(stableJson(["fixture-call", kind, args.meetingId, callDecisionFixtureSeq])),
    vetoKey: await sha256Hex(stableJson(["call", recordingId, args.opportunityId, family])),
    ruleVersion: CALL_RULE_FIXTURE_VERSION,
    policyVersion: 1,
    activationVersion: 1,
    humanResultRevision: 0,
    wouldWrite: true,
    gates: [],
    runId,
    recordingId,
    assignedCloserId: closerId,
    noticeUserId: closerId,
    confirmRoute: "meeting",
    proposal: callProposalFixture(kind, closerId, args.meetingId),
    evidence: callEvidenceRef({ runId, recordingId }),
    createdAt: FIXTURE_NOW,
    ...fields,
  });
}

/** A certificate sample row. Collecting, for the payment win rule, unless the fields say otherwise. */
export async function seedAutomationSample(
  ctx: MutationCtx,
  args: { tenantId: Id<"tenants"> } & Partial<Omit<Doc<"automationSamples">, "_id" | "_creationTime" | "tenantId">>,
) {
  return await ctx.db.insert("automationSamples", {
    kind: "payment_win",
    ruleVersion: PAYMENT_RULE_VERSION,
    target: 300,
    status: "collecting",
    createdAt: FIXTURE_NOW,
    ...args,
  });
}

/** A kind at automatic as promoteKind will write it, with its certificate pointer. */
export async function setKindAutomatic(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    adminId: Id<"users">;
    kind: "payment_win" | "additional_payment";
    sampleId?: Id<"automationSamples">;
    ruleVersion?: string;
    breaker?: boolean;
  },
) {
  await setPaymentFixtureModes(ctx, { tenantId: args.tenantId, adminId: args.adminId });
  const settings = (await ctx.db.get("tenants", args.tenantId))!.resultAutomation!;
  const policy = settings.kinds[args.kind];
  await ctx.db.patch("tenants", args.tenantId, {
    resultAutomation: {
      ...settings,
      kinds: {
        ...settings.kinds,
        [args.kind]: {
          ...policy,
          mode: "automatic",
          ...(args.sampleId ? {
            automatic: {
              promotedAt: FIXTURE_NOW, promotedByUserId: args.adminId, sampleId: args.sampleId,
              ruleVersion: args.ruleVersion ?? PAYMENT_RULE_VERSION, writes: 0,
            },
          } : {}),
          ...(args.breaker ? { breaker: { trippedAt: FIXTURE_NOW, reason: "wrong_write" as const } } : {}),
        },
      },
    },
  });
}

/** A booked deal with a scheduled call, its matched recording and a published run on it. */
export async function automationCallFixture(options?: Parameters<typeof providerPaymentFixture>[0]) {
  const fixture = await providerPaymentFixture(options);
  const { t, tenantId, dealId, closerId, adminId } = fixture;
  const ids = await t.run(async (ctx) => {
    const meetingId = await insertProviderMeeting(ctx, {
      tenantId, opportunityId: dealId!, closerId, scheduledAt: CALL_SLOT_ENDED_AT - 1800_000,
    });
    const recordingId = await seedReadablePaymentRecording(ctx, { tenantId, meetingId, closerId, ownerId: adminId });
    const runId = await seedCallRun(ctx, { tenantId, meetingId, recordingId });
    return { meetingId, recordingId, runId };
  });
  return { ...fixture, opportunityId: dealId!, ...ids };
}

// ─── Automatic writes (phase 3, package D2) ─────────────────────────────
// Imports for the helpers below; ES modules hoist them.
import type { TestConvex } from "convex-test";
import { CERTIFICATE_TARGET as d2CertificateTarget } from "../convex/automation/certificates";
import type d2Schema from "../convex/schema";

type D2Kind = keyof typeof d2CertificateTarget;

/**
 * A certified sample of the kind's full target of distinct people, and the
 * tenant's kind promoted to automatic on it, as `promoteKind` leaves it. The
 * tenant must already have its automation settings. Members are written in
 * pages, so the sample is real for invariants A6 to A8.
 */
export async function seedAutomaticCertificate(
  t: TestConvex<typeof d2Schema>,
  args: {
    tenantId: Id<"tenants">;
    promotedByUserId: Id<"users">;
    kind: D2Kind;
    ruleVersion: string;
    scopeBindingIds?: Id<"paymentProviderBindings">[];
    now?: number;
  },
): Promise<Id<"automationSamples">> {
  const { tenantId, kind, ruleVersion } = args;
  const now = args.now ?? FIXTURE_NOW;
  const target = d2CertificateTarget[kind];
  const sampleId = await t.run((ctx) => ctx.db.insert("automationSamples", {
    tenantId, kind, ruleVersion, target, status: "certified",
    firstCaseAt: now - 30 * 86_400_000, fullAt: now - 2 * 86_400_000, certifiedAt: now - 86_400_000,
    scopeBindingIds: args.scopeBindingIds, createdAt: now - 30 * 86_400_000,
  }));
  for (let offset = 0; offset < target; offset += 100) {
    await t.run(async (ctx) => {
      for (let i = offset; i < Math.min(target, offset + 100); i++) {
        const leadId = await insertProviderPerson(ctx, tenantId, { email: `d2-${kind}-${i}@example.com` });
        await ctx.db.insert("resultAutomationDecisions", {
          tenantId, kind, mode: "shadow", state: "shadow",
          inputKey: await sha256Hex(stableJson(["d2-sample", kind, i])),
          vetoKey: await sha256Hex(stableJson(["d2-sample-veto", kind, i])),
          ruleVersion, policyVersion: 1, activationVersion: 1, humanResultRevision: 0,
          wouldWrite: true, gates: [], leadId, sampleId,
          evidence: { allocationRevision: 0, sourceUpdatedAt: FIXTURE_PAID_AT, bindingIds: [], bindingVersions: [] },
          createdAt: now - 30 * 86_400_000,
        });
      }
    });
  }
  await t.run(async (ctx) => {
    const settings = (await ctx.db.get("tenants", tenantId))?.resultAutomation;
    if (!settings) throw new Error("seedAutomaticCertificate needs the tenant's automation settings");
    const policy = settings.kinds[kind] ?? {
      mode: "off" as const, policyVersion: 0, changedAt: now, changedByUserId: args.promotedByUserId,
    };
    const { breaker: _breaker, ...rest } = policy;
    await ctx.db.patch("tenants", tenantId, {
      resultAutomation: {
        ...settings,
        kinds: {
          ...settings.kinds,
          [kind]: {
            ...rest, mode: "automatic", policyVersion: policy.policyVersion + 1,
            automatic: { promotedAt: now - 1000, promotedByUserId: args.promotedByUserId, sampleId, ruleVersion, writes: 0 },
          },
        },
      },
    });
  });
  return sampleId;
}
