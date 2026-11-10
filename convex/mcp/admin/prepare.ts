import type { Doc, Id } from "../../_generated/dataModel";
import { env, type MutationCtx, type QueryCtx } from "../../_generated/server";
import type { Permission } from "../../lib/permissions";
import { rejectRequest } from "../../lib/observability/errors";
import type { CheckResult, CoreActor, Provenance } from "../../lib/outcomeCores";
import { randomToken, sha256Hex, stableJson } from "../confirm";
import type { WriteFamily } from "../families";
import { mcpRateLimiter } from "../gateway";

/**
 * Prepare, then apply (docs/plans/admin-assistant.md §4). Every admin change
 * goes through here:
 *
 * - A tool's prepare step runs the core's own checks, reads the field values
 *   the change depends on (its pins), stores the normalized arguments and the
 *   pins on an `mcpConfirmations` row, and returns a preview. Nothing in the
 *   CRM changes.
 * - A single change is applied by `magnus_commit`, which takes the token and
 *   a readable echo of the change. A plan is approved on a Magnus page.
 * - Either way `applyPrepared` reads the pins again in the same transaction,
 *   writes nothing if one changed, runs the core's checks again, then calls
 *   the same core as the web. Every outcome is kept as a receipt for a year.
 */

export const SINGLE_TTL_MS = 10 * 60 * 1000;
export const PLAN_TTL_MS = 24 * 60 * 60 * 1000;
export const RECEIPT_KEEP_MS = 365 * 24 * 60 * 60 * 1000;

/** Field values a change depends on, as plain values a person can read. */
export type Pins = Record<string, string | number | boolean | null>;

export type Target = { kind: string; id: string; label: string };

/** What `magnus_commit` must repeat, so the client's prompt reads as a sentence. */
export type Echo = { action: string; target: Target; summary: string };

/** The actor a core runs as: the admin who commits, or the admin who approves. */
export type AdminActor = CoreActor & { agentClient: string };

export type Committer<A> = {
  /** The prepare tool's name; also the receipt's `tool`. */
  tool: string;
  family: WriteFamily;
  kind: "single" | "plan";
  /** Who may apply it, besides the family switch. */
  permission?: Permission;
  /** Billing changes also need the tenant's Billing switch. */
  needsBillingOps?: boolean;
  /** Field values the change depends on, read now. */
  pins: (ctx: QueryCtx | MutationCtx, actor: AdminActor, args: A) => Promise<Pins>;
  /** The core's own refusals, returned as a value. */
  check?: (ctx: QueryCtx | MutationCtx, actor: AdminActor, args: A) => Promise<CheckResult<object>>;
  /** Writes through the web's core. Returns what the agent reads. */
  apply: (
    ctx: MutationCtx,
    actor: AdminActor,
    args: A,
    provenance: Provenance,
  ) => Promise<Record<string, unknown>>;
  /** How many records the change touches, for the daily cap. */
  size?: (args: A) => number;
};

export function appLink(path: string): string {
  const base = (env.APP_URL ?? env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "");
  return base ? `${base}${path}` : path;
}

export function approvalPath(planId: Id<"mcpConfirmations">): string {
  return `/workspace/assistant/approvals/${planId}`;
}

function refuse(result: { ok: false; code: string; message: string }): never {
  throw rejectRequest(result.code, result.message);
}

/** A single change: preview plus a ready-made commit object for `magnus_commit`. */
export async function prepareSingle<A>(
  ctx: MutationCtx,
  actor: AdminActor,
  committer: Committer<A>,
  args: A,
  view: { action: string; target: Target; summary: string; preview: Record<string, unknown> },
) {
  if (committer.check) {
    const check = await committer.check(ctx, actor, args);
    if (!check.ok) refuse(check);
  }
  const pins = await committer.pins(ctx, actor, args);
  const token = randomToken();
  const now = Date.now();
  const echo: Echo = { action: view.action, target: view.target, summary: view.summary };
  await ctx.db.insert("mcpConfirmations", {
    tenantId: actor.tenantId,
    userId: actor.userId,
    tool: committer.tool,
    tokenHash: await sha256Hex(token),
    argsHash: await sha256Hex(stableJson(args)),
    preview: JSON.stringify(view.preview),
    expiresAt: now + SINGLE_TTL_MS,
    kind: "single",
    family: committer.family,
    createdAt: now,
    argsJson: JSON.stringify(args),
    echoJson: JSON.stringify(echo),
    pinsJson: JSON.stringify(pins),
    status: "waiting",
    agentClient: actor.agentClient,
  });
  return {
    preview: view.preview,
    commit: { confirmToken: token, ...echo },
    expiresInSeconds: SINGLE_TTL_MS / 1000,
    note: "Nothing has changed yet. Read the preview to the admin, and only after a clear yes pass `commit` to magnus_commit unchanged.",
  };
}

