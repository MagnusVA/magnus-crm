import type { Doc, Id, TableNames } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

// The undo log of docs/plans/polluted-lead-split.md §5.6 and §5.9. Each apply
// write records one row in the same transaction, and rollback walks a plan's
// rows newest first.

export type AuditScope = {
  tenantId: Id<"tenants">;
  planId: Id<"leadSplitPlans">;
  personKey: string;
  now: number;
};

/**
 * Steps rollback dispatches on. A `split:<opportunityId>` step created that
 * deal's new opportunity and moved its meetings; `move:<opportunityId>` moved
 * a whole deal to another lead.
 */
export const AUDIT_STEP = {
  lock: "lock",
  lead: "lead",
  identifier: "identifier",
  split: (opportunityId: Id<"opportunities">) => `split:${opportunityId}`,
  move: (opportunityId: Id<"opportunities">) => `move:${opportunityId}`,
  keep: (opportunityId: Id<"opportunities">) => `keep:${opportunityId}`,
  meeting: "meeting",
  slackEvent: "slack_event",
  refresh: "refresh",
  finalize: "finalize",
} as const;

// Convex object fields can't start with "_", so the stored copy drops them;
// the row's `docId` names the document.
function withoutSystemFields(doc: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(doc).filter(([key]) => !key.startsWith("_")));
}

// Convex drops undefined fields, so a cleared field is stored as null to keep
// its name.
function storedPatch(patch: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(patch).map(([key, value]) => [key, value === undefined ? null : value]),
  );
}

export async function recordInsert(
  ctx: MutationCtx,
  scope: AuditScope,
  step: string,
  table: TableNames,
  docId: string,
  after?: Record<string, unknown>,
): Promise<void> {
  await ctx.db.insert("leadSplitAudit", {
    tenantId: scope.tenantId,
    planId: scope.planId,
    personKey: scope.personKey,
    step,
    table,
    docId,
    op: "insert",
    after,
    createdAt: scope.now,
  });
}

/** Records a patch the caller is about to make, or a helper will make. */
export async function recordPatch<T extends TableNames>(
  ctx: MutationCtx,
  scope: AuditScope,
  step: string,
  table: T,
  before: Doc<T>,
  patch: Record<string, unknown>,
): Promise<void> {
  await ctx.db.insert("leadSplitAudit", {
    tenantId: scope.tenantId,
    planId: scope.planId,
    personKey: scope.personKey,
    step,
    table,
    docId: before._id,
    op: "patch",
    before: withoutSystemFields(before),
    after: storedPatch(patch),
    createdAt: scope.now,
  });
}

export async function recordDelete<T extends TableNames>(
  ctx: MutationCtx,
  scope: AuditScope,
  step: string,
  table: T,
  before: Doc<T>,
): Promise<void> {
  await ctx.db.insert("leadSplitAudit", {
    tenantId: scope.tenantId,
    planId: scope.planId,
    personKey: scope.personKey,
    step,
    table,
    docId: before._id,
    op: "delete",
    before: withoutSystemFields(before),
    createdAt: scope.now,
  });
}

/**
 * The fields a recorded patch wrote, with the values they had before. A
 * field the document didn't have comes back as undefined, so a patch with
 * the result clears it.
 */
export function restoredFields(row: Doc<"leadSplitAudit">): Record<string, unknown> {
  const before = (row.before ?? {}) as Record<string, unknown>;
  return Object.fromEntries(Object.keys(row.after ?? {}).map((key) => [key, before[key]]));
}
