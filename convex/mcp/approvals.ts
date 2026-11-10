import { v } from "convex/values";
import type { Doc, Id } from "./../_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { requireTenantUser, type TenantUserResult } from "../requireTenantUser";
import { hasPermission } from "../lib/permissions";
import { rejectRequest } from "../lib/observability/errors";
import { FAMILY_LABELS, type WriteFamily } from "./families";
import { accessChangedAt, writeFamiliesFor } from "./guard";
import { committerFor } from "./admin/committers";
import { applyPrepared } from "./admin/prepare";

/**
 * Plans an admin's assistant prepared, approved by a person in Magnus
 * (docs/plans/admin-assistant.md §4). The page runs under the web session, so
 * `canApprove` repeats every check the MCP gate makes for a caller, and both
 * the page's query and the approve button use it.
 */

type Verdict =
  | { ok: true; row: Doc<"mcpConfirmations"> }
  | { ok: false; code: string; message: string; row: Doc<"mcpConfirmations"> | null };

async function canApprove(
  ctx: QueryCtx | MutationCtx,
  me: TenantUserResult,
  planId: Id<"mcpConfirmations">,
): Promise<Verdict> {
  // 1. Not found: missing, another workspace's, or not a plan (closer and
  //    chat tokens live in the same table).
  const row = await ctx.db.get("mcpConfirmations", planId);
  if (!row || row.tenantId !== me.tenantId || row.kind !== "plan") {
    return { ok: false, code: "plan.not_found", message: "Magnus can't find that plan.", row: null };
  }
  // 2. The approver, checked as the MCP gate checks a caller.
  const [user, tenant] = await Promise.all([
    ctx.db.get("users", me.userId),
    ctx.db.get("tenants", me.tenantId),
  ]);
  const family = row.family as WriteFamily;
  const committer = committerFor(row.tool);
  const deny = (code: string, message: string): Verdict => ({ ok: false, code, message, row });
  if (!user || user.deletedAt !== undefined || !user.isActive || !tenant) {
    return deny("plan.approver_inactive", "Your account can't approve changes.");
  }
  if (row.userId !== me.userId && me.role !== "tenant_master") {
    return deny("plan.not_yours", "Only the admin who prepared this, or the owner, can approve it.");
  }
  if (!(tenant.mcpAccess?.roles ?? []).includes(me.role)) {
    return deny("plan.read_off", "AI assistants are switched off for your role, so this plan can't be applied.");
  }
  if (!writeFamiliesFor(user, tenant).includes(family)) {
    return deny("plan.family_off", `${FAMILY_LABELS[family] ?? "These"} changes are switched off for assistants.`);
  }
  if (user.mcpBlockedAt !== undefined) {
    return deny("plan.blocked", "Your AI assistant access is blocked.");
  }
  if (committer?.permission && !hasPermission(me.role, committer.permission)) {
    return deny("plan.permission", "Your role can't approve this kind of change.");
  }
  if (committer?.needsBillingOps && !tenant.billingOpsEnabled) {
    return deny("plan.billing_off", "Billing is switched off in this workspace.");
  }
  if (accessChangedAt(user, tenant) > (row.createdAt ?? 0)) {
    return deny("plan.access_changed", "Assistant access changed after this was prepared, so it can't be applied. Ask your assistant to prepare it again.");
  }
  // 3. Already decided: the page shows the stored outcome.
  if (row.usedAt !== undefined) return deny("plan.decided", "This plan has already been decided.");
  // 4. Expiry and the rest.
  if (row.expiresAt < Date.now()) return deny("plan.expired", "This plan expired. Ask your assistant to prepare it again.");
  if (!committer) return deny("plan.unknown", "Magnus doesn't know this kind of change any more.");
  return { ok: true, row };
}

const planView = v.object({
  planId: v.id("mcpConfirmations"),
  title: v.string(),
  summary: v.string(),
  columns: v.array(v.string()),
  rows: v.array(v.array(v.string())),
  footnote: v.union(v.string(), v.null()),
  family: v.string(),
  familyLabel: v.string(),
  status: v.string(),
  preparedBy: v.string(),
  agentClient: v.union(v.string(), v.null()),
  createdAt: v.number(),
  expiresAt: v.number(),
  canApprove: v.boolean(),
  reason: v.union(v.string(), v.null()),
  outcome: v.any(),
});

export const getPlan = query({
  args: { planId: v.string() },
  returns: v.union(planView, v.null()),
  handler: async (ctx, { planId }) => {
    const me = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    const id = ctx.db.normalizeId("mcpConfirmations", planId);
    if (!id) return null;
    const verdict = await canApprove(ctx, me, id);
    const row = verdict.row;
    if (!row) return null;
    const plan = JSON.parse(row.planJson ?? "{}") as {
      title?: string;
      summary?: string;
      columns?: string[];
      rows?: string[][];
      footnote?: string | null;
    };
    const preparer = await ctx.db.get("users", row.userId);
    const family = row.family as WriteFamily;
    return {
      planId: row._id,
      title: plan.title ?? "A prepared change",
      summary: plan.summary ?? "",
      columns: plan.columns ?? [],
      rows: plan.rows ?? [],
      footnote: plan.footnote ?? null,
      family,
      familyLabel: FAMILY_LABELS[family] ?? family,
      status: row.status ?? (row.usedAt ? "applied" : "waiting"),
      preparedBy: preparer?.fullName ?? preparer?.email ?? "An admin",
      agentClient: row.agentClient ?? null,
      createdAt: row.createdAt ?? row._creationTime,
      expiresAt: row.expiresAt,
      canApprove: verdict.ok,
      reason: verdict.ok ? null : verdict.message,
      outcome: row.resultJson ? JSON.parse(row.resultJson) : null,
    };
  },
});

export const approvePlan = mutation({
  args: { planId: v.id("mcpConfirmations") },
  returns: v.any(),
  handler: async (ctx, { planId }) => {
    const me = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    const verdict = await canApprove(ctx, me, planId);
    if (!verdict.ok) {
      // A second click on Approve returns the first outcome and applies nothing.
      if (verdict.code === "plan.decided" && verdict.row?.resultJson) {
        return { ...JSON.parse(verdict.row.resultJson), replay: true };
      }
      throw rejectRequest(verdict.code, verdict.message);
    }
    const committer = committerFor(verdict.row.tool)!;
    return await applyPrepared(
      ctx,
      { userId: me.userId, tenantId: me.tenantId, role: me.role, agentClient: verdict.row.agentClient ?? "unknown" },
      verdict.row,
      committer,
      { approvedByUserId: me.userId, approvedVia: "web" },
    );
  },
});

export const declinePlan = mutation({
  args: { planId: v.id("mcpConfirmations") },
  returns: v.null(),
  handler: async (ctx, { planId }) => {
    const me = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    const row = await ctx.db.get("mcpConfirmations", planId);
    if (!row || row.tenantId !== me.tenantId || row.kind !== "plan") {
      throw rejectRequest("plan.not_found", "Magnus can't find that plan.");
    }
    if (row.userId !== me.userId && me.role !== "tenant_master") {
      throw rejectRequest("plan.not_yours", "Only the admin who prepared this, or the owner, can decline it.");
    }
    if (row.usedAt !== undefined) return null;
    const now = Date.now();
    await ctx.db.patch("mcpConfirmations", planId, {
      usedAt: now,
      status: "declined",
      resultJson: JSON.stringify({ status: "declined", written: 0 }),
      approvedByUserId: me.userId,
      approvedVia: "web",
      keepUntil: now + 365 * 24 * 60 * 60 * 1000,
    });
    return null;
  },
});
