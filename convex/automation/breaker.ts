import { v, type Infer } from "convex/values";
import { businessDateForInstant, businessDayRange } from "../../lib/businessDay";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, type MutationCtx, type QueryCtx } from "../_generated/server";
import { emitDomainEvent } from "../lib/domainEvents";
import { PERMISSIONS } from "../lib/permissions";
import { automationCommandRefusalValidator, refuseAutomation } from "../payments/commandResult";
import { requireTenantUser } from "../requireTenantUser";
import { CERTIFICATE_TARGET, CASE_MAX_AGE_MS, closeCollectingSample } from "./certificates";
import { isPaymentKind, paymentEvidenceOf, type AutomationKind } from "./proposals";
import { automationKindValidator, breakerReasonValidator } from "./schema";
import { currentRuleVersion, effectiveKindMode, stopBreakerNotices } from "./settings";

type ReadCtx = QueryCtx | MutationCtx;
type Decision = Doc<"resultAutomationDecisions">;
type Tenant = Doc<"tenants">;
type Connection = Doc<"tenantPaymentConnections">;
type BindingId = Id<"paymentProviderBindings">;
export type BreakerReason = Infer<typeof breakerReasonValidator>;

export const WHOP_FRESH_MS = 60 * 60_000;
const paymentKinds = ["payment_win", "additional_payment"] as const;

export function oneBusinessDayAfter(tenant: Tenant, time: number): number {
  // Same elapsed business-day duration as the Whop closer-to-Billing handoff.
  const date = businessDateForInstant(time, tenant.businessDay);
  const { start, end } = businessDayRange(date, tenant.businessDay);
  return time + (end - start);
}

export function whopIsFresh(connection: Connection | null, now: number): boolean {
  return connection?.status === "connected" && connection.lastSuccessfulSweepAt !== undefined &&
    connection.lastSuccessfulSweepAt >= now - WHOP_FRESH_MS;
}

export async function whopIsLagging(ctx: ReadCtx, tenantId: Id<"tenants">, now: number): Promise<boolean> {
  const connections = await Promise.all((["live", "sandbox"] as const).map((environment) =>
    ctx.db.query("tenantPaymentConnections")
      .withIndex("by_tenantId_and_provider_and_environment", (q) =>
        q.eq("tenantId", tenantId).eq("provider", "whop").eq("environment", environment))
      .unique()));
  const active = connections.filter((connection) => connection && connection.status !== "disconnected");
  return active.length === 0 || active.some((connection) => !whopIsFresh(connection, now));
}

/** Read the certificate in force. Its sample was checked in full by promoteKind. */
export async function promotedCertificate(ctx: ReadCtx, tenant: Tenant, kind: AutomationKind) {
  const pointer = tenant.resultAutomation?.kinds[kind]?.automatic;
  if (!pointer || pointer.ruleVersion !== currentRuleVersion(tenant, kind)) return null;
  const sample = await ctx.db.get("automationSamples", pointer.sampleId);
  if (sample?.tenantId !== tenant._id || sample.kind !== kind || sample.ruleVersion !== pointer.ruleVersion ||
      sample.status !== "certified" || sample.target !== CERTIFICATE_TARGET[kind] ||
      sample.certifiedAt === undefined || sample.certifiedAt > pointer.promotedAt ||
      sample.firstCaseAt === undefined || sample.firstCaseAt < pointer.promotedAt - CASE_MAX_AGE_MS) return null;
  return sample;
}

/** Scope covers product and variant mappings. The executor revalidates the deal bindings. */
export async function mappingBlockReason(
  ctx: ReadCtx, payment: Pick<Doc<"providerPayments">, "tenantId" | "connectionId">,
  evidence: Pick<NonNullable<ReturnType<typeof paymentEvidenceOf>>, "bindingIds" | "bindingVersions">,
  scopeBindingIds: readonly BindingId[],
): Promise<"out_of_scope" | "mapping_held" | null> {
  const { bindingIds, bindingVersions } = evidence;
  if (bindingIds.length > 4 || bindingIds.length !== bindingVersions.length) return "out_of_scope";
  const rows = await Promise.all(bindingIds.map((id) => ctx.db.get("paymentProviderBindings", id)));
  let hasProduct = false;
  let hasVariant = false;
  for (const [i, row] of rows.entries()) {
    if (row?.tenantId !== payment.tenantId || row.connectionId !== payment.connectionId) return "out_of_scope";
    if (row.automaticHeldAt !== undefined) return "mapping_held";
    if (row.kind !== "product_program" && row.kind !== "variant_type") continue;
    if (!row.enabled || row.version !== bindingVersions[i] || !scopeBindingIds.includes(row._id)) return "out_of_scope";
    hasProduct ||= row.kind === "product_program";
    hasVariant ||= row.kind === "variant_type";
  }
  return hasProduct && hasVariant ? null : "out_of_scope";
}

