# Phase 5 — Channel Notifications & Stale-Lead Digest

**Goal:** Land the user-visible Slack-side artifacts: a channel-confirmation message that fires every time a lead is qualified, a daily 08:00 ET stale-lead digest (DST-safe), and the **Integrations card** in `/workspace/settings?tab=integrations` where a tenant admin picks the notify and stale-reminder channels. After this phase, every `/qualify-lead` submission posts to a configured channel; tenants whose qualified-pending leads age past 30 days see them in a daily Slack digest.

**Prerequisite:**
- Phase 1 complete: `slackInstallations` table has `notifyChannelId` + `staleReminderChannelId` optional fields (Phase 1 1B); `getValidSlackBotToken` works (1F).
- Phase 2 complete: `requireTenantUserFromAction` exists (1D); the manifest's `chat:write`, `chat:write.public`, `channels:read`, `groups:read` scopes are granted (1H).
- Phase 3 complete: `qualified_pending` opportunity rows exist; the `notify.postConfirmation` stub in `convex/slack/notify.ts` (3D) is the hook this phase fills in.
- Phase 4 complete (or in parallel): the join transition fires `slack_qualified_lead_booked` events that Phase 6 metrics consume — not strictly a Phase 5 dep.

**Runs in PARALLEL with:** Phase 4 (different files, different concerns). Phase 6 starts after Phase 5 because the Integrations card is the obvious surface to add disconnect/reconnect UI; Phase 6 lifecycle work hangs off the same component.

> **Per-tenant manual onboarding starts here.** Once Phase 5 ships, every tenant who installs Slack walks through the channel-picker UI as part of onboarding ([§8.5.1](../slackbot-design.md)). The Integrations card is the canonical surface for ongoing reconnect / channel-change actions.

**Skills to invoke:**
- **`shadcn`** — for the Integrations card and the channel-picker `<Combobox>`. The `Combobox` primitive is already in `components/ui/combobox.tsx` per the codebase survey; the Integrations-card component is new and uses `Card`, `Button`, `Alert`.
- **`frontend-design`** — for the polished Integrations card design (status pill, connect-disconnect choreography, "Awaiting Slack workspace owner approval" empty state, private-channel `/invite @Magnus` banner copy).
- **`web-design-guidelines`** — accessibility audit on the Integrations tab + channel picker. Modal dialogs, focus traps, screen-reader labels for status pill states.
- **`vercel-react-best-practices`** — RSC boundaries: status query is a server component (uses `preloadQuery` + `usePreloadedQuery`); the channel picker is a client component because it uses `useAction` and `useForm`. `next-best-practices` is the supplemental reference if Next.js conventions clash.
- **`workos`** — reference only; the Integrations route is gated by `requireRole(["tenant_master", "tenant_admin"])` which is WorkOS-derived.
- **`convex-migration-helper`** — required for the additive `domainEvents.entityType` widen to include `"slackInstallation"` before Slack installation events are emitted.

**Acceptance Criteria:**
1. Tenant admin navigating to `/workspace/settings?tab=integrations` sees an Integrations card with: status pill (`Connected` / `Disconnected` / `Token expired` / `Action required`), the connected workspace name, configured channels, "Change channels", and "Disconnect"; closer / non-admin users are redirected to `/workspace` per `requireRole`.
2. Clicking "Connect Slack" on the disconnected card hits `/api/slack/start` (Phase 1) and lands on the OAuth flow.
3. Post-OAuth, the URL `?slack=connected&pickChannel=true` opens the channel-picker dialog automatically; the picker offers public + private channels via paginated `conversations.list`.
4. Selecting notify + stale-reminder channels and clicking Save calls `setSlackNotifyChannels`, persists channel IDs/names on `slackInstallations`, and closes the dialog.
5. Selecting a **private** channel renders an inline banner: `"#<name> is private — run /invite @Magnus in that channel after saving."` (The bot cannot self-add to private channels.)
6. Submitting a `/qualify-lead` modal (Phase 3) posts a Block Kit confirmation message to the configured `notifyChannelId` with lead, platform, handle, `<@U…>` attribution, and an "Open in CRM" button.
7. If `chat.postMessage` returns `channel_not_found` or `is_archived`, the handler clears the channel ID, emits `slack.notify.failed` with `entityType: "slackInstallation"` and `metadata.slackErr`, and the Integrations card surfaces a reconfigure banner. Lead/opportunity creation is **not** rolled back.
8. The `slack-stale-qualified-leads-reminder` cron runs hourly (UTC) and gates on `hourInNY === 8`, producing one digest per active tenant with stale leads and skipping tenants with zero stale leads.
9. Digest message lists up to 25 stale leads. If more rows exist, the final block uses non-count copy (`"More qualified leads are waiting — view all in CRM"`) because v1 does not maintain an exact count aggregate.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
5A (channel listing + config mutations) ──┐
                                            ├── 5D (Integrations card)
5B (confirmation chat.postMessage) ─────────┤
                                            └── 5E (channel picker dialog) ──→ 5F (E2E onboarding QA)
5C (stale-lead digest cron) ────────────────┘
```

**Optimal execution:**

1. **5A**, **5B**, **5C** all start in parallel — no inter-dep, separate files.
2. **5D** (Integrations card RSC + status pill) starts once 5A's `getInstallationStatus` query is merged.
3. **5E** (channel picker dialog) starts once 5A's `listInstalledChannels` action + `setSlackNotifyChannels` mutation are merged.
4. **5F** (manual end-to-end onboarding QA) gates on 5D + 5E + 5B at minimum.

**Estimated time:** 7–9 days. Frontend has the longest tail (channel picker dialog with RHF + Zod + private-channel banner + paginated combobox) — budget 3 days. Backend (5A + 5B + 5C) is ~3 days. QA (5F) + product-copy polish ~2 days.

**Phase 3 QA correction:** Do not use `const { WebClient } = await import("@slack/web-api")` inside Convex actions. Convex bundles Node actions as ESM with code splitting, and dynamic named imports from the Slack SDK's CommonJS build can resolve to `undefined` at runtime (`TypeError: ... is not a constructor`). Slack Web API calls in this phase are plain HTTP; use the local `convex/slack/webApi.ts` `fetch` helpers instead. Keep actions in the default Convex runtime unless a dependency truly requires Node built-ins.

---

## Subphases

### 5A — Channel Listing + Configuration Mutations

**Type:** Backend
**Parallelizable:** Yes — independent of 5B, 5C.

**What:** Channel-listing and configuration functions split across Convex function boundaries:
1. `convex/slack/channelsActions.ts:listInstalledChannels` (action) — calls `conversations.list` paginated via `convex/slack/webApi.ts`. Used by the channel picker.
2. `convex/slack/channels.ts:setSlackNotifyChannels` (mutation) — writes `notifyChannelId` + `notifyChannelName` + `staleReminderChannelId` + `staleReminderChannelName` on the installation row.
3. `convex/slack/channels.ts:disconnectSlack` (mutation) — flips status to `uninstalled` and clears local tokens.

Plus `getInstallationStatus` (query) — used by Phase 5D's RSC and Phase 6's metrics card.

**Why:** The channel picker (5E) needs both lookups (`listInstalledChannels`) and writes (`setSlackNotifyChannels`); the Integrations card needs reads (`getInstallationStatus`). The split keeps external Slack HTTP calls out of the query/mutation module while still using Convex's default action runtime.

`disconnectSlack` is **`tenant_master` only** per [§12.2](../slackbot-design.md) — destructive action.

**Where:**
- `convex/slack/channelsActions.ts` (new action module)
- `convex/slack/channels.ts` (new, queries/mutations only)

**How:**

**Step 1: Implement `listInstalledChannels`**

```typescript
// Path: convex/slack/channelsActions.ts
import { v } from "convex/values";
import { action } from "../_generated/server";
import { requireTenantUserFromAction } from "../requireTenantUserFromAction";
import { getValidSlackBotToken } from "./tokens";
import { slackApiGet } from "./webApi";

const CHANNEL_PAGE_LIMIT = 200;
const MAX_PAGES = 10; // 200 × 10 = 2000 channels max — should cover any tenant in v1

export type SlackChannel = {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;            // bot is a member (matters for private channels)
  isArchived: boolean;
};

type ConversationsListChannel = {
  id?: string;
  name?: string;
  is_private?: boolean;
  is_member?: boolean;
  is_archived?: boolean;
};

/**
 * List all public + private channels visible to the bot for the calling tenant.
 *
 * Auth: action — derives tenantId from `ctx.auth.getUserIdentity()`. Frontend
 * calls this via `useAction(api.slack.channelsActions.listInstalledChannels)`.
 *
 * Performance: tier-2 method (~20/min). v1 onboarding hits this once per
 * channel-picker open; well under the cap.
 */
