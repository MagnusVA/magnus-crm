import type { QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { createLiveReadState, readLiveQueryRows } from "../lib/liveQueryBounds";
import { toRecordingView } from "./recordings";
export async function buildFathomSettings(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
) {
  const c = await ctx.db
    .query("tenantFathomConnections")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
    .unique();
  const state = createLiveReadState();
  const members = await readLiveQueryRows(
    ctx.db
      .query("fathomOrgMembers")
      .withIndex("by_tenantId_and_email", (q) => q.eq("tenantId", tenantId)),
    200,
    state,
  );
  const users = await readLiveQueryRows(
    ctx.db
      .query("users")
      .withIndex("by_tenantId_and_isActive", (q) =>
        q.eq("tenantId", tenantId).eq("isActive", true),
      ),
    200,
    state,
  );
  const unmatched = await readLiveQueryRows(
    ctx.db
      .query("callRecordings")
      .withIndex("by_tenantId_and_matchStatus_and_createdAt", (q) =>
        q.eq("tenantId", tenantId).eq("matchStatus", "unmatched"),
      )
      .order("desc"),
    50,
    state,
  );
  const warnings = [...(c?.healthWarnings ?? [])];
  if (c?.connectionStatus === "connected") {
    if (!c.keyHolderIsAccountAdmin)
      warnings.push(
        "This key cannot inspect account permissions. Confirm its seat can view the Sales team and external calls are shared with User's Team, with the full lock.",
      );
    else
      warnings.push(
        "Confirm the key holder can view the Sales team. Fathom does not identify the key holder in its roster response.",
      );
    if (members.rows.some((m) => !m.ignored && !m.matchedUserId))
      warnings.push(
        "Unlinked members' recordings wait up to 7 days, then are deleted. Link each sales recorder under Members.",
      );
  }
  return {
    connection: c
      ? {
          status: c.connectionStatus,
          keyLast4: c.keyLast4,
          lastWebhookAt: c.lastWebhookAt,
          lastReconciledAt: c.lastReconciledAt,
          lastError: c.lastError,
          accountAdmin: c.keyHolderIsAccountAdmin,
          droppedCount: c.droppedCount ?? 0,
          importing: Boolean(c.reconcileToken),
        }
      : null,
    members: members.rows.map((m) => ({
      memberId: m._id,
      email: m.email,
      name: m.name,
      userId: m.matchedUserId,
      ignored: m.ignored,
      viewAccessLevel: m.viewAccessLevel,
    })),
    users: users.rows.map((u) => ({
      userId: u._id,
      label: u.fullName ?? u.email,
    })),
    unmatched: unmatched.rows.map(toRecordingView),
    warnings,
    capped: state.capped,
  };
}