/** A plan: stored rows, approved by a person on a Magnus page. */
export async function preparePlan<A>(
  ctx: MutationCtx,
  actor: AdminActor,
  committer: Committer<A>,
  args: A,
  view: {
    title: string;
    summary: string;
    target: Target;
    columns: string[];
    rows: string[][];
    footnote?: string;
    preview: Record<string, unknown>;
    expiresAt?: number;
  },
) {
  if (committer.check) {
    const check = await committer.check(ctx, actor, args);
    if (!check.ok) refuse(check);
  }
  const pins = await committer.pins(ctx, actor, args);
  const now = Date.now();
  const expiresAt = Math.min(view.expiresAt ?? now + PLAN_TTL_MS, now + PLAN_TTL_MS);
  const echo: Echo = { action: committer.tool, target: view.target, summary: view.summary };
  const planId = await ctx.db.insert("mcpConfirmations", {
    tenantId: actor.tenantId,
    userId: actor.userId,
    tool: committer.tool,
    // A plan has no chat token; this value never leaves the server.
    tokenHash: await sha256Hex(randomToken()),
    argsHash: await sha256Hex(stableJson(args)),
    preview: JSON.stringify(view.preview),
    expiresAt,
    kind: "plan",
    family: committer.family,
    createdAt: now,
    argsJson: JSON.stringify(args),
    echoJson: JSON.stringify(echo),
    pinsJson: JSON.stringify(pins),
    planJson: JSON.stringify({
      title: view.title,
      summary: view.summary,
      columns: view.columns,
      rows: view.rows,
      footnote: view.footnote ?? null,
    }),
    status: "waiting",
    agentClient: actor.agentClient,
  });
  return {
    planId,
    status: "waiting_for_approval" as const,
    preview: view.preview,
    approvalUrl: appLink(approvalPath(planId)),
    expiresAt: new Date(expiresAt).toISOString(),
    note: "Nothing has changed. Give the admin the approvalUrl; a person approves this in Magnus. Then read the outcome with magnus_assistant_activity and this planId.",
  };
}

export type ApplyOutcome =
  | { status: "applied"; receiptId: Id<"mcpConfirmations">; [key: string]: unknown }
  | { status: "stale"; written: 0; changed: Array<{ field: string; was: unknown; now: unknown }> }
  | { status: "refused"; written: 0; code: string; message: string };

async function finish(
  ctx: MutationCtx,
  row: Doc<"mcpConfirmations">,
  status: "applied" | "stale" | "refused",
  result: unknown,
  approval?: { approvedByUserId: Id<"users">; approvedVia: string },
) {
  const now = Date.now();
  await ctx.db.patch("mcpConfirmations", row._id, {
    usedAt: now,
    status,
    resultJson: JSON.stringify(result ?? null),
    keepUntil: now + RECEIPT_KEEP_MS,
    ...(approval ?? {}),
  });
}

/** Records a refusal that happened before the core ran, as a receipt. */
export async function refusePrepared(
  ctx: MutationCtx,
  row: Doc<"mcpConfirmations">,
  code: string,
  message: string,
): Promise<ApplyOutcome> {
  const result = { status: "refused" as const, written: 0 as const, code, message };
  await finish(ctx, row, "refused", result);
  return result;
}

/**
 * Applies a prepared change for `actor`: pins, checks, the daily cap, then
 * the core. The caller has already checked access and the token or approval.
 */
export async function applyPrepared<A>(
  ctx: MutationCtx,
  actor: AdminActor,
  row: Doc<"mcpConfirmations">,
  committer: Committer<A>,
  approval?: { approvedByUserId: Id<"users">; approvedVia: string },
): Promise<ApplyOutcome> {
  const args = JSON.parse(row.argsJson ?? "null") as A;
  const before = JSON.parse(row.pinsJson ?? "{}") as Pins;
  const now = await committer.pins(ctx, actor, args);
  const keys = new Set([...Object.keys(before), ...Object.keys(now)]);
  const changed = [...keys]
    .filter((k) => stableJson(before[k] ?? null) !== stableJson(now[k] ?? null))
    .map((field) => ({ field, was: before[field] ?? null, now: now[field] ?? null }));
  if (changed.length) {
    const result = { status: "stale" as const, written: 0 as const, changed };
    await finish(ctx, row, "stale", result, approval);
    return result;
  }
  if (committer.check) {
    const check = await committer.check(ctx, actor, args);
    if (!check.ok) {
      const result = { status: "refused" as const, written: 0 as const, code: check.code, message: check.message };
      await finish(ctx, row, "refused", result, approval);
      return result;
    }
  }
  const count = Math.max(1, committer.size ? committer.size(args) : 1);
  const cap = await mcpRateLimiter.limit(ctx, "mcpChangesDaily", { key: actor.tenantId, count });
  if (!cap.ok) {
    const result = {
      status: "refused" as const,
      written: 0 as const,
      code: "mcp.daily_cap",
      message: "Assistants have reached today's limit of changes in this workspace. Make this one in Magnus, or try tomorrow.",
    };
    await finish(ctx, row, "refused", result, approval);
    return result;
  }
  const out = await committer.apply(ctx, actor, args, {
    via: "mcp",
    agentClient: row.agentClient ?? actor.agentClient,
  });
  const result = { status: "applied" as const, receiptId: row._id, ...out };
  await finish(ctx, row, "applied", result, approval);
  return result;
}
