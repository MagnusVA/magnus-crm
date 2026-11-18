import type { Doc, Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";
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