export const listInstalledChannels = action({
  args: {},
  handler: async (ctx): Promise<SlackChannel[]> => {
    const access = await requireTenantUserFromAction(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const token = await getValidSlackBotToken(ctx, access.tenantId);

    const channels: SlackChannel[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      // Per .docs/slack/conversations-list.md
      const r = await slackApiGet<{
        channels?: ConversationsListChannel[];
        response_metadata?: { next_cursor?: string };
      }>("conversations.list", token, {
        types: "public_channel,private_channel",
        limit: CHANNEL_PAGE_LIMIT,
        cursor,
        exclude_archived: false,                 // include archived so the user can see why a former channel disappeared
      });
      if (!r.ok) throw new Error(`Slack conversations.list failed: ${r.error ?? "unknown"}`);

      for (const c of r.channels ?? []) {
        if (!c.id || !c.name) continue;
        channels.push({
          id: c.id,
          name: c.name,
          isPrivate: Boolean(c.is_private),
          isMember: Boolean(c.is_member),
          isArchived: Boolean(c.is_archived),
        });
      }

      cursor = r.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }

    // Sort: non-archived first, then alphabetical.
    channels.sort((a, b) => {
      if (a.isArchived !== b.isArchived) return a.isArchived ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

    console.log("[Slack:Channels] listed", { tenantId: access.tenantId, count: channels.length });
    return channels;
  },
});
```

**Step 2: Implement `setSlackNotifyChannels`**

```typescript
// Path: convex/slack/channels.ts

import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

export const setSlackNotifyChannels = mutation({
  args: {
    notifyChannelId: v.string(),
    notifyChannelName: v.string(),
    staleReminderChannelId: v.string(),
    staleReminderChannelName: v.string(),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const inst = await ctx.db
      .query("slackInstallations")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .first();
    if (!inst) {
      throw new Error("Slack not connected — finish OAuth first");
    }
    if (inst.status !== "active") {
      throw new Error(`Slack integration is ${inst.status} — reconnect first`);
    }

    await ctx.db.patch(inst._id, {
      notifyChannelId: args.notifyChannelId,
      notifyChannelName: args.notifyChannelName,
      staleReminderChannelId: args.staleReminderChannelId,
      staleReminderChannelName: args.staleReminderChannelName,
    });

    console.log("[Slack:Channels] saved", {
      tenantId,
      notify: args.notifyChannelName,
      stale: args.staleReminderChannelName,
    });
  },
});
```

**Step 3: Implement `disconnectSlack` (tenant_master only)**

```typescript
// Path: convex/slack/channels.ts (continues)

export const disconnectSlack = mutation({
  args: {},
  handler: async (ctx) => {
    // Per slackbot-design.md §12.2: destructive action — tenant_master only.
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master"]);

    const inst = await ctx.db
      .query("slackInstallations")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .first();
    if (!inst) return;

    await ctx.db.patch(inst._id, {
      status: "uninstalled",
      uninstalledAt: Date.now(),
      // Clear tokens locally — don't leave them readable in DB once disconnected.
      // v1 does not call Slack's revoke API from CRM disconnect; tenant admins can
      // uninstall in Slack if they want Slack-side removal immediately.
      botAccessToken: "",
      refreshToken: "",
    });

    console.log("[Slack:Channels] disconnected", { tenantId, installationId: inst._id });
  },
});
```

**Step 4: Implement `getInstallationStatus` (read for Integrations card)**

```typescript
// Path: convex/slack/channels.ts (continues)

export type InstallationStatus =
  | { kind: "not_connected" }
  | {
      kind: "connected";
      status: "active" | "token_expired" | "revoked" | "uninstalled";
      teamId: string;
      teamName: string;
      installedAt: number;
      installedByWorkosUserId: string;
      notifyChannelId?: string;
      notifyChannelName?: string;
      staleReminderChannelId?: string;
      staleReminderChannelName?: string;
      lastRefreshedAt?: number;
    };

/**
 * Frontend-safe query for the Integrations card.
 * NEVER returns botAccessToken or refreshToken.
 */
export const getInstallationStatus = query({
  args: {},
  handler: async (ctx): Promise<InstallationStatus> => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const inst = await ctx.db
      .query("slackInstallations")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .first();
    if (!inst) return { kind: "not_connected" };

    return {
      kind: "connected",
      status: inst.status,
      teamId: inst.teamId,
      teamName: inst.teamName,
      installedAt: inst.installedAt,
      installedByWorkosUserId: inst.installedByWorkosUserId,
      notifyChannelId: inst.notifyChannelId,
      notifyChannelName: inst.notifyChannelName,
      staleReminderChannelId: inst.staleReminderChannelId,
      staleReminderChannelName: inst.staleReminderChannelName,
      lastRefreshedAt: inst.lastRefreshedAt,
    };
  },
});
```

**Step 5: Verify**

```bash
pnpm tsc --noEmit
npx convex dev
```

Smoke-test from the dev tenant:

```bash
# Path: terminal — listInstalledChannels via the Convex CLI:
npx convex run slack/channelsActions:listInstalledChannels '{}' --auth-id <dev-admin-id>
# (Adjust per your local CLI auth shim. Alternatively, hit it from the frontend in 5E.)
```

**Key implementation notes:**
- **`listInstalledChannels` is paginated.** Most workspaces have < 200 channels, so usually one page; the loop handles bigger workspaces. The 2000-channel cap is generous but defensive — at that scale, a tenant probably wants a search box, not a full list (deferred).
- **`exclude_archived: false`** — include archived channels so the user can see why a former channel "disappeared." The picker UI grays out archived options.
- **`disconnectSlack` clears tokens locally** so a DB read can't recover them. Slack-side tokens are not actively revoked because we'd need to make that call before clearing — for v1 we accept the trade. v1.1 can add strict revoke if needed.
- **`notifyChannelId` and `staleReminderChannelId` are validated only by `setSlackNotifyChannels`** — we trust the channel ID format because the picker UI gates input. If a tenant typed garbage into a future free-text field, the next `chat.postMessage` would fail with `channel_not_found` and gracefully clear the field per [§14.4](../slackbot-design.md).
- **`getInstallationStatus` never returns tokens.** The discriminated union keeps the type narrow. Frontend code physically cannot access `botAccessToken` from this query.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/slack/channelsActions.ts` | Create | `listInstalledChannels` action |
| `convex/slack/channels.ts` | Create | `setSlackNotifyChannels`, `disconnectSlack`, `getInstallationStatus` |

---

### 5B — Confirmation Message: `notify.postConfirmation`

**Type:** Backend
**Parallelizable:** Yes — independent of 5A, 5C.

**What:** Replace the Phase 3 stub (`convex/slack/notify.ts:postConfirmation`) with the real `chat.postMessage` action. Builds a Block Kit confirmation message and posts it to the configured `notifyChannelId`. Best-effort delivery — failures don't roll back the lead/opportunity creation.

**Why:** Per [§8.2](../slackbot-design.md). Lead/opportunity creation is the source of truth; channel post is an additional signal. Channel-deletion / bot-kicked / rate-limited failures are surfaced via `domainEvents` and the Integrations-page banner, not by retrying the underlying mutation.

**Where:**
- `convex/slack/notify.ts` (modify — replace stub with action using `slackApiPostJson`)
- `convex/slack/notifyData.ts` (new — DB helpers)
- `convex/lib/slackBlockKit.ts` (modify — add `buildQualifiedLeadConfirmation`)

**How:**

**Step 1: Add the Block Kit builder**

```typescript
// Path: convex/lib/slackBlockKit.ts (additions)

import type { KnownBlock } from "@slack/types";
import { SOCIAL_PLATFORM_LABELS, type SocialPlatform } from "./socialPlatform";

export type QualifiedLeadConfirmationArgs = {
  leadFullName: string;
  platform: SocialPlatform;
  handle: string;
  qualifiedBySlackUserId: string;
  appUrl: string;                     // env: APP_URL in Convex
  opportunityId: string;
};

export function buildQualifiedLeadConfirmation(args: QualifiedLeadConfirmationArgs) {
  // Per .docs/slack/chat-post-message.md.
  // Final copy is open per slackbot-design.md §8.2 / Open Q5 — confirm with marketing
  // before Phase 5 ships. Layout below mirrors the design doc structure.
  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "🎯 New Qualified Lead" },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Name:*\n${args.leadFullName}` },
        { type: "mrkdwn", text: `*Platform:*\n${SOCIAL_PLATFORM_LABELS[args.platform]}` },
        { type: "mrkdwn", text: `*Handle:*\n${args.handle}` },
        { type: "mrkdwn", text: `*Qualified by:*\n<@${args.qualifiedBySlackUserId}>` },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open in CRM" },
          url: `${args.appUrl}/workspace/pipeline?opportunity=${args.opportunityId}`,
        },
      ],
    },
  ];

  return {
    text: `${args.leadFullName} was qualified by <@${args.qualifiedBySlackUserId}>`,
    blocks,
  };
}
```

**Step 2: Replace the `postConfirmation` stub**

```typescript
// Path: convex/slack/notify.ts (REPLACE the stub created in 3D)
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { getValidSlackBotToken } from "./tokens";
import { slackApiPostJson } from "./webApi";
import { buildQualifiedLeadConfirmation } from "../lib/slackBlockKit";
import { emitDomainEventInAction } from "../lib/domainEventsAction";  // see Step 4

