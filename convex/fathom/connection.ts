import { buildFathomSettings } from "./connectionCore";
import { v } from "convex/values";
import { z } from "zod";
import {
  action,
  query,
  mutation,
  env,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { requireTenantUser } from "../requireTenantUser";
import { requireTenantUserFromAction } from "../requireTenantUserFromAction";
import { PERMISSIONS } from "../lib/permissions";
import { rejectRequest } from "../lib/observability/errors";
import { log, reportError } from "../lib/observability/log";
import {
  assertCoreRole,
  provenanceMetadata,
  toCheckResult,
  WEB,
  type CheckResult,
  type CoreActor,
  type Provenance,
} from "../lib/outcomeCores";
import { fathomFetch, rosterPage, rosterFields } from "./client";
import { recordingView } from "./recordings";

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
    return await buildFathomSettings(ctx, actor.tenantId);
  },
});
export type LinkMemberArgs = {
  memberId: Id<"fathomOrgMembers">;
  userId?: Id<"users">;
  ignored?: boolean;
};

/** Every check `linkMember` makes, in its order, with no write. */
async function checkLinkMember(
  ctx: QueryCtx | MutationCtx,
  actor: CoreActor,
  a: LinkMemberArgs,
) {
  assertCoreRole(actor, PERMISSIONS["settings:manage"]);
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
  return { member: m };
}

/** Whether `linkMemberCore` would link or ignore this member, without writing. */
export async function checkLinkMemberAllowed(
  ctx: QueryCtx | MutationCtx,
  actor: CoreActor,
  args: LinkMemberArgs,
): Promise<
  CheckResult<{
    memberId: Id<"fathomOrgMembers">;
    currentUserId?: Id<"users">;
    currentlyIgnored: boolean;
  }>
> {
  return await toCheckResult(async () => {
    const { member } = await checkLinkMember(ctx, actor, args);
    return {
      memberId: member._id,
      ...(member.matchedUserId ? { currentUserId: member.matchedUserId } : {}),
      currentlyIgnored: member.ignored,
    };
  });
}

/**
 * Links a Fathom member to a team member, or marks them ignored, and
 * retries the recordings held for them: the core of `linkMember`. No event
 * covers a link, so an agent's is logged with its provenance.
 */
export async function linkMemberCore(
  ctx: MutationCtx,
  actor: CoreActor,
  a: LinkMemberArgs,
  provenance: Provenance,
): Promise<null> {
  const { member: m } = await checkLinkMember(ctx, actor, a);
  await ctx.db.patch("fathomOrgMembers", m._id, {
    matchedUserId: a.ignored ? undefined : a.userId,
    ignored: a.ignored ?? false,
  });
  await ctx.scheduler.runAfter(0, internal.fathom.processor.retryHeld, {
    tenantId: actor.tenantId,
    cursor: null,
  });
  if (provenance.via === "mcp") {
    log.info("fathom.member.linked", {
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      memberId: m._id,
      userId: a.ignored ? undefined : a.userId,
      ignored: a.ignored ?? false,
      ...provenanceMetadata(provenance),
    });
  }
  return null;
}

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
    return await linkMemberCore(ctx, actor, a, WEB);
  },
});
