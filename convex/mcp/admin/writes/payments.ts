import { v } from "convex/values";
import type { Doc, Id } from "../../../_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "../../../_generated/server";
import {
  checkCorrectPaymentAllowed,
  checkMarkReviewedAllowed,
  correctPaymentCore,
  describeCorrectionEffects,
  markReviewedCore,
} from "../../../billing/mutations";
import { correctPaymentArgsValidator } from "../../../billing/validators";
import { formatAmountMinor as formatMoney } from "../../../../lib/format-currency";
import { toAmountMinor } from "../../../lib/formatMoney";
import { rejectRequest } from "../../../lib/observability/errors";
import type { CheckResult } from "../../../lib/outcomeCores";
import { sha256Hex } from "../../confirm";
import { mcpCallerValidator, requireMcpAdmin, loadInTenant } from "../../guard";
import { appLink, preparePlan, prepareSingle, type AdminActor, type Committer, type Pins } from "../prepare";
import { actorOf, asAgentError, ok } from "./common";

/** Payment changes (docs/plans/admin-assistant.md §2: tools 7 and 12). */

const money = (p: Doc<"paymentRecords">) => formatMoney(p.amountMinor, p.currency);
const TYPE_LABEL: Record<string, string> = { pif: "paid in full", split: "split", monthly: "monthly", deposit: "deposit" };

async function paymentPins(ctx: QueryCtx | MutationCtx, actor: AdminActor, id: Id<"paymentRecords">): Promise<Pins> {
  const p = await ctx.db.get("paymentRecords", id);
  if (!p || p.tenantId !== actor.tenantId) return { [`payment:${id}`]: "missing" };
  return {
    [`payment:${id}.status`]: p.status,
    [`payment:${id}.amountMinor`]: p.amountMinor,
    [`payment:${id}.currency`]: p.currency,
    [`payment:${id}.paymentType`]: p.paymentType,
    [`payment:${id}.programId`]: p.programId,
    [`payment:${id}.proofFileId`]: p.proofFileId ?? null,
    [`payment:${id}.proofReused`]: p.proofReused ?? false,
    [`payment:${id}.verifiedAt`]: p.verifiedAt ?? null,
    // Hashed, so a receipt never keeps the text itself.
    [`payment:${id}.referenceCode`]: p.referenceCode === undefined ? null : await sha256Hex(p.referenceCode),
    [`payment:${id}.note`]: p.note === undefined ? null : await sha256Hex(p.note),
  };
}

// ── magnus_correct_payment ──────────────────────────────────────────────

type CorrectArgs = {
  paymentRecordId: Id<"paymentRecords">;
  amount?: number;
  paymentType?: Doc<"paymentRecords">["paymentType"];
  programId?: Id<"tenantPrograms">;
  referenceCode?: string;
  note?: string;
  reason: string;
};

export const correctPaymentCommitter: Committer<CorrectArgs> = {
  tool: "magnus_correct_payment",
  family: "payments",
  kind: "single",
  permission: "billing:correct",
  needsBillingOps: true,
  pins: async (ctx, actor, args) => ({
    ...(await paymentPins(ctx, actor, args.paymentRecordId)),
    // What the correction does to enrollments and review, frozen at preview.
    // A refusal here (say, the payment became disputed) is a changed pin, so
    // the commit returns stale instead of failing.
    effects: await describeCorrectionEffects(ctx, actor, args).then(
      (lines) => lines.join(" · "),
      (error: unknown) => `refused: ${error instanceof Error ? error.message : "unknown"}`,
    ),
  }),
  check: (ctx, actor, args) => checkCorrectPaymentAllowed(ctx, actor, args) as Promise<CheckResult<object>>,
  apply: async (ctx, actor, args, provenance) => {
    const out = await asAgentError(() => correctPaymentCore(ctx as MutationCtx, actor, args, provenance));
    return { payment: out };
  },
};

export const correctPaymentArgs = { caller: mcpCallerValidator, ...correctPaymentArgsValidator };