/**
 * Post a Block Kit confirmation message to the configured notify channel.
 * Called from createQualifiedLead.create (Phase 3D) via scheduler.runAfter(0, …).
 *
 * Best-effort: lead/opportunity creation is the source of truth. Failures
 * here log + emit a domainEvent for ops review; they do NOT roll back.
 */
export const postConfirmation = internalAction({
  args: {
    tenantId: v.id("tenants"),
    opportunityId: v.id("opportunities"),
    leadId: v.id("leads"),
  },
  handler: async (ctx, args) => {
    // Look up everything we need in parallel-ish reads.
    const inst = await ctx.runQuery(internal.slack.installations.byTenantId, {
      tenantId: args.tenantId,
    });
    if (!inst || inst.status !== "active") {
      console.log("[Slack:Notify] skipping — installation not active", {
        tenantId: args.tenantId, status: inst?.status,
      });
      return;
    }
    if (!inst.notifyChannelId) {
      console.log("[Slack:Notify] skipping — no notify channel configured", {
        tenantId: args.tenantId,
      });
      return;
    }

    const opp = await ctx.runQuery(internal.slack.notifyData.getOppForNotify, {
      opportunityId: args.opportunityId,
    });
    if (!opp) {
      console.warn("[Slack:Notify] opp gone before notify", { opportunityId: args.opportunityId });
      return;
    }
    const lead = await ctx.runQuery(internal.slack.notifyData.getLeadForNotify, {
      leadId: args.leadId,
    });
    if (!lead) {
      console.warn("[Slack:Notify] lead gone before notify", { leadId: args.leadId });
      return;
    }
    // Find the primary social handle for the platform we'll display.
    const ident = await ctx.runQuery(internal.slack.notifyData.getPrimarySocialIdentifier, {
      leadId: args.leadId,
    });
    if (!ident || !opp.qualifiedBy) {
      console.warn("[Slack:Notify] missing identifier or qualifiedBy — abort", {
        opportunityId: args.opportunityId,
      });
      return;
    }

    const token = await getValidSlackBotToken(ctx, args.tenantId);

    const message = buildQualifiedLeadConfirmation({
      leadFullName: lead.fullName ?? lead.email ?? "Lead",
      platform: ident.platform,
      handle: ident.rawValue,
      qualifiedBySlackUserId: opp.qualifiedBy.slackUserId,
      appUrl: process.env.APP_URL!,
      opportunityId: args.opportunityId,
    });

    try {
      const r = await slackApiPostJson<{ channel?: string; ts?: string }>(
        "chat.postMessage",
        token,
        {
        channel: inst.notifyChannelId,
        text: message.text,
        blocks: message.blocks,
        },
      );
      if (!r.ok) throw new Error(r.error ?? "unknown");
      console.log("[Slack:Notify] posted", {
        tenantId: args.tenantId, channel: inst.notifyChannelId,
        opportunityId: args.opportunityId,
      });
    } catch (e: unknown) {
      // Map known Slack errors to actionable signals.
      const slackErr = e instanceof Error ? e.message : "unknown";
      console.warn("[Slack:Notify] post failed", {
        tenantId: args.tenantId,
        channel: inst.notifyChannelId,
        slackErr,
      });

      if (slackErr === "channel_not_found" || slackErr === "is_archived") {
        // Channel gone — clear the field so future submissions don't keep failing.
        await ctx.runMutation(internal.slack.notifyData.clearNotifyChannel, {
          installationId: inst._id,
        });
      }

      await emitDomainEventInAction(ctx, {
        tenantId: args.tenantId,
        entityType: "slackInstallation",
        entityId: inst._id,
        eventType: "slack.notify.failed",
        source: "system",
        occurredAt: Date.now(),
        metadata: {
          slackErr,
          channel: inst.notifyChannelId ?? "unknown",
          opportunityId: args.opportunityId,
        },
      });

      // Best-effort: do NOT throw. The opportunity already exists.
    }
  },
});

```

**Step 3: Add DB helpers in a non-Node module**

```typescript
// Path: convex/slack/notifyData.ts

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { SOCIAL_PLATFORMS, type SocialPlatform } from "../lib/socialPlatform";

export const getOppForNotify = internalQuery({
  args: { opportunityId: v.id("opportunities") },
  handler: async (ctx, args) => {
    const opp = await ctx.db.get(args.opportunityId);
    if (!opp) return null;
    return {
      _id: opp._id,
      qualifiedBy: opp.qualifiedBy,
      tenantId: opp.tenantId,
    };
  },
});

export const getLeadForNotify = internalQuery({
  args: { leadId: v.id("leads") },
  handler: async (ctx, args) => {
    const lead = await ctx.db.get(args.leadId);
    if (!lead) return null;
    return { _id: lead._id, fullName: lead.fullName, email: lead.email };
  },
});

export const getPrimarySocialIdentifier = internalQuery({
  args: { leadId: v.id("leads") },
  handler: async (ctx, args) => {
    // Pick the most-recent slack-sourced social identifier.
    const idents = await ctx.db
      .query("leadIdentifiers")
      .withIndex("by_leadId", (q) => q.eq("leadId", args.leadId))
      .take(20);
    const social = idents
      .filter((i) => SOCIAL_PLATFORMS.includes(i.type as SocialPlatform))
      .sort((a, b) => b.createdAt - a.createdAt);
    const primary = social[0];
    if (!primary) return null;
    return {
      platform: primary.type as SocialPlatform,
      rawValue: primary.rawValue,
    };
  },
});

export const clearNotifyChannel = internalMutation({
  args: { installationId: v.id("slackInstallations") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.installationId, {
      notifyChannelId: undefined,
      notifyChannelName: undefined,
    });
  },
});
```

> **Index note:** `leadIdentifiers.by_leadId` already exists in the current schema. Do not replace this with a tenant-wide query or `.filter()`; the action is on the post-submit path and should stay bounded.

**Step 4: Add the action-context domain-event emit helper**

`emitDomainEvent` from `convex/lib/domainEvents.ts` is a mutation-context helper. Actions cannot call it directly, so expose one internal mutation wrapper and a small action helper. Before adding the wrapper, use `convex-migration-helper` to widen `domainEvents.entityType` in both `convex/schema.ts` and `convex/lib/domainEvents.ts` with a new literal: `"slackInstallation"`. This is additive; existing rows remain valid.

```typescript
// Path: convex/lib/domainEventsInternal.ts (new)

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { emitDomainEvent } from "./domainEvents";

export const insert = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    entityType: v.union(
      v.literal("opportunity"),
      v.literal("meeting"),
      v.literal("lead"),
      v.literal("customer"),
      v.literal("followUp"),
      v.literal("user"),
      v.literal("payment"),
      v.literal("slackInstallation"),
    ),
    entityId: v.string(),
    eventType: v.string(),
    source: v.union(
      v.literal("closer"),
      v.literal("admin"),
      v.literal("pipeline"),
      v.literal("system"),
    ),
    actorUserId: v.optional(v.id("users")),
    fromStatus: v.optional(v.string()),
    toStatus: v.optional(v.string()),
    reason: v.optional(v.string()),
    metadata: v.optional(v.record(v.string(), v.any())),
    occurredAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await emitDomainEvent(ctx, args);
  },
});
```

```typescript
// Path: convex/lib/domainEventsAction.ts (new)

import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import type {
  DomainEventEntityType,
  DomainEventSource,
} from "./domainEvents";
import { internal } from "../_generated/api";

/**
 * Action-context wrapper around the internal domain-event insert mutation.
 */
