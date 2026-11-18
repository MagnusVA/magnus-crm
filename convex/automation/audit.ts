import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { emitDomainEvent } from "../lib/domainEvents";
import { PERMISSIONS } from "../lib/permissions";
import { sha256Hex } from "../lib/stableHash";
import { automationCommandRefusalValidator, refuseAutomation } from "../payments/commandResult";
import { requireTenantUser } from "../requireTenantUser";
import { holdMapping, oneBusinessDayAfter, tripBreaker } from "./breaker";
import { automationKindOf, isPaymentKind, paymentEvidenceOf, type AutomationKind } from "./proposals";
import { automationKindValidator, wrongFieldValidator } from "./schema";

type Decision = Doc<"resultAutomationDecisions">;
export const CANARY_COUNT = 10;
export const SAMPLE_EVERY = 5;
const SAMPLED_DEADLINE_MS = 7 * 86_400_000;
const AUDIT_READ_LIMIT = 500;
const AUDIT_PAGE_SIZE = 50;
const auditReasonValidator = v.union(v.literal("canary"), v.literal("sampled"));
const auditVerdictValidator = v.union(v.literal("correct"), v.literal("wrong"));

export function auditReasonFor(writesBefore: number, decisionDigest: string): Decision["auditReason"] | null {
  return writesBefore < CANARY_COUNT ? "canary" :
    Number.parseInt(decisionDigest.slice(0, 8), 16) % SAMPLE_EVERY === 0 ? "sampled" : null;
}

/** Call after saving the receipt in the same mutation as the automatic write. */
export async function scheduleAudit(
  ctx: MutationCtx, decision: Pick<Decision, "_id">, now = Date.now(),
): Promise<void> {
  const receipt = await ctx.db.get("resultAutomationDecisions", decision._id);
  const kind = receipt && automationKindOf(receipt.kind);
  if (!kind || receipt.state !== "applied" || receipt.mode !== "automatic") {
    throw new Error("Audit requires an applied automatic receipt");
  }
  if (receipt.auditReason || receipt.auditWrongFields) return;
  const tenant = await ctx.db.get("tenants", receipt.tenantId);
  const settings = tenant?.resultAutomation;
  const policy = settings?.kinds[kind];
  const pointer = policy?.automatic;
  if (!tenant || !settings || !policy || !pointer || pointer.sampleId !== receipt.certificateSampleId ||
      policy.policyVersion !== receipt.policyVersion) {
    throw new Error("Automatic write did not use the active certificate");
  }
  const reason = auditReasonFor(pointer.writes, await sha256Hex(decision._id));
  await ctx.db.patch("tenants", tenant._id, { resultAutomation: {
    ...settings, kinds: { ...settings.kinds, [kind]: { ...policy, automatic: { ...pointer, writes: pointer.writes + 1 } } },
  } });
  await ctx.db.patch("resultAutomationDecisions", decision._id, reason ? {
    auditReason: reason,
    auditOpenDueAt: reason === "canary" ? oneBusinessDayAfter(tenant, now) : now + SAMPLED_DEADLINE_MS,
  } : {
    // A considered write outside the sample has no verdict or deadline. This
    // empty array lets retries distinguish it from a write yet to be counted.
    auditWrongFields: [],
  });
}

function automaticReceipts(ctx: QueryCtx, tenantId: Id<"tenants">) {
  return ctx.db.query("resultAutomationDecisions")
    .withIndex("by_tenantId_and_mode_and_state_and_resolvedAt", (q) =>
      q.eq("tenantId", tenantId).eq("mode", "automatic").eq("state", "applied"))
    .order("desc");
}

export async function readOpenAudits(
  ctx: QueryCtx, tenantId: Id<"tenants">,
): Promise<{ rows: Decision[]; capped: boolean }> {
  // The due index is global. Keep the scorecard scan tenant-scoped and show
  // the cap; the audit queue can page further through this same tenant range.
  const rows = await automaticReceipts(ctx, tenantId).take(AUDIT_READ_LIMIT + 1);
  return {
    rows: rows.slice(0, AUDIT_READ_LIMIT).filter((row) => row.auditOpenDueAt !== undefined),
    capped: rows.length > AUDIT_READ_LIMIT,
  };
}