export const prepareCorrectPayment = internalMutation({
  args: correctPaymentArgs,
  returns: v.any(),
  handler: async (ctx, { caller, ...args }) => {
    const me = await requireMcpAdmin(ctx, caller, { family: "payments", permission: "billing:correct" });
    if (!me.tenant.billingOpsEnabled) throw rejectRequest("billing.off", "Billing is switched off in this workspace.");
    const payment = await loadInTenant(ctx, me, "paymentRecords", args.paymentRecordId, "that payment");
    if (!args.reason.trim() || args.reason.trim().split(/\s+/).length < 2) {
      throw rejectRequest("correction.reason_required", "A correction needs a reason of a few words. Ask why.");
    }
    const actor = actorOf(me);
    const lead = payment.opportunityId
      ? await ctx.db.get("opportunities", payment.opportunityId).then((d) => (d ? ctx.db.get("leads", d.leadId) : null))
      : null;
    const who = lead?.fullName ?? "this person";
    // The core's own plan decides what changes, with its refusals as the
    // admin's to read.
    const planned = await checkCorrectPaymentAllowed(ctx, actor, args);
    if (!planned.ok) throw rejectRequest(planned.code, planned.message);
    if (!planned.changed) throw rejectRequest("correction.nothing", "That matches the payment already. Nothing to correct.");
    const keys = new Set<string>(planned.changedKeys);
    const changes: string[] = [];
    if (keys.has("amountMinor") && args.amount !== undefined)
      changes.push(`amount ${money(payment)} → ${formatMoney(toAmountMinor(args.amount), payment.currency)}`);
    if (keys.has("paymentType") && args.paymentType)
      changes.push(`type ${TYPE_LABEL[payment.paymentType] ?? payment.paymentType} → ${TYPE_LABEL[args.paymentType] ?? args.paymentType}`);
    if (keys.has("programId") && args.programId) {
      const program = await ctx.db.get("tenantPrograms", args.programId);
      changes.push(`program ${payment.programName} → ${program?.name ?? "another program"}`);
    }
    if (keys.has("referenceCode")) changes.push("reference code updated");
    if (keys.has("note")) changes.push("note updated");
    const effects = await asAgentError(() => describeCorrectionEffects(ctx, actor, args));
    const summary = `${who} · ${money(payment)} · ${changes.join(" · ")}`;
    return await prepareSingle(ctx, actor, correctPaymentCommitter, args, {
      action: "correct_payment",
      target: { kind: "payment", id: payment._id, label: `${who} · ${money(payment)}` },
      summary,
      preview: {
        payment: { person: { text: who, by: "person" }, amount: money(payment), recorded: payment.status },
        changes,
        alsoChanges: effects,
        reason: args.reason.trim(),
        openInMagnus: appLink(`/workspace/billing/${payment._id}`),
      },
    });
  },
});

// ── magnus_review_payments (a plan) ─────────────────────────────────────

type ReviewArgs = { paymentRecordIds: Id<"paymentRecords">[] };

/** Why a payment can't go in a review plan, or null when it can. */
function exclusion(p: Doc<"paymentRecords">, actorUserId: Id<"users">): string | null {
  if (p.status === "disputed") return "disputed";
  if (p.status !== "recorded") return "already reviewed";
  if (!p.proofFileId) return "no receipt";
  if (p.proofReused) return "receipt matches another payment";
  if (p.recordedByUserId === actorUserId) return "logged by you";
  return null;
}