export async function emitDomainEventInAction(
  ctx: ActionCtx,
  args: {
    tenantId: Id<"tenants">;
    entityType: DomainEventEntityType;
    entityId: string;
    eventType: string;
    source: DomainEventSource;
    occurredAt: number;
    actorUserId?: Id<"users">;
    fromStatus?: string;
    toStatus?: string;
    reason?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await ctx.runMutation(internal.lib.domainEventsInternal.insert, args);
}
```

If the implementation has already introduced an equivalent internal mutation, reuse that canonical export instead of creating a duplicate wrapper.

**Step 5: Verify**

After Phase 3 + Phase 5 are deployed and a tenant has configured a notify channel:

1. Run `/qualify-lead` and submit a real lead.
2. Within ~1 second, the configured channel should receive a Block Kit message with:
   - 🎯 New Qualified Lead header
   - Lead name, platform, handle, qualified-by mention
   - "Open in CRM" button
3. Verify in Convex:
   ```bash
   npx convex data domainEvents | grep slack.notify
   #   No `slack.notify.failed` rows on success.
   ```
4. To verify failure handling, manually patch `slackInstallations.notifyChannelId` to a deleted channel ID. Run another `/qualify-lead`. Expect:
   - `npx convex data domainEvents` shows a `slack.notify.failed` row with `metadata.slackErr === "channel_not_found"`.
   - `npx convex data slackInstallations` shows `notifyChannelId === undefined` (auto-cleared).

**Key implementation notes:**
- **Keep action files and DB helper files separate.** `notify.ts` and `staleReminders.ts` are action modules; their database reads/writes live in `notifyData.ts` / `staleRemindersData.ts` so queries and mutations are not mixed into action files. These actions should stay in the default Convex runtime because their Slack calls use `fetch`.
- **Best-effort means best-effort.** If `chat.postMessage` 5xx's, we don't retry — this is by design. Adding retry logic would risk duplicate posts (Slack accepted it but the response timed out). Slack rate-limits don't apply at our v1 volume.
- **`channel_not_found` / `is_archived` auto-clears the affected field.** Confirmation posts clear `notifyChannelId`; stale digests clear `staleReminderChannelId` when using the dedicated channel, otherwise `notifyChannelId` when falling back. The Integrations card UI (5D) shows an "Action required" banner so the admin re-picks.
- **`SOCIAL_PLATFORM_LABELS`** in the message keeps the user-visible platform name in title case (Instagram, TikTok, Twitter/X). Without it the message would show `instagram`.
- **Final copy is per [Open Q5](../slackbot-design.md).** The skeleton structure is locked; the strings (`"🎯 New Qualified Lead"`, `"Open in CRM"`) need a 30-min review with marketing before final prod ship. Phase 5F's QA gate includes a copy-review checkbox.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/slack/notify.ts` | Modify | Replace 3D stub with real `postConfirmation` action |
| `convex/slack/notifyData.ts` | Create | Internal queries/mutations used by notify action |
| `convex/lib/slackBlockKit.ts` | Modify | Add `buildQualifiedLeadConfirmation` |
| `convex/schema.ts` | Modify | Add `slackInstallation` to `domainEvents.entityType` union |
| `convex/lib/domainEvents.ts` | Modify | Add `slackInstallation` to `DomainEventEntityType` |
| `convex/lib/domainEventsInternal.ts` | Create if absent | Internal mutation wrapper around `emitDomainEvent` |
| `convex/lib/domainEventsAction.ts` | Create if absent | Action-context emit helper |

---

### 5C — Stale-Lead Digest: DST-Safe Cron + Per-Tenant Fan-Out

**Type:** Backend
**Parallelizable:** Yes — independent of 5A, 5B.

**What:** Three artifacts:
1. `convex/slack/staleReminders.ts` — actions only: `maybeRun` (hourly UTC; gates on `hourInNY === 8`); `fanOut` (iterates active installations, calls `postStaleDigestForTenant` per row); `postStaleDigestForTenant` (builds the digest and posts to Slack via `slackApiPostJson`).
2. `convex/slack/staleRemindersData.ts` — internal queries/mutations used by the actions (`listActiveInstallationIds`, `listStaleOpportunities`, `clearConfiguredChannel`).
3. A cron entry in `convex/crons.ts` that calls `maybeRun` hourly.

**Why:** Per [§8.3](../slackbot-design.md), Convex `crons.cron()` runs in **UTC** with no native timezone. Two approaches considered:

| Approach | Verdict |
|---|---|
| Hourly UTC + gate inside handler on `hourInNY === 8` | **Chosen** — exact 08:00 ET year-round, DST-safe; cheap no-ops |
| Single UTC cron at `0 13 * * *` | Rejected — drifts to 09:00 ET in winter |

The fan-out is per-tenant so a slow Slack response for one tenant doesn't delay others.

**Where:**
- `convex/slack/staleReminders.ts` (new — action module)
- `convex/slack/staleRemindersData.ts` (new — internal queries/mutations only)
- `convex/lib/slackBlockKit.ts` (modify — add `buildStaleDigest`)
- `convex/crons.ts` (modify)

**How:**

**Step 1: Add the digest builder**

```typescript
// Path: convex/lib/slackBlockKit.ts (additions)

import type { KnownBlock } from "@slack/types";

export type StaleLeadDigestEntry = {
  leadFullName: string;
  platform: SocialPlatform;
  handle: string;
  daysOld: number;
  appUrl: string;
  opportunityId: string;
  qualifiedBySlackUserId: string;
};

const MAX_DIGEST_ENTRIES = 25;  // see slackbot-design.md §8.3

export function buildStaleDigest(args: {
  entries: StaleLeadDigestEntry[];
  hasMore: boolean;               // exact total count is not available in v1
  appUrl: string;
}) {
  const visible = args.entries.slice(0, MAX_DIGEST_ENTRIES);
  const headline = args.hasMore
    ? `${visible.length}+ qualified leads waiting`
    : `${visible.length} qualified lead${visible.length === 1 ? "" : "s"} waiting`;

  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `🟡 ${headline}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Qualified > 30 days ago, no booking yet. Daily digest, 8am ET.`,
        },
      ],
    },
    { type: "divider" },
  ];

  for (const e of visible) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*${e.leadFullName}*\n` +
          `${SOCIAL_PLATFORM_LABELS[e.platform]} • ${e.handle} • ${e.daysOld} day${e.daysOld === 1 ? "" : "s"} old\n` +
          `Qualified by <@${e.qualifiedBySlackUserId}>`,
      },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "Open" },
        url: `${e.appUrl}/workspace/pipeline?opportunity=${e.opportunityId}`,
      },
    });
  }

  if (args.hasMore) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_More qualified leads are waiting — view all in the CRM_",
      },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "View all" },
        url: `${args.appUrl}/workspace/pipeline?source=slack_qualified&status=qualified_pending`,
      },
    });
  }

  return {
    text: headline,
    blocks,
  };
}
```

**Step 2: Implement the cron action**

```typescript
// Path: convex/slack/staleReminders.ts
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { getValidSlackBotToken } from "./tokens";
import { slackApiPostJson } from "./webApi";
import { buildStaleDigest, type StaleLeadDigestEntry } from "../lib/slackBlockKit";
import { emitDomainEventInAction } from "../lib/domainEventsAction";

const STALE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;
const STALE_FAN_OUT_LIMIT_PER_TENANT = 200;

/**
 * Hourly entrypoint. Gates on hour-in-NY equality so the digest fires exactly
 * once at 08:00 America/New_York every day, year-round (DST-safe).
 */
export const maybeRun = internalAction({
  args: {},
  handler: async (ctx) => {
    const hourInNY = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        hour12: false,
      }).format(new Date()),
    );
    if (hourInNY !== 8) {
      // 23 of every 24 hours, this is the entire body. Cheap no-op.
      return;
    }
    console.log("[Slack:Stale] cron fired (08:00 NY)");
    await ctx.runAction(internal.slack.staleReminders.fanOut, {});
  },
});

/**
 * Per-tenant fan-out. One scheduled action per active installation so a slow
 * Slack response for one tenant doesn't delay the others.
 */
export const fanOut = internalAction({
  args: {},
  handler: async (ctx) => {
    const ids = await ctx.runQuery(
      internal.slack.staleRemindersData.listActiveInstallationIds,
      {},
    );
    console.log("[Slack:Stale] fan-out", { tenantCount: ids.length });
    for (const id of ids) {
      await ctx.scheduler.runAfter(0, internal.slack.staleReminders.postForTenant, {
        installationId: id,
      });
    }
  },
});