export const listAuditQueue = query({
  args: { kind: v.optional(automationKindValidator), cursor: v.optional(v.string()) },
  returns: v.object({
    cases: v.array(v.object({
      decisionId: v.id("resultAutomationDecisions"), kind: automationKindValidator,
      reason: auditReasonValidator, dueAt: v.number(), writtenAt: v.number(),
      leadId: v.optional(v.id("leads")), opportunityId: v.optional(v.id("opportunities")),
      meetingId: v.optional(v.id("meetings")), providerPaymentId: v.optional(v.id("providerPayments")),
    })), capped: v.boolean(), nextCursor: v.union(v.null(), v.string()),
  }),
  handler: async (ctx, { kind, cursor }) => {
    const { tenantId } = await requireTenantUser(ctx, [...PERMISSIONS["result-automation:grade"]]);
    const page = await automaticReceipts(ctx, tenantId).paginate({
      cursor: cursor ?? null, numItems: AUDIT_PAGE_SIZE, maximumRowsRead: AUDIT_PAGE_SIZE, maximumBytesRead: 256 * 1024,
    });
    const cases = page.page.flatMap((row) => {
      const auditKind = automationKindOf(row.kind);
      if (!auditKind || (kind && kind !== auditKind) || !row.auditReason || row.auditOpenDueAt === undefined) return [];
      return [{
        decisionId: row._id, kind: auditKind, reason: row.auditReason, dueAt: row.auditOpenDueAt,
        writtenAt: row.resolvedAt ?? row.createdAt, leadId: row.leadId, opportunityId: row.opportunityId,
        meetingId: row.meetingId, providerPaymentId: row.providerPaymentId,
      }];
    });
    return {
      cases: cases.sort((a, b) => a.dueAt - b.dueAt),
      capped: !page.isDone, nextCursor: page.isDone ? null : page.continueCursor,
    };
  },
});

export const recordAudit = mutation({
  args: { decisionId: v.id("resultAutomationDecisions"), verdict: auditVerdictValidator, wrongFields: v.array(wrongFieldValidator) },
  returns: v.union(automationCommandRefusalValidator, v.object({ ok: v.literal(true), alreadyApplied: v.boolean() })),
  handler: async (ctx, { decisionId, verdict, wrongFields }) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [...PERMISSIONS["result-automation:grade"]]);
    const row = await ctx.db.get("resultAutomationDecisions", decisionId);
    const kind = row && automationKindOf(row.kind);
    if (row?.tenantId !== tenantId || !kind || !row.auditReason || row.mode !== "automatic") {
      return refuseAutomation("not_ready");
    }
    if (wrongFields.length > wrongFieldValidator.members.length || (verdict === "correct") !== (wrongFields.length === 0)) {
      return refuseAutomation("needs_review");
    }
    const fields = [...new Set(wrongFields)].sort();
    if (row.auditVerdict === verdict && fields.join() === row.auditWrongFields?.join()) {
      return { ok: true as const, alreadyApplied: true };
    }
    if (row.state !== "applied" || row.auditOpenDueAt === undefined || row.auditVerdict) return refuseAutomation("not_ready");
    const now = Date.now();
    const severe = fields.some((field) =>
      field === "person" || field === "deal" || field === "false_loss" || field === "should_abstain");
    if (severe) await tripBreaker(ctx, tenantId, kind, "wrong_write", decisionId);
    else if (now >= row.auditOpenDueAt) await tripBreaker(ctx, tenantId, kind, "audit_overdue", decisionId);
    if (isPaymentKind(kind) && fields.some((field) => field === "amount" || field === "type" || field === "program")) {
      const ids = paymentEvidenceOf(row)?.bindingIds ?? [];
      if (ids.length <= 4) {
        for (const id of ids) {
          const binding = await ctx.db.get("paymentProviderBindings", id);
          if ((binding?.kind === "product_program" && (fields.includes("amount") || fields.includes("program"))) ||
              (binding?.kind === "variant_type" && fields.includes("type"))) await holdMapping(ctx, id, decisionId);
        }
      }
    }
    await ctx.db.patch("resultAutomationDecisions", decisionId, {
      auditOpenDueAt: undefined, auditedAt: now, auditByUserId: userId, auditVerdict: verdict, auditWrongFields: fields,
    });
    await emitDomainEvent(ctx, {
      tenantId, entityType: row.opportunityId ? "opportunity" : "user", entityId: row.opportunityId ?? userId,
      actorUserId: userId, source: "admin", occurredAt: now, eventType: "automation.audit_recorded",
      metadata: { decisionId, kind, verdict, wrongFields: fields },
    });
    return { ok: true as const, alreadyApplied: false };
  },
});

export async function tripOverdueAudit(ctx: MutationCtx, decision: Decision, now: number): Promise<void> {
  const kind: AutomationKind | null = automationKindOf(decision.kind);
  if (kind && decision.mode === "automatic" && decision.state === "applied" &&
      decision.auditOpenDueAt !== undefined && decision.auditOpenDueAt <= now) {
    await tripBreaker(ctx, decision.tenantId, kind, "audit_overdue", decision._id);
  }
}