type AutomaticRefusal = {
  ok: false;
  code: "kind_off" | "certificate_required" | "certificate_lapsed";
  gate: "kind_off" | "certificate_required" | "certificate_lapsed" | "out_of_scope" | "mapping_held" | "whop_stale";
};

export type AutomaticAllowance = { ok: true; sampleId: Id<"automationSamples"> } | AutomaticRefusal;

/** Call inside the same mutation that will write the result, using its current decision row. */
export async function assertAutomaticAllowed(
  ctx: MutationCtx, { tenantId, kind, decision }: { tenantId: Id<"tenants">; kind: AutomationKind; decision: Decision },
  now = Date.now(),
): Promise<AutomaticAllowance> {
  const tenant = await ctx.db.get("tenants", tenantId);
  const policy = tenant?.resultAutomation?.kinds[kind];
  if (!tenant || tenant.status !== "active" || !tenant.resultAutomation?.enabled || policy?.mode !== "automatic" ||
      decision.tenantId !== tenantId || decision.kind !== kind || decision.mode !== "automatic" || !decision.wouldWrite) {
    return { ok: false, code: "kind_off", gate: "kind_off" };
  }
  if (!policy.automatic) return { ok: false, code: "certificate_required", gate: "certificate_required" };
  const sample = await promotedCertificate(ctx, tenant, kind);
  if (!sample || decision.ruleVersion !== sample.ruleVersion) {
    return { ok: false, code: "certificate_lapsed", gate: "certificate_lapsed" };
  }
  if (effectiveKindMode(tenant, kind) !== "automatic" || decision.policyVersion !== policy.policyVersion ||
      decision.activationVersion !== tenant.resultAutomation.activationVersion) {
    return { ok: false, code: "kind_off", gate: "kind_off" };
  }
  if (isPaymentKind(kind)) {
    if (await unansweredNotMySale(ctx, tenant, now)) return { ok: false, code: "kind_off", gate: "kind_off" };
    const payment = decision.providerPaymentId && await ctx.db.get("providerPayments", decision.providerPaymentId);
    const evidence = paymentEvidenceOf(decision);
    if (!payment || payment.tenantId !== tenantId || !evidence) {
      return { ok: false, code: "certificate_required", gate: "out_of_scope" };
    }
    const reason = await mappingBlockReason(ctx, payment, evidence, sample.scopeBindingIds ?? []);
    if (reason) return { ok: false, code: "certificate_required", gate: reason };
    const connection = await ctx.db.get("tenantPaymentConnections", payment.connectionId);
    if (connection?.tenantId !== tenantId || !whopIsFresh(connection, now)) {
      return { ok: false, code: "kind_off", gate: "whop_stale" };
    }
  }
  return { ok: true, sampleId: sample._id };
}

export async function tripBreaker(
  ctx: MutationCtx, tenantId: Id<"tenants">, kind: AutomationKind, reason: BreakerReason,
  decisionId?: Id<"resultAutomationDecisions">,
): Promise<void> {
  const tenant = await ctx.db.get("tenants", tenantId);
  const settings = tenant?.resultAutomation;
  const policy = settings?.kinds[kind];
  if (!settings || !policy || policy.breaker || (!policy.automatic && reason !== "not_my_sale_unanswered")) return;
  const now = Date.now();
  const policyVersion = policy.policyVersion + 1;
  await closeCollectingSample(ctx, tenantId, kind, now);
  await ctx.db.patch("tenants", tenantId, {
    resultAutomation: { ...settings, kinds: { ...settings.kinds, [kind]: {
      ...policy, policyVersion, breaker: { trippedAt: now, reason, decisionId },
    } } },
  });
  if (kind === "refusal_loss") {
    await stopBreakerNotices(ctx, tenantId, now, policyVersion, reason === "certificate_lapsed" ? reason : "breaker");
  }
  await emitDomainEvent(ctx, {
    tenantId, entityType: "user", entityId: policy.automatic?.promotedByUserId ?? policy.changedByUserId, source: "system", occurredAt: now,
    eventType: "automation.breaker_tripped", metadata: { kind, reason, decisionId },
  });
}