export const postForTenant = internalAction({
  args: { installationId: v.id("slackInstallations") },
  handler: async (ctx, args) => {
    const inst = await ctx.runQuery(internal.slack.installations.byId, {
      id: args.installationId,
    });
    if (!inst || inst.status !== "active") return;

    // Pick the channel: stale-reminder dedicated, falling back to notify.
    const channelId = inst.staleReminderChannelId ?? inst.notifyChannelId;
    if (!channelId) {
      console.log("[Slack:Stale] skipping — no channel configured", {
        tenantId: inst.tenantId,
      });
      return;
    }

    // Find stale qualified_pending opps for this tenant.
    const cutoff = Date.now() - STALE_THRESHOLD_MS;
    const stale = await ctx.runQuery(
      internal.slack.staleRemindersData.listStaleOpportunities,
      { tenantId: inst.tenantId, cutoff, limit: STALE_FAN_OUT_LIMIT_PER_TENANT },
    );

    if (stale.opps.length === 0) {
      console.log("[Slack:Stale] no stale leads", { tenantId: inst.tenantId });
      return;
    }

    // Build digest entries (hydrate names + handles per opp).
    const entries: StaleLeadDigestEntry[] = stale.opps.map((row) => ({
      leadFullName: row.leadFullName ?? row.leadEmail ?? "Lead",
      platform: row.platform,
      handle: row.handle,
      daysOld: Math.floor((Date.now() - row.createdAt) / (24 * 60 * 60 * 1000)),
      appUrl: process.env.APP_URL!,
      opportunityId: row.opportunityId,
      qualifiedBySlackUserId: row.qualifiedBySlackUserId,
    }));

    const message = buildStaleDigest({
      entries,
      hasMore: stale.hasMore,
      appUrl: process.env.APP_URL!,
    });

    let token: string;
    try {
      token = await getValidSlackBotToken(ctx, inst.tenantId);
    } catch {
      console.warn("[Slack:Stale] token unavailable", { tenantId: inst.tenantId });
      return;
    }

    try {
      const r = await slackApiPostJson<{ channel?: string; ts?: string }>(
        "chat.postMessage",
        token,
        {
        channel: channelId,
        text: message.text,
        blocks: message.blocks,
        },
      );
      if (!r.ok) throw new Error(r.error ?? "unknown");
      console.log("[Slack:Stale] posted", {
        tenantId: inst.tenantId, channel: channelId, count: entries.length,
      });
    } catch (e: unknown) {
      const slackErr = e instanceof Error ? e.message : "unknown";
      console.warn("[Slack:Stale] post failed", { tenantId: inst.tenantId, slackErr });
      if (slackErr === "channel_not_found" || slackErr === "is_archived") {
        await ctx.runMutation(internal.slack.staleRemindersData.clearConfiguredChannel, {
          installationId: inst._id,
          channelKind: inst.staleReminderChannelId ? "staleReminder" : "notify",
        });
      }
      await emitDomainEventInAction(ctx, {
        tenantId: inst.tenantId,
        entityType: "slackInstallation",
        entityId: inst._id,
        eventType: "slack.stale.failed",
        source: "system",
        occurredAt: Date.now(),
        metadata: { slackErr, channel: channelId },
      });
    }
  },
});
```

**Step 3: Add non-Node DB helpers**

```typescript
// Path: convex/slack/staleRemindersData.ts

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { SOCIAL_PLATFORMS, type SocialPlatform } from "../lib/socialPlatform";

export const listActiveInstallationIds = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("slackInstallations")
      .withIndex("by_status_and_tokenExpiresAt", (q) => q.eq("status", "active"))
      .take(1000); // see slackbot-design.md §13.6 — chunk beyond ~5k tenants
    return rows.map((r) => r._id);
  },
});

export const listStaleOpportunities = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    cutoff: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const opps = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_source_and_status_and_createdAt", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("source", "slack_qualified")
          .eq("status", "qualified_pending")
      .lt("createdAt", args.cutoff))
      .order("asc")  // oldest-first — most-deserving-of-attention at top
      .take(args.limit + 1);
    const hasMore = opps.length > args.limit;

    // Hydrate lead + identifier per opp.
    const entries = [];
    for (const o of opps.slice(0, args.limit)) {
      const lead = await ctx.db.get(o.leadId);
      if (!lead) continue;
      const idents = await ctx.db
        .query("leadIdentifiers")
        .withIndex("by_leadId", (q) => q.eq("leadId", o.leadId))
        .take(10);
      const social = idents
        .filter((i) => SOCIAL_PLATFORMS.includes(i.type as SocialPlatform))
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      if (!social || !o.qualifiedBy) continue;
      entries.push({
        opportunityId: o._id,
        createdAt: o.createdAt,
        leadFullName: lead.fullName ?? null,
        leadEmail: lead.email ?? null,
        platform: social.type as SocialPlatform,
        handle: social.rawValue,
        qualifiedBySlackUserId: o.qualifiedBy.slackUserId,
      });
    }
    return { opps: entries, hasMore };
  },
});

export const clearConfiguredChannel = internalMutation({
  args: {
    installationId: v.id("slackInstallations"),
    channelKind: v.union(v.literal("notify"), v.literal("staleReminder")),
  },
  handler: async (ctx, args) => {
    if (args.channelKind === "staleReminder") {
      await ctx.db.patch(args.installationId, {
        staleReminderChannelId: undefined,
        staleReminderChannelName: undefined,
      });
      return;
    }
    await ctx.db.patch(args.installationId, {
      notifyChannelId: undefined,
      notifyChannelName: undefined,
    });
  },
});
```

**Step 4: Register the cron**

```typescript
// Path: convex/crons.ts (modify — add)

crons.cron(
  "slack-stale-qualified-leads-reminder",
  "0 * * * *",                                     // top of every hour, UTC — DST-safe gate inside the handler
  internal.slack.staleReminders.maybeRun,
  {},
);
```

> **`crons.cron` rather than `crons.interval`** so the cron always fires at the top of the hour (instead of `now + 1h`, which drifts).

**Step 5: Verify**

Easiest verification: temporarily lower the gate to a different hour while testing, then restore.

```typescript
// Path: convex/slack/staleReminders.ts (TEMPORARY — revert after verification)
if (hourInNY !== 8) return;
// Replace temporarily with a hour you can wait for:
// if (hourInNY !== <current NY hour>) return;
```

Or invoke `fanOut` directly:

```bash
npx convex run slack/staleReminders:fanOut '{}'
# Watch logs for "[Slack:Stale] fan-out" and per-tenant posts.
```

If your dev tenant has zero stale leads, backdate one with `_temp_backdateOpp.ts` from Phase 4C Step 4 to be older than 30 days, then re-run.

**Key implementation notes:**
- **`new Intl.DateTimeFormat(...).format(...)`** is the canonical way to derive a wall-clock hour in a given timezone in Node ≥ 14. Convex actions run in a Node-compatible runtime; this is supported.
- **Skipping weekends** is per [Open Q4](../slackbot-design.md). Recommended for v1 — setters often don't work weekends and digests pile up unread. Add a check on `weekday`:
  ```typescript
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(new Date());
  if (weekday === "Sat" || weekday === "Sun") return;
  ```
  Confirm with product before merging.
- **`cron.cron("0 * * * *", …)` syntax**: minute=0 hour=any day=any month=any weekday=any → top of every hour UTC. The 23-of-24 no-ops are intentional and cheap.
- **`fanOut` runs all tenants in the same action call.** For 5k+ tenants the action might exceed the time budget. Beyond that scale, paginate via createdAt cursor and run sub-fanouts. v1 is fine.
- **Cap of 25 entries per digest** per [§8.3](../slackbot-design.md). Block Kit has limits (~50 blocks per message; we use 4 base blocks + 1 per entry); 25 keeps us safely inside.
- **`hasMore`, not exact `totalCount`.** Convex does not provide a cheap exact count here, and this query intentionally avoids a separate aggregate table in v1. Fetch `limit + 1` and use non-count overflow copy.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/slack/staleReminders.ts` | Create | Actions: `maybeRun`, `fanOut`, `postForTenant` |
| `convex/slack/staleRemindersData.ts` | Create | Internal queries/mutations used by stale reminder actions |
| `convex/lib/slackBlockKit.ts` | Modify | Add `buildStaleDigest` |
| `convex/crons.ts` | Modify | Register `slack-stale-qualified-leads-reminder` |

---

### 5D — Frontend: Integrations Card

**Type:** Frontend (RSC + client component)
**Parallelizable:** Yes — depends on 5A's `getInstallationStatus`. Independent of 5E.

**What:** A polished `<SlackIntegrationCard>` component for `/workspace/settings?tab=integrations`. Shows status pill, configured channels, install date, and Connect / Change channels / Disconnect actions. Uses the established RSC + client component pattern from `AGENTS.md`:

- Server component fetches `getInstallationStatus` via `preloadQuery`.
- Client component reads via `usePreloadedQuery` and renders the interactive UI.

