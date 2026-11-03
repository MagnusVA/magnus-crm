import { v } from "convex/values";
import { z } from "zod";
import {
  action,
  query,
  mutation,
  env,
  type ActionCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { requireTenantUser } from "../requireTenantUser";
import { requireTenantUserFromAction } from "../requireTenantUserFromAction";
import { PERMISSIONS } from "../lib/permissions";
import { rejectRequest } from "../lib/observability/errors";
import { reportError } from "../lib/observability/log";
import { readLiveQueryRows, createLiveReadState } from "../lib/liveQueryBounds";
import { fathomFetch, rosterPage, rosterFields } from "./client";
import { recordingView, toRecordingView } from "./recordings";

// Trigger values, include flags, response id/secret: https://developers.fathom.ai/api-reference/webhooks/create-a-webhook
const triggeredFor = [
  "my_recordings",
  "my_shared_with_team_recordings",
  "shared_team_recordings",
];
async function connectCore(
  ctx: ActionCtx,
  actor: Awaited<ReturnType<typeof requireTenantUserFromAction>>,
  apiKey: string,
): Promise<null> {
  const key = apiKey.trim();
  if (key.length < 8 || key.length > 1024)
    throw rejectRequest("fathom.invalid_key", "Enter a valid Fathom API key.");
  if (!env.CONVEX_SITE_URL)
    throw new Error("CONVEX_SITE_URL is required for Fathom webhooks");
  const token = crypto.randomUUID();
  const row = await ctx.runMutation(internal.fathom.state.begin, {
    tenantId: actor.tenantId,
    userId: actor.userId,
    token,
  });
  let webhook: { id: string; secret: string } | undefined;
  let finished = false;
  try {
    const teamResponse = await fathomFetch(ctx, row._id, key, "/team_members");
    const members = rosterPage.parse(await teamResponse.json());
    // https://developers.fathom.ai/api-reference/users/list-users-and-their-permissions: 403 is normal for a dedicated non-admin seat.
    const usersResponse = await fathomFetch(
      ctx,
      row._id,
      key,
      "/users",
      {},
      [403],
    );
    const users =
      usersResponse.status === 403
        ? null
        : rosterPage.parse(await usersResponse.json());
    const response = await fathomFetch(ctx, row._id, key, "/webhooks", {
      method: "POST",
      body: JSON.stringify({
        destination_url: `${env.CONVEX_SITE_URL}/webhooks/fathom?c=${row._id}`,
        triggered_for: triggeredFor,
        include_transcript: true,
        include_summary: true,
        include_action_items: true,
        include_crm_matches: true,
      }),
    });
    webhook = z
      .object({ id: z.string(), secret: z.string().startsWith("whsec_") })
      .parse(await response.json());
    await ctx.runMutation(internal.fathom.state.finish, {
      connectionId: row._id,
      token,
      apiKey: key,
      webhookId: webhook.id,
      webhookSecret: webhook.secret,
      triggeredFor,
      accountAdmin: users !== null,
    });
    finished = true;
    if (row.webhookId && row.apiKey)
      await ctx.scheduler.runAfter(
        0,
        internal.fathom.maintenance.deleteWebhook,
        {
          connectionId: row._id,
          apiKey: row.apiKey,
          webhookId: row.webhookId,
          attempt: 0,
        },
      );
    await ctx.runMutation(internal.fathom.state.syncMembers, {
      connectionId: row._id,
      members: rosterFields(members),
      accountAdmin: users !== null,
    });
    if (users)
      await ctx.runMutation(internal.fathom.state.syncMembers, {
        connectionId: row._id,
        members: rosterFields(users),
      });
    // Finish all roster pages using bounded scheduled actions.
    if (members.next_cursor)
      await ctx.scheduler.runAfter(0, internal.fathom.maintenance.syncRoster, {
        connectionId: row._id,
        kind: "team_members",
        cursor: members.next_cursor,
      });
    if (users?.next_cursor)
      await ctx.scheduler.runAfter(0, internal.fathom.maintenance.syncRoster, {
        connectionId: row._id,
        kind: "users",
        cursor: users.next_cursor,
      });
  } catch (error) {
    if (!finished) {
      if (webhook)
        await fathomFetch(
          ctx,
          row._id,
          key,
          `/webhooks/${encodeURIComponent(webhook.id)}`,
          { method: "DELETE" },
          [404],
        ).catch(() =>
          reportError(
            "fathom.webhook.cleanup_failed",
            new Error("Fathom provisional webhook cleanup failed"),
            { connectionId: row._id, integration: "fathom" },
          ),
        );
      await ctx.runMutation(internal.fathom.state.finish, {
        connectionId: row._id,
        token,
      });
    }
    if (error instanceof z.ZodError)
      throw new Error("Fathom response format changed");
    throw error;
  }

  return null;
}
export const connect = action({
  args: { apiKey: v.string() },
  returns: v.null(),
  handler: async (ctx, a) => {
    const actor = await requireTenantUserFromAction(ctx, [
      ...PERMISSIONS["settings:manage"],
    ]);
    return connectCore(ctx, actor, a.apiKey);
  },
});
export const replaceKey = action({
  args: { apiKey: v.string() },
  returns: v.null(),
  handler: async (ctx, a) => {
    const actor = await requireTenantUserFromAction(ctx, [
      ...PERMISSIONS["settings:manage"],
    ]);
    return connectCore(ctx, actor, a.apiKey);
  },
});
export const disconnect = action({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const actor = await requireTenantUserFromAction(ctx, [
      ...PERMISSIONS["settings:manage"],
    ]);
    const token = crypto.randomUUID();
    const c = await ctx.runMutation(internal.fathom.state.begin, {
      tenantId: actor.tenantId,
      userId: actor.userId,
      token,
    });
    try {
      // Delete endpoint and 204/404: https://developers.fathom.ai/api-reference/webhooks/delete-a-webhook
      if (c.webhookId && c.apiKey)
        await fathomFetch(
          ctx,
          c._id,
          c.apiKey,
          `/webhooks/${encodeURIComponent(c.webhookId)}`,
          { method: "DELETE" },
          [404],
        );
      await ctx.runMutation(internal.fathom.state.finish, {
        connectionId: c._id,
        token,
        disconnected: true,
      });
    } catch (error) {
      await ctx.runMutation(internal.fathom.state.finish, {
        connectionId: c._id,
        token,
      });
      throw error;
    }
    return null;
  },
});
export const importLast30Days = action({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const actor = await requireTenantUserFromAction(ctx, [
      ...PERMISSIONS["settings:manage"],
    ]);
    const c = await ctx.runQuery(internal.fathom.state.byTenant, {
      tenantId: actor.tenantId,
    });
    if (!c || c.connectionStatus !== "connected")
      throw rejectRequest("fathom.not_connected", "Connect Fathom first.");
    await ctx.runMutation(internal.fathom.maintenance.startReconcile, {
      connectionId: c._id,
      since: Date.now() - 30 * 86400_000,
    });
    return null;
  },
});
export const settings = query({
  args: {},
  returns: v.object({
    connection: v.union(
      v.null(),
      v.object({
        status: v.string(),
        keyLast4: v.string(),
        lastWebhookAt: v.optional(v.number()),
        lastReconciledAt: v.optional(v.number()),
        lastError: v.optional(v.string()),
        accountAdmin: v.optional(v.boolean()),
        droppedCount: v.number(),
        importing: v.boolean(),
      }),
    ),
    members: v.array(
      v.object({
        memberId: v.id("fathomOrgMembers"),
        email: v.string(),
        name: v.optional(v.string()),
        userId: v.optional(v.id("users")),
        ignored: v.boolean(),
        viewAccessLevel: v.optional(v.string()),
      }),
    ),
    users: v.array(v.object({ userId: v.id("users"), label: v.string() })),
    unmatched: v.array(recordingView),
    warnings: v.array(v.string()),
    capped: v.boolean(),
  }),
  handler: async (ctx) => {
    const actor = await requireTenantUser(ctx, [
      ...PERMISSIONS["settings:manage"],
    ]);
    const c = await ctx.db
      .query("tenantFathomConnections")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", actor.tenantId))
      .unique();
    const state = createLiveReadState();
    const members = await readLiveQueryRows(
      ctx.db
        .query("fathomOrgMembers")
        .withIndex("by_tenantId_and_email", (q) =>
          q.eq("tenantId", actor.tenantId),
        ),
      200,
      state,
    );
    const users = await readLiveQueryRows(
      ctx.db
        .query("users")
        .withIndex("by_tenantId_and_isActive", (q) =>
          q.eq("tenantId", actor.tenantId).eq("isActive", true),
        ),
      200,
      state,
    );
    const unmatched = await readLiveQueryRows(
      ctx.db
        .query("callRecordings")
        .withIndex("by_tenantId_and_matchStatus_and_createdAt", (q) =>
          q.eq("tenantId", actor.tenantId).eq("matchStatus", "unmatched"),
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
          "Unlinked members' recordings wait up to 7 days. Link each sales recorder below.",
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
  },
});
export const linkMember = mutation({
  args: {
    memberId: v.id("fathomOrgMembers"),
    userId: v.optional(v.id("users")),
    ignored: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    const actor = await requireTenantUser(ctx, [
      ...PERMISSIONS["settings:manage"],
    ]);
    const m = await ctx.db.get("fathomOrgMembers", a.memberId);
    if (!m || m.tenantId !== actor.tenantId)
      throw rejectRequest(
        "fathom.member_not_found",
        "Fathom member not found.",
      );
    if (a.userId) {
      const user = await ctx.db.get("users", a.userId);
      if (!user?.isActive || user.tenantId !== actor.tenantId)
        throw rejectRequest(
          "fathom.invalid_user",
          "Choose an active member of this tenant.",
        );
    }
    await ctx.db.patch("fathomOrgMembers", m._id, {
      matchedUserId: a.ignored ? undefined : a.userId,
      ignored: a.ignored ?? false,
    });
    await ctx.scheduler.runAfter(0, internal.fathom.processor.retryHeld, {
      tenantId: actor.tenantId,
      cursor: null,
    });
    return null;
  },
});