export const reviewPaymentsCommitter: Committer<ReviewArgs> = {
  tool: "magnus_review_payments",
  family: "payments",
  kind: "plan",
  permission: "billing:review",
  needsBillingOps: true,
  pins: async (ctx, actor, args) => {
    const pins: Pins = {};
    for (const id of args.paymentRecordIds) Object.assign(pins, await paymentPins(ctx, actor, id));
    return pins;
  },
  // Runs with the approver: what excludes a payment for the preparer
  // excludes it for whoever approves.
  check: async (ctx, actor, args) => {
    for (const id of args.paymentRecordIds) {
      const p = await ctx.db.get("paymentRecords", id);
      if (!p || p.tenantId !== actor.tenantId) return { ok: false, code: "review.missing", message: "A payment in this plan no longer exists." };
      const why = exclusion(p, actor.userId);
      if (why) return { ok: false, code: "review.excluded", message: `A payment in this plan can't be reviewed this way: ${why}.` };
      const c = await checkMarkReviewedAllowed(ctx, actor, { paymentRecordId: id });
      if (!c.ok) return c;
    }
    return ok;
  },
  apply: async (ctx, actor, args, provenance) => {
    for (const id of args.paymentRecordIds) {
      await asAgentError(() => markReviewedCore(ctx, actor, { paymentRecordId: id }, provenance));
    }
    return { reviewed: args.paymentRecordIds.length };
  },
  size: (args) => args.paymentRecordIds.length,
};

export const reviewPaymentsArgs = { caller: mcpCallerValidator, paymentRecordIds: v.array(v.id("paymentRecords")) };

export const prepareReviewPayments = internalMutation({
  args: reviewPaymentsArgs,
  returns: v.any(),
  handler: async (ctx, { caller, paymentRecordIds }) => {
    const me = await requireMcpAdmin(ctx, caller, { family: "payments", permission: "billing:review" });
    if (!me.tenant.billingOpsEnabled) throw rejectRequest("billing.off", "Billing is switched off in this workspace.");
    const ids = [...new Set(paymentRecordIds)];
    if (ids.length < 1 || ids.length > 20) {
      throw rejectRequest("review.size", "Name between 1 and 20 payments, by ID from magnus_queue.");
    }
    const included: Doc<"paymentRecords">[] = [];
    const excluded: Array<{ paymentRecordId: Id<"paymentRecords">; why: string }> = [];
    for (const id of ids) {
      const p = await loadInTenant(ctx, me, "paymentRecords", id, "that payment");
      const why = exclusion(p, me.userId);
      if (why) excluded.push({ paymentRecordId: id, why });
      else included.push(p);
    }
    if (!included.length) {
      throw rejectRequest("review.none", "None of these can be reviewed in a batch. Open each one in Billing.");
    }
    const rows: string[][] = [];
    let total = 0;
    const currencies = new Set<string>();
    for (const p of included) {
      const deal = p.opportunityId ? await ctx.db.get("opportunities", p.opportunityId) : null;
      const lead = deal ? await ctx.db.get("leads", deal.leadId) : null;
      const closer = p.attributedCloserId ? await ctx.db.get("users", p.attributedCloserId) : null;
      rows.push([
        lead?.fullName ?? "Unknown",
        money(p),
        TYPE_LABEL[p.paymentType] ?? p.paymentType,
        closer?.fullName ?? "",
        `/workspace/billing/${p._id}`,
      ]);
      total += p.amountMinor;
      currencies.add(p.currency);
    }
    const totalText = currencies.size === 1 ? formatMoney(total, [...currencies][0]) : `${included.length} payments`;
    const actor = actorOf(me);
    return await preparePlan(ctx, actor, reviewPaymentsCommitter, { paymentRecordIds: included.map((p) => p._id) }, {
      title: `Mark ${included.length} ${included.length === 1 ? "payment" : "payments"} reviewed`,
      summary: `${included.length} ${included.length === 1 ? "payment" : "payments"} · ${totalText}`,
      target: { kind: "payments", id: included.map((p) => p._id).join(","), label: `${included.length} payments` },
      columns: ["Person", "Amount", "Type", "Closer", "Receipt"],
      rows,
      footnote: excluded.length ? `Left out: ${excluded.map((e) => e.why).join(", ")}` : undefined,
      preview: {
        payments: included.map((p, i) => ({ paymentRecordId: p._id, person: { text: rows[i][0], by: "person" }, amount: rows[i][1] })),
        excluded,
        total: totalText,
      },
    });
  },
});