**Why:** This is the canonical surface tenants will see throughout the lifetime of the integration. Phase 6 (lifecycle) will hook reconnect / re-OAuth flows here too. Phase 5 lands the layout + happy-path / disconnected states; Phase 6 fills in `token_expired` / `revoked` / `uninstalled` reconnect CTAs.

**Where:**
- `app/workspace/settings/_components/integrations/slack-integration-card.tsx` (new)
- `app/workspace/settings/_components/integrations/slack-integration-section.tsx` (new) — RSC wrapper
- `app/workspace/settings/_components/settings-page-client.tsx` (modify — replace the Phase 1 1E temporary CTA with the real card)

**How:**

**Step 1: Build the RSC wrapper**

```tsx
// Path: app/workspace/settings/_components/integrations/slack-integration-section.tsx

import { preloadQuery } from "convex/nextjs";
import { Suspense } from "react";
import { SlackIntegrationCard } from "./slack-integration-card";
import { SlackIntegrationCardSkeleton } from "./slack-integration-card-skeleton";
import { api } from "@/convex/_generated/api";
import { getAccessToken } from "@/lib/auth";  // existing helper

export async function SlackIntegrationSection() {
  // Preload — server-side fetch with the WorkOS access token.
  // Pattern matches AGENTS.md § Preloading Pattern.
  const token = await getAccessToken();
  const preloaded = await preloadQuery(
    api.slack.channels.getInstallationStatus,
    {},
    { token },
  );

  return (
    <Suspense fallback={<SlackIntegrationCardSkeleton />}>
      <SlackIntegrationCard preloadedStatus={preloaded} />
    </Suspense>
  );
}
```

**Step 2: Build the client component**

```tsx
// Path: app/workspace/settings/_components/integrations/slack-integration-card.tsx
"use client";

import { useState } from "react";
import { usePreloadedQuery, useMutation } from "convex/react";
import type { Preloaded } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { useRole } from "@/components/auth/role-context";
import { SlackChannelPickerDialog } from "./slack-channel-picker-dialog";
import { AlertTriangle, CheckCircle2, Slack as SlackIcon } from "lucide-react";

type Props = {
  preloadedStatus: Preloaded<typeof api.slack.channels.getInstallationStatus>;
};

export function SlackIntegrationCard({ preloadedStatus }: Props) {
  const status = usePreloadedQuery(preloadedStatus);
  const { role } = useRole();
  const isMaster = role === "tenant_master";
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const disconnectMutation = useMutation(api.slack.channels.disconnectSlack);

  if (status.kind === "not_connected") {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <SlackIcon className="size-5" aria-hidden />
            <CardTitle>Slack</CardTitle>
          </div>
          <CardDescription>
            Qualify leads from Slack — install the bot in your workspace, run /qualify-lead, and pipeline rows appear in the CRM.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <a href="/api/slack/start">Connect Slack</a>
          </Button>
        </CardContent>
      </Card>
    );
  }

  // Connected
  const needsChannel = !status.notifyChannelId;
  const tokenExpired = status.status === "token_expired";
  const revoked = status.status === "revoked";
  const uninstalled = status.status === "uninstalled";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <SlackIcon className="size-5" aria-hidden />
          <CardTitle>Slack</CardTitle>
          <StatusBadge status={status.status} />
        </div>
        <CardDescription>
          Connected to <strong>{status.teamName}</strong> on{" "}
          {new Date(status.installedAt).toLocaleDateString()}.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {needsChannel && status.status === "active" && (
          <Alert>
            <AlertTriangle className="size-4" />
            <AlertTitle>Pick a notification channel</AlertTitle>
            <AlertDescription>
              Slack qualifications will be saved in the CRM, but no channel
              messages can post until you choose where they go.
            </AlertDescription>
          </Alert>
        )}

        {(tokenExpired || revoked) && (
          <Alert variant="destructive">
            <AlertTriangle className="size-4" />
            <AlertTitle>
              {tokenExpired
                ? "Slack token expired"
                : "Slack tokens revoked"}
            </AlertTitle>
            <AlertDescription>
              Click <em>Reconnect</em> below to restore the integration. Slack
              data already in the CRM is unaffected.
            </AlertDescription>
          </Alert>
        )}

        {uninstalled && (
          <Alert>
            <AlertTitle>Slack app uninstalled</AlertTitle>
            <AlertDescription>
              The Magnus CRM Slack app was uninstalled from your workspace. Click
              <em> Reconnect</em> to install again.
            </AlertDescription>
          </Alert>
        )}

        <ChannelSummary status={status} />

        <div className="flex flex-wrap gap-2">
          {(tokenExpired || revoked || uninstalled) && (
            <Button asChild>
              <a href="/api/slack/start">Reconnect</a>
            </Button>
          )}
          {status.status === "active" && (
            <Button
              variant="secondary"
              onClick={() => setPickerOpen(true)}
            >
              {needsChannel ? "Pick channels" : "Change channels"}
            </Button>
          )}
          {isMaster && status.status !== "uninstalled" && (
            <Button
              variant="ghost"
              className="text-destructive"
              onClick={() => setConfirmingDisconnect(true)}
            >
              Disconnect
            </Button>
          )}
        </div>

        {/* Channel picker — opens automatically post-OAuth via ?pickChannel=true (5E) */}
        <SlackChannelPickerDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          initialNotifyChannelId={status.notifyChannelId}
          initialStaleChannelId={status.staleReminderChannelId}
        />

        {confirmingDisconnect && (
          <DisconnectConfirm
            onCancel={() => setConfirmingDisconnect(false)}
            onConfirm={async () => {
              await disconnectMutation({});
              setConfirmingDisconnect(false);
            }}
            teamName={status.teamName}
          />
        )}
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "active":
      return <Badge variant="default" className="gap-1"><CheckCircle2 className="size-3" /> Connected</Badge>;
    case "token_expired":
      return <Badge variant="destructive">Token expired</Badge>;
    case "revoked":
      return <Badge variant="destructive">Tokens revoked</Badge>;
    case "uninstalled":
      return <Badge variant="secondary">Uninstalled</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function ChannelSummary({ status }: { status: any }) {
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
      <div>
        <dt className="text-muted-foreground">Notify channel</dt>
        <dd className="font-medium">
          {status.notifyChannelName ? `#${status.notifyChannelName}` : "Not configured"}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Stale-lead reminder channel</dt>
        <dd className="font-medium">
          {status.staleReminderChannelName
            ? `#${status.staleReminderChannelName}`
            : status.notifyChannelName
              ? `(falls back to #${status.notifyChannelName})`
              : "Not configured"}
        </dd>
      </div>
    </dl>
  );
}