export async function holdMapping(
  ctx: MutationCtx, bindingId: BindingId, decisionId: Id<"resultAutomationDecisions">,
): Promise<void> {
  const [binding, decision] = await Promise.all([
    ctx.db.get("paymentProviderBindings", bindingId), ctx.db.get("resultAutomationDecisions", decisionId),
  ]);
  if (!binding || binding.automaticHeldAt !== undefined || decision?.tenantId !== binding.tenantId ||
      (binding.kind !== "product_program" && binding.kind !== "variant_type") ||
      !paymentEvidenceOf(decision)?.bindingIds.includes(bindingId)) return;
  await ctx.db.patch("paymentProviderBindings", bindingId, {
    automaticHeldAt: Date.now(), automaticHeldDecisionId: decisionId,
  });
}

export async function unansweredNotMySale(ctx: ReadCtx, tenant: Tenant, now: number): Promise<boolean> {
  const flag = await ctx.db.query("providerPayments")
    .withIndex("by_tenantId_and_notMySaleAt", (q) => q.eq("tenantId", tenant._id).gt("notMySaleAt", undefined))
    .first();
  return flag?.notMySaleAt !== undefined && now >= oneBusinessDayAfter(tenant, flag.notMySaleAt);
}

export async function checkTenantBreakers(ctx: MutationCtx, tenant: Tenant, now: number): Promise<void> {
  const settings = tenant.resultAutomation;
  if (!settings) return;
  for (const { value: kind } of automationKindValidator.members) {
    const policy = settings.kinds[kind];
    if (policy?.mode === "automatic" && !policy.breaker &&
        policy.automatic?.ruleVersion !== currentRuleVersion(tenant, kind)) {
      await tripBreaker(ctx, tenant._id, kind, "certificate_lapsed");
    }
  }
  if (!paymentKinds.some((kind) => settings.kinds[kind].mode === "automatic" && !settings.kinds[kind].breaker)) return;
  if (await unansweredNotMySale(ctx, tenant, now)) {
    for (const kind of paymentKinds) await tripBreaker(ctx, tenant._id, kind, "not_my_sale_unanswered");
  }
}

export async function breakerCauseOpen(ctx: ReadCtx, tenant: Tenant, kind: AutomationKind, now: number): Promise<boolean> {
  if (isPaymentKind(kind) && await unansweredNotMySale(ctx, tenant, now)) return true;
  const breaker = tenant.resultAutomation?.kinds[kind]?.breaker;
  if (breaker?.reason !== "audit_overdue" || !breaker.decisionId) return false;
  const audit = await ctx.db.get("resultAutomationDecisions", breaker.decisionId);
  return audit?.tenantId === tenant._id && audit.auditOpenDueAt !== undefined && audit.auditOpenDueAt <= now;
}

export const resetBreaker = mutation({
  args: { kind: automationKindValidator },
  returns: v.union(automationCommandRefusalValidator, v.object({ ok: v.literal(true), alreadyApplied: v.boolean() })),
  handler: async (ctx, { kind }) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [...PERMISSIONS["result-automation:raise"]]);
    const tenant = await ctx.db.get("tenants", tenantId);
    const settings = tenant?.resultAutomation;
    const policy = settings?.kinds[kind];
    if (!tenant || !settings || !policy?.automatic) return refuseAutomation("certificate_required");
    if (!await promotedCertificate(ctx, tenant, kind)) return refuseAutomation("certificate_lapsed");
    if (!policy.breaker) return { ok: true as const, alreadyApplied: true };
    const now = Date.now();
    if (await breakerCauseOpen(ctx, tenant, kind, now)) return refuseAutomation("needs_review");
    const stamp = { changedAt: now, changedByUserId: userId };
    const { breaker: _breaker, ...rest } = policy;
    await closeCollectingSample(ctx, tenantId, kind, now);
    await ctx.db.patch("tenants", tenantId, { resultAutomation: {
      ...settings, ...stamp, kinds: { ...settings.kinds, [kind]: { ...rest, ...stamp, policyVersion: policy.policyVersion + 1 } },
    } });
    return { ok: true as const, alreadyApplied: false };
  },
});
