import { v } from "convex/values";
import type { Doc } from "../../../_generated/dataModel";
import { internalQuery, type QueryCtx } from "../../../_generated/server";
import { mcpCallerValidator, requireMcpAdmin, loadInTenant } from "../../guard";
import { formatLocal } from "../../time";
import {
  type Admin,
  text,
  textValidator,
  notFound,
  partialReason,
} from "./common";
import { appLink, approvalPath } from "../prepare";
import { expectedError } from "../../../lib/observability/errors";

export const activityArgs = {
  since: v.optional(v.string()),
  userId: v.optional(v.id("users")),
  tool: v.optional(v.string()),
  planId: v.optional(v.id("mcpConfirmations")),
  cursor: v.optional(v.string()),
};
const receiptValidator = v.object({
  id: v.id("mcpConfirmations"),
  time: v.string(),
  admin: v.object({ userId: v.id("users"), name: textValidator }),
  tool: v.string(),
  status: v.union(
    v.literal("applied"),
    v.literal("stale"),
    v.literal("refused"),
    v.literal("declined"),
    v.literal("waiting"),
  ),
  target: textValidator,
  summary: textValidator,
  approver: v.union(
    v.null(),
    v.object({ userId: v.id("users"), name: textValidator }),
  ),
  agentClient: v.union(v.string(), v.null()),
  outcome: v.optional(v.any()),
  outcomeIsPartial: v.optional(v.boolean()),
  allowedActions: v.array(v.string()),
  openInMagnus: v.string(),
});
function parse(value?: string): unknown {
  try {
    return JSON.parse(value ?? "null");
  } catch {
    return null;
  }
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
/** Outcomes can include pin values. Mark strings as data and remove credentials/contact fields. */
function safeOutcome(
  value: unknown,
  budget: { remaining: number; capped: boolean },
  depth = 0,
  key?: string,
): unknown {
  if (depth > 4 || budget.remaining < 32) {
    budget.capped = true;
    return null;
  }
  if (typeof value === "string") {
    // Keep the receipt's machine state and IDs usable as the stored result.
    // Labels, notes and other free text still carry their origin below.
    if (
      (key === "status" &&
        [
          "applied",
          "stale",
          "refused",
          "declined",
          "waiting",
          "queued",
        ].includes(value)) ||
      (key?.endsWith("Id") && /^[a-zA-Z0-9_-]{16,80}$/.test(value))
    ) {
      budget.remaining -= value.length + 2;
      return value;
    }
    const result = text(
      value,
      "admin",
      Math.min(300, Math.max(0, budget.remaining - 64)),
    );
    budget.remaining -= new TextEncoder().encode(
      JSON.stringify(result),
    ).byteLength;
    budget.capped ||= result.text.length < value.length;
    return result;
  }
  if (Array.isArray(value)) {
    budget.remaining -= 2;
    const result: unknown[] = [];
    for (const child of value.slice(0, 25)) {
      if (budget.remaining < 32) {
        budget.capped = true;
        break;
      }
      result.push(safeOutcome(child, budget, depth + 1));
      budget.remaining--;
    }
    budget.capped ||= result.length < value.length;
    return result;
  }
  if (value && typeof value === "object") {
    budget.remaining -= 2;
    const result: Record<string, unknown> = {};
    const entries = Object.entries(value).filter(
      ([key]) =>
        !/token|secret|email|phone|proof|receipturl|referencecode|error/i.test(
          key,
        ),
    );
    for (const [key, child] of entries.slice(0, 25)) {
      const keyBytes =
        new TextEncoder().encode(JSON.stringify(key)).byteLength + 2;
      if (budget.remaining < keyBytes + 32) {
        budget.capped = true;
        break;
      }
      budget.remaining -= keyBytes;
      result[key] = safeOutcome(child, budget, depth + 1, key);
    }
    budget.capped ||= Object.keys(result).length < entries.length;
    return result;
  }
  budget.remaining -= String(value ?? null).length;
  return value ?? null;
}

async function receipt(
  ctx: QueryCtx,
  me: Admin,
  row: Doc<"mcpConfirmations">,
  outcome: boolean,
) {
  const admin = await ctx.db.get("users", row.userId),
    approver = row.approvedByUserId
      ? await ctx.db.get("users", row.approvedByUserId)
      : null;
  const echo = object(parse(row.echoJson)),
    target = object(echo.target);
  const budget = { remaining: 4000, capped: false },
    result = outcome ? safeOutcome(parse(row.resultJson), budget) : null;
  return {
    id: row._id,
    time: formatLocal(
      row.usedAt ?? row.createdAt ?? row._creationTime,
      me.timeZone,
    ),
    admin: {
      userId: row.userId,
      name: text(
        admin?.tenantId === me.tenantId
          ? (admin.fullName ?? "Unnamed admin")
          : "Removed admin",
        "admin",
        80,
      ),
    },
    tool: row.tool,
    status:
      row.status ?? (row.usedAt ? ("applied" as const) : ("waiting" as const)),
    target: text(
      typeof target.label === "string" ? target.label : "Record",
      "admin",
      120,
    ),
    summary: text(
      typeof echo.summary === "string" ? echo.summary : "",
      "admin",
      200,
    ),
    approver:
      approver?.tenantId === me.tenantId
        ? {
            userId: approver._id,
            name: text(approver.fullName ?? "Unnamed approver", "admin", 80),
          }
        : null,
    agentClient: row.agentClient ?? null,
    ...(outcome ? { outcome: result, outcomeIsPartial: budget.capped } : {}),
    allowedActions: ["magnus_assistant_activity"],
    openInMagnus:
      row.kind === "plan"
        ? appLink(approvalPath(row._id))
        : appLink("/workspace/settings"),
  };
}
export const run = internalQuery({
  args: { caller: mcpCallerValidator, ...activityArgs },
  returns: v.object({
    items: v.array(receiptValidator),
    cursor: v.union(v.string(), v.null()),
    isPartial: v.boolean(),
    reason: v.union(v.string(), v.null()),
    timeZone: v.string(),
  }),
  handler: async (ctx, { caller, since, userId, tool, planId, cursor }) => {
    const me = await requireMcpAdmin(ctx, caller);
    if (userId) await loadInTenant(ctx, me, "users", userId);
    const sinceMs = since === undefined ? undefined : Date.parse(since);
    if (sinceMs !== undefined && !Number.isFinite(sinceMs))
      throw expectedError(
        "mcp.invalid_since",
        "Use an ISO date or timestamp for since.",
      );
    if (planId) {
      const row = await loadInTenant(ctx, me, "mcpConfirmations", planId);
      if (row.kind !== "plan") notFound();
      const item = await receipt(ctx, me, row, true);
      return {
        items: [item],
        cursor: null,
        isPartial: item.outcomeIsPartial ?? false,
        reason: item.outcomeIsPartial
          ? "The outcome reached the answer-size limit. Open its approval page for the full outcome."
          : null,
        timeZone: me.timeZone,
      };
    }
    const waiting = () =>
      ctx.db
        .query("mcpConfirmations")
        .withIndex("by_tenantId_and_kind_and_status", (q) =>
          q
            .eq("tenantId", me.tenantId)
            .eq("kind", "plan")
            .eq("status", "waiting"),
        );
    const selected = cursor ? parse(cursor) : null;
    if (cursor && selected === null)
      throw expectedError(
        "mcp.invalid_cursor",
        "Use the cursor returned by this tool.",
      );
    const c =
      selected === null
        ? {
            phase: (await waiting().first()) ? "waiting" : "receipts",
            cursor: null,
          }
        : object(selected);
    if (
      !(c.phase === "waiting" || c.phase === "receipts") ||
      !(c.cursor === null || typeof c.cursor === "string")
    )
      throw expectedError(
        "mcp.invalid_cursor",
        "Use the cursor returned by this tool.",
      );
    const source =
      c.phase === "waiting"
        ? waiting()
        : ctx.db
            .query("mcpConfirmations")
            .withIndex("by_tenantId_and_usedAt", (q) =>
              sinceMs === undefined
                ? q.eq("tenantId", me.tenantId).gt("usedAt", undefined)
                : q.eq("tenantId", me.tenantId).gte("usedAt", sinceMs),
            )
            .order("desc");
    const page = await source.paginate({
      cursor: c.cursor,
      numItems: 10,
      maximumRowsRead: 50,
      maximumBytesRead: 200_000,
    });
    const rows = page.page.filter(
      (r) =>
        r.kind &&
        (r.usedAt !== undefined ||
          (r.kind === "plan" && r.status === "waiting")) &&
        (!userId || r.userId === userId) &&
        (!tool || r.tool === tool) &&
        (sinceMs === undefined ||
          (r.usedAt ?? r.createdAt ?? r._creationTime) >= sinceMs),
    );
    const isPartial = !page.isDone || c.phase === "waiting";
    const next = isPartial
      ? JSON.stringify({
          phase: page.isDone ? "receipts" : c.phase,
          cursor: page.isDone ? null : page.continueCursor,
        })
      : null;
    return {
      items: await Promise.all(rows.map((r) => receipt(ctx, me, r, false))),
      cursor: next,
      isPartial,
      reason: partialReason(isPartial),
      timeZone: me.timeZone,
    };
  },
});