function DisconnectConfirm({
  onCancel, onConfirm, teamName,
}: { onCancel: () => void; onConfirm: () => void; teamName: string }) {
  // Use shadcn AlertDialog for confirmation. (Skeleton — full form should match
  // the patterns in app/workspace/team/_components/role-edit-dialog.tsx.)
  return (
    <Alert variant="destructive" className="space-y-2">
      <AlertTitle>Disconnect Slack from {teamName}?</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>
          Future /qualify-lead invocations will return an ephemeral message
          asking the user to ask an admin to reconnect.
          Existing Slack-qualified opportunities in the CRM are unaffected.
        </p>
        <div className="flex gap-2">
          <Button variant="destructive" size="sm" onClick={onConfirm}>
            Disconnect
          </Button>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
```

**Step 3: Build the skeleton**

```tsx
// Path: app/workspace/settings/_components/integrations/slack-integration-card-skeleton.tsx

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function SlackIntegrationCardSkeleton() {
  return (
    <Card aria-label="Loading Slack integration status" role="status">
      <CardHeader>
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-4 w-64 mt-2" />
      </CardHeader>
      <CardContent className="space-y-4">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-9 w-32" />
      </CardContent>
    </Card>
  );
}
```

**Step 4: Wire into the settings page**

```tsx
// Path: app/workspace/settings/_components/settings-page-client.tsx (modify)

// EXISTING — after the imports:
import { SlackIntegrationSection } from "./integrations/slack-integration-section";

// REPLACE the temporary "Connect Slack" button block from Phase 1 1E:
<TabsContent value="integrations">
  <div className="space-y-4">
    <SlackIntegrationSection />
    {/* Future: CalendlyIntegrationSection / etc. */}
  </div>
</TabsContent>
```

**Step 5: Verify**

```bash
pnpm tsc --noEmit
pnpm dev
```

In the browser as a `tenant_master` / `tenant_admin`:

1. Navigate to `/workspace/settings?tab=integrations`.
2. **Pre-OAuth**: card shows "Slack — Not connected" with Connect button.
3. After completing OAuth: card shows status pill `Connected`, team name, "Pick channels" CTA.
4. After saving channels in 5E: card shows the configured channel names.

As a `closer`:

1. Navigate to the same URL — should redirect to `/workspace`.

**Key implementation notes:**
- **`SlackIntegrationSection` is the RSC.** The `preloadQuery` happens server-side; it uses the WorkOS token. The pattern matches the AGENTS.md preloading example.
- **`SlackIntegrationCard` is the client component.** All hooks (`useState`, `useMutation`, `useRole`) live here. The card receives `Preloaded<…>` as a prop and hydrates with `usePreloadedQuery`.
- **`useRole` enforces destructive-action gating.** `isMaster` controls whether the Disconnect button renders. The backend re-validates (`disconnectSlack` only allows `tenant_master`); UI gating is defense-in-depth + better UX (no surprise 403).
- **The status pill component (`StatusBadge`)** uses lucide icons and shadcn `Badge`. Phase 6 will add a sixth state (`connecting` / `awaiting_approval`) when the OAuth flow is paused on Slack-side review; that's a small extension to this component.
- **Skeleton accessibility** — `role="status"` + `aria-label` per AGENTS.md skeleton conventions.
- **`Reconnect` button reuses `/api/slack/start`** — the start route is OAuth-flow-state-blind, so the same Phase 1 entry point handles all reinstall paths. Phase 6 may differentiate the redirect target (return to `/workspace/settings?tab=integrations` rather than `&pickChannel=true` if channels are already configured); for now, the post-OAuth `pickChannel=true` is a no-op-friendly param the dialog ignores when channels are already set.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/settings/_components/integrations/slack-integration-section.tsx` | Create | RSC wrapper |
| `app/workspace/settings/_components/integrations/slack-integration-card.tsx` | Create | Client component |
| `app/workspace/settings/_components/integrations/slack-integration-card-skeleton.tsx` | Create | Loading skeleton |
| `app/workspace/settings/_components/settings-page-client.tsx` | Modify | Replace Phase 1 1E temp CTA with `<SlackIntegrationSection />` |

---

### 5E — Frontend: Channel Picker Dialog (RHF + Zod + Combobox)

**Type:** Frontend (client component)
**Parallelizable:** Yes — depends on 5A. Independent of 5D's card layout but plugs into it.

**What:** A modal dialog `<SlackChannelPickerDialog>` with two `<Combobox>` instances (notify channel + stale-reminder channel). Form managed via React Hook Form + Zod per `AGENTS.md`. Shows a private-channel banner when a private channel is selected. Auto-opens when the user lands on `/workspace/settings?tab=integrations&pickChannel=true` (post-OAuth redirect target).

**Why:** Per [§8.5.1](../slackbot-design.md), this is the per-tenant onboarding step. The picker is the gate between "OAuth completed" and "messages can flow" — without picking a channel, the system would silently no-op channel posts.

**Where:**
- `app/workspace/settings/_components/integrations/slack-channel-picker-dialog.tsx` (new)

**How:**

**Step 1: Build the dialog**

```tsx
// Path: app/workspace/settings/_components/integrations/slack-channel-picker-dialog.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Combobox,
  ComboboxValue,
  ComboboxTrigger,
  ComboboxClear,
  // (Other Combobox sub-components — verify exports against components/ui/combobox.tsx)
} from "@/components/ui/combobox";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Loader2, Lock, Hash } from "lucide-react";
import { toast } from "sonner";

const schema = z.object({
  notifyChannelId: z.string().min(1, "Required"),
  staleReminderChannelId: z.string().min(1, "Required"),
});
type FormValues = z.infer<typeof schema>;

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialNotifyChannelId?: string;
  initialStaleChannelId?: string;
};

export function SlackChannelPickerDialog({
  open, onOpenChange, initialNotifyChannelId, initialStaleChannelId,
}: Props) {
  const [channels, setChannels] = useState<any[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const listAction = useAction(api.slack.channelsActions.listInstalledChannels);
  const saveMutation = useMutation(api.slack.channels.setSlackNotifyChannels);

  const form = useForm({
    resolver: standardSchemaResolver(schema),
    defaultValues: {
      notifyChannelId: initialNotifyChannelId ?? "",
      staleReminderChannelId: initialStaleChannelId ?? "",
    },
  });

  // Re-fetch channels each time the dialog opens (channels change in real Slack workspaces).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setChannels(null);
    setListError(null);
    listAction({})
      .then((rows) => {
        if (!cancelled) setChannels(rows);
      })
      .catch((e) => {
        if (!cancelled) setListError(e instanceof Error ? e.message : "Failed to list channels");
      });
    return () => {
      cancelled = true;
    };
  }, [open, listAction]);

  const notifyId = form.watch("notifyChannelId");
  const staleId = form.watch("staleReminderChannelId");

  const selectedNotify = useMemo(
    () => channels?.find((c) => c.id === notifyId),
    [channels, notifyId],
  );
  const selectedStale = useMemo(
    () => channels?.find((c) => c.id === staleId),
    [channels, staleId],
  );

  const showPrivateBanner = selectedNotify?.isPrivate || selectedStale?.isPrivate;

  async function onSubmit(values: FormValues) {
    const notify = channels?.find((c) => c.id === values.notifyChannelId);
    const stale = channels?.find((c) => c.id === values.staleReminderChannelId);
    if (!notify || !stale) {
      toast.error("Pick valid channels first.");
      return;
    }
    try {
      await saveMutation({
        notifyChannelId: notify.id,
        notifyChannelName: notify.name,
        staleReminderChannelId: stale.id,
        staleReminderChannelName: stale.name,
      });
      toast.success("Slack channels saved.");
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Pick Slack channels</DialogTitle>
          <DialogDescription>
            Confirmations and the daily 8am ET stale-lead digest will post here.
          </DialogDescription>
        </DialogHeader>

        {listError && (
          <Alert variant="destructive">
            <AlertTitle>Couldn't list channels</AlertTitle>
            <AlertDescription>{listError}</AlertDescription>
          </Alert>
        )}

        {!channels && !listError && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
            <Loader2 className="size-4 animate-spin" /> Loading channels…
          </div>
        )}

        {channels && (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="notifyChannelId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Notify channel <span className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <ChannelCombobox
                        channels={channels}
                        value={field.value}
                        onValueChange={field.onChange}
                        placeholder="Pick a channel for new-lead notifications"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="staleReminderChannelId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Stale-lead reminder channel{" "}
                      <span className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <ChannelCombobox
                        channels={channels}
                        value={field.value}
                        onValueChange={field.onChange}
                        placeholder="Pick the channel for daily digest"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {showPrivateBanner && (
                <Alert>
                  <Lock className="size-4" />
                  <AlertTitle>Private channel selected</AlertTitle>
                  <AlertDescription>
                    Run <code>/invite @Magnus</code> in the private channel after saving.
                    Bots cannot self-add to private channels — without the invite,
                    posts will silently fail.
                  </AlertDescription>
                </Alert>
              )}

              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={form.formState.isSubmitting}>
                  {form.formState.isSubmitting ? "Saving…" : "Save"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Local helper — Combobox-of-channels. Adapt to your existing `<Combobox>` API.
 * Adjust prop names against components/ui/combobox.tsx — the survey notes the
 * primitives are `Combobox`, `ComboboxValue`, `ComboboxTrigger`, `ComboboxClear`.
 */
function ChannelCombobox({
  channels, value, onValueChange, placeholder,
}: {
  channels: { id: string; name: string; isPrivate: boolean; isArchived: boolean }[];
  value: string;
  onValueChange: (id: string) => void;
  placeholder?: string;
}) {
  // Filter archived from primary list; keep available for explicit search.
  const items = channels.filter((c) => !c.isArchived);
  const selected = channels.find((c) => c.id === value);
  return (
    <Combobox value={value} onValueChange={onValueChange}>
      <ComboboxTrigger>
        {selected ? (
          <span className="flex items-center gap-1">
            {selected.isPrivate ? <Lock className="size-3" /> : <Hash className="size-3" />}
            {selected.name}
          </span>
        ) : (
          <span className="text-muted-foreground">{placeholder}</span>
        )}
      </ComboboxTrigger>
      <ComboboxValue>
        {items.map((c) => (
          // Replace with the actual ComboboxItem export per your local API.
          <div key={c.id} className="flex items-center gap-2">
            {c.isPrivate ? <Lock className="size-3" /> : <Hash className="size-3" />}
            <span>{c.name}</span>
          </div>
        ))}
      </ComboboxValue>
      <ComboboxClear />
    </Combobox>
  );
}
```

**Step 2: Auto-open the dialog after OAuth**

When the redirect lands on `?slack=connected&pickChannel=true`, the dialog should open automatically. Wire this in `slack-integration-card.tsx`:

```tsx
// Path: app/workspace/settings/_components/integrations/slack-integration-card.tsx (modify)

import { useSearchParams } from "next/navigation";

// Inside SlackIntegrationCard, after the existing useState:
const searchParams = useSearchParams();
useEffect(() => {
  if (searchParams.get("slack") === "connected" && searchParams.get("pickChannel") === "true") {
    setPickerOpen(true);
  }
}, [searchParams]);
```

**Step 3: Verify**

1. Disconnect the dev tenant's Slack (button on the card).
2. Click Connect Slack → walk through OAuth.
3. Land on `/workspace/settings?tab=integrations&slack=connected&pickChannel=true`.
4. Dialog auto-opens with a loading state, then a list of channels.
5. Pick a public notify channel and a different stale channel; private-channel banner does not appear.
6. Click Save → toast confirms; dialog closes; card now shows the configured channels.
7. Re-open via "Change channels" — pick a private channel for one. Verify banner shows up.

**Key implementation notes:**
- **`useEffect` re-fetches on every `open` toggle.** Channels can change in real Slack workspaces (someone creates a new one between dialog opens). Caching across opens isn't worth the staleness.
- **`useAction(api.slack.channelsActions.listInstalledChannels)`** — since `listInstalledChannels` is `action`, not `query`, it's a one-shot RPC, not reactive. We trigger it on dialog open + on demand.
- **Form pattern** matches the AGENTS.md form pattern exactly: RHF `useForm` with `standardSchemaResolver(schema)` (NOT `zodResolver`); `<Form>` wrapping; `<FormField>` per field; `<FormMessage />` for inline errors.
- **Private-channel banner appears as soon as a private channel is selected** (live via `form.watch`). It does **not** block submission — bots can still post to private channels they were invited to. The banner's job is to remind the admin to run `/invite @Magnus` after saving.
- **Archived channels filter out by default.** A separate "Show archived" toggle could be added later for transparency.
- **`<Combobox>` component sub-export names may differ** — verify against `components/ui/combobox.tsx`. The survey shows it exports `Combobox`, `ComboboxValue`, `ComboboxTrigger`, `ComboboxClear`. Adjust JSX shape per actual API.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/settings/_components/integrations/slack-channel-picker-dialog.tsx` | Create | RHF + Zod dialog with Combobox + private-channel banner |
| `app/workspace/settings/_components/integrations/slack-integration-card.tsx` | Modify | Wire `useSearchParams` to auto-open the picker |

---

### 5F — End-to-End Onboarding QA + Copy Review

**Type:** Manual QA + copy review
**Parallelizable:** No — runs after 5A–5E are deployed.

**What:** Five manual scenarios + the copy-review session for §8.2 confirmation message and §8.3 stale-digest copy.

**Why:** Per [§8.5.2 Pre-launch product decisions](../slackbot-design.md), the confirmation-message copy and stale-window cadence need a 30-min copy review. This is the gate.

**Where:** No project files. Verification target: dev Slack workspace + dev Convex.

**How:**

**Step 1: Onboarding flow happy path**

1. Disconnect Slack on the dev tenant. Verify the card shows "Not connected".
2. Click Connect Slack → walks OAuth.
3. Lands on `/workspace/settings?tab=integrations&slack=connected&pickChannel=true`. Dialog auto-opens.
4. Pick a public channel for both notify + stale-reminder. Save.
5. Card now shows configured channels. Run `/qualify-lead`. Channel receives the confirmation message with the right copy.

**Step 2: Private-channel handoff**

1. In the picker, pick a **private** channel for notify. Save.
2. Banner-style message in the toast or inline: "Run /invite @Magnus in #<private-channel>."
3. Run `/qualify-lead` *before* inviting the bot. Verify:
   - Lead/opportunity created in CRM.
   - `domainEvents` shows `slack.notify.failed` with `slackErr: "not_in_channel"`.
   - Card surfaces a banner: "Bot not in #private-channel — run /invite @Magnus there."
4. Run `/invite @Magnus` in the private channel. Run `/qualify-lead` again. Channel post succeeds.

**Step 3: Channel-deleted recovery**

1. In Slack, delete the configured notify channel.
2. Run `/qualify-lead`.
3. Verify:
   - Lead/opportunity created.
   - `slack.notify.failed` event with `channel_not_found`.
   - `notifyChannelId` auto-cleared to `undefined`.
   - Card shows "Pick a notification channel" alert.
4. Re-pick a channel. Run `/qualify-lead` again. Success.

**Step 4: Stale digest dry-run**

Backdate at least one `qualified_pending` opportunity using the Phase 4C `_temp_backdateOpp` action (or rebuild it). Then:

```bash
npx convex run slack/staleReminders:fanOut '{}'
```

Verify the dev tenant's stale-reminder channel receives the digest. Confirm:
- Header shows the visible row count, using `25+` only when more rows exist.
- Each entry shows lead name, platform, handle, days-old, "Open" button.
- "Open" button URL is `/workspace/pipeline?opportunity=<id>` and resolves correctly.
- If you backdated > 25 leads, the non-count overflow block appears: `"More qualified leads are waiting — view all in the CRM"`.

**Step 5: Closer access**

1. Sign in as a `closer` test user.
2. Navigate to `/workspace/settings?tab=integrations`. Expect redirect to `/workspace`.
3. Hit `/api/slack/start` directly. Expect redirect to `/workspace?error=slack_admin_required`.
4. Verify backend: `convex/slack/channels.ts:setSlackNotifyChannels` rejects with "Insufficient permissions" if called.

**Step 6: Copy review session (with marketing)**

Schedule 30 minutes. Walk through:

- §8.2 confirmation message header + field labels + CTA wording. Currently `"🎯 New Qualified Lead"` / `"*Name:*\n…"` / `"Open in CRM"`. Approve or amend.
- §8.3 stale digest header — `"🟡 N qualified leads waiting"`. Approve or amend.
- Disconnected card empty state — `"Qualify leads from Slack — install the bot in your workspace, run /qualify-lead, and pipeline rows appear in the CRM."` Approve or amend.
- Private-channel banner copy.

Update `convex/lib/slackBlockKit.ts` and `slack-integration-card.tsx` per the session's outcomes. **Do not deploy to prod with placeholder copy** — once tenants see a message, changing it later feels churny even if cosmetic.

**Step 7: Decisions**

Per [§8.5.2 Open Q4](../slackbot-design.md), confirm with product:
- Skip weekends? Recommend **yes**. If yes, add the weekday gate to `staleReminders.ts:maybeRun`.
- Tenant-configurable hour? Recommend **no** — hard-code 08:00 ET.
- Tenant-configurable timezone? **Defer**.

Document the decisions in the team's product decisions log.

**Key implementation notes:**
- **The copy review is non-skippable.** Final prod ship requires marketing approval per [Open Q5](../slackbot-design.md). Schedule it the same week the rest of Phase 5 lands.
- **Closer-access redirect** validates the role gating from `requireRole(["tenant_master","tenant_admin"])`. If it doesn't redirect, the role gate is misconfigured — block prod ship until fixed.
- **The stale digest dry-run is the most fragile** — confirm the digest channel is configured before invoking `fanOut`, or you'll see "no channel configured" no-ops. Force a configuration before testing if needed.

**Files touched:** None (pure verification + copy review).

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/slack/channels.ts` | Create | 5A |
| `convex/slack/channelsActions.ts` | Create | 5A |
| `convex/slack/notify.ts` | Modify (replace 3D stub) | 5B |
| `convex/slack/notifyData.ts` | Create | 5B |
| `convex/lib/slackBlockKit.ts` | Modify | 5B + 5C |
| `convex/schema.ts` | Modify | 5B |
| `convex/lib/domainEvents.ts` | Modify | 5B |
| `convex/lib/domainEventsInternal.ts` | Create if absent | 5B |
| `convex/lib/domainEventsAction.ts` | Create (if needed) | 5B |
| `convex/slack/staleReminders.ts` | Create | 5C |
| `convex/slack/staleRemindersData.ts` | Create | 5C |
| `convex/crons.ts` | Modify | 5C |
| `app/workspace/settings/_components/integrations/slack-integration-section.tsx` | Create | 5D |
| `app/workspace/settings/_components/integrations/slack-integration-card.tsx` | Create | 5D + 5E |
| `app/workspace/settings/_components/integrations/slack-integration-card-skeleton.tsx` | Create | 5D |
| `app/workspace/settings/_components/integrations/slack-channel-picker-dialog.tsx` | Create | 5E |
| `app/workspace/settings/_components/settings-page-client.tsx` | Modify | 5D |
| (manual QA + copy review) | Verify | 5F |
