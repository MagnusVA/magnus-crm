# Phase 6 — Lifecycle & Metrics

**Goal:** Land the lifecycle handlers (Slack-side `app_uninstalled` / `tokens_revoked` / `user_change` events + the URL-verification handshake), the reactivate path (a tenant re-OAuthing after a disconnect), the conversion-metrics queries, and the metrics dashboard cards. Set up alerting on the catastrophic refresh-write-fail signature, ship the final go-live checklist, and dogfood with one real tenant before opening to all tenants.

**Prerequisite:**
- Phase 1 complete: signing helpers, `slackInstallations` schema with `status` lifecycle literals, `oauthRedirect`, manifest published with `event_subscriptions.bot_events: [app_uninstalled, tokens_revoked, user_change]`.
- Phase 3 complete: `slackUsers.handleUserChange` mutation exists.
- Phase 5 complete: Integrations card displays status pills for `token_expired` / `revoked` / `uninstalled`, surfaces the Reconnect CTA, and has widened `domainEvents.entityType` to include `"slackInstallation"`.

**Runs in PARALLEL with:** Nothing — this is the final phase. Phase 5's Integrations card waits on 6A's lifecycle status updates to render correctly; Phase 6's metrics surfaces complement Phase 5's onboarding.

> **Final go-live phase.** Per [§9.4.3](../slackbot-design.md), this phase contains the go-live gate. Activating Public Distribution on prod is the last unblocked step before the feature is live to all tenants.

**Skills to invoke:**
- **`convex-performance-audit`** — **REQUIRED** before activating Public Distribution. Audit the hot-path slash-command route (sub-3s budget), the stale-reminder fan-out for read amplification, and the conversion metrics queries (which will be hit on every dashboard render). Per [§17](../slackbot-design.md): "After Phase 6 ships."
- **`frontend-design`** — for polishing the per-Slack-user dashboard card (avatar, display name, conversion ratio, sparkline if appropriate).
- **`web-design-guidelines`** — accessibility audit on the metrics cards (focus order, screen-reader labels for percentages, color-blind-friendly trend indicators).
- **`convex-create-component`** — *consider deferring* — once Phase 6 ships, evaluate whether the entire `slack/*` directory should be extracted as a Convex component for future Slack-app projects. Out of scope for v1 launch but a clean refactor target post-launch.

**Acceptance Criteria:**
1. POSTing a Slack `url_verification` payload to `/slack/events` returns `body.challenge` as `text/plain` 200 — completes the Events API handshake. (Slack only sends this once per manifest publish.)
2. POSTing a Slack `app_uninstalled` event to `/slack/events` resolves the row by `(team_id, api_app_id)`, flips `status` to `"uninstalled"`, sets `uninstalledAt`, and emits `slack.installation.uninstalled` with `entityType: "slackInstallation"`.
3. POSTing a Slack `tokens_revoked` event resolves the row by `(team_id, api_app_id)`, flips it to `"revoked"` (if not already `uninstalled`), and emits `slack.installation.tokens_revoked`.
4. Both `app_uninstalled` and `tokens_revoked` are idempotent terminal-state triggers. `tokens_revoked` alone produces `status: "revoked"`; `app_uninstalled` produces `status: "uninstalled"` and wins if both events arrive in either order.
5. POSTing a Slack `user_change` event for a known `slackUsers` row updates the profile fields (`displayName`, `realName`, `avatarUrl`, `isDeleted`) atomically. `user_change` for an unknown user is silently ignored (per [§14.9](../slackbot-design.md)).
6. After a `revoked` / `uninstalled` row exists, clicking "Reconnect" on the Integrations card walks the OAuth flow and successfully re-activates the row — `oauthRedirect` recognizes the existing row and patches it to `status: "active"` with a new token tuple.
7. If the Slack workspace tries to install on top of an existing `active` row whose `tenantId !== verifiedTenantId`, `oauthRedirect` rejects with `"Slack workspace already linked to another tenant"` (per [§9.2](../slackbot-design.md)).
8. `convex/slack/metrics.ts:conversionMetrics` query returns `{ total, booked, ratio, truncated }` for a date window using the `by_tenantId_and_source_and_createdAt` index and 1000-row cap; the admin dashboard shows Slack-qualified total, conversion ratio, and per-user breakdown while `/workspace/closer` does not.
9. Log alerting fires on `[Slack:Tokens] CATASTROPHIC refresh-write-fail` — verified by manually emitting the log line in dev and observing the alert hit (e.g. test webhook).
10. After dogfooding with one real tenant for 1 week without P1 issues, including an explicitly backdated stale-lead digest test, Public Distribution is activated on the prod Slack app and `pnpm tsc --noEmit` passes.

---

## Subphase Dependency Graph

```
6A (events handler) ────────────────────┐
                                         ├── 6B (reactivate flow in oauthRedirect) ──┐
                                         │                                            │
6C (metrics queries) ────────────────────┤                                            │
                                         │                                            ├── 6E (alerts + dogfood + go-live)
6D (metrics cards — frontend) ───────────┤                                            │
                                         │                                            │
                                         └────────────────────────────────────────────┘
```

**Optimal execution:**
1. **6A** + **6C** + **6D** can start in parallel (events handler / queries / frontend cards — all separate files).
2. **6B** depends on 6A — both touch the lifecycle code paths in `convex/slack/installations.ts` and `convex/slack/oauth.ts`.
3. **6E** (alerting setup, dogfood, final go-live activation) gates on all of 6A–6D being deployed and passing manual QA.

**Estimated time:** 4–6 days. Code is moderate (~400 LOC). The dogfood week is calendar time, not engineering time — schedule it at the start of the phase so the week elapses while final polish happens.

---

## Subphases

### 6A — `/slack/events` Lifecycle Handler

**Type:** Backend
**Parallelizable:** Yes — independent of 6C, 6D.

**What:** Implement the `convex/slack/events.ts:handleEvent` `httpAction`. Verifies HMAC, handles four payload shapes:
1. `type: "url_verification"` — echoes `body.challenge` as text/plain 200.
2. `event.type: "app_uninstalled"` — flips installation status to `uninstalled`, idempotently.
3. `event.type: "tokens_revoked"` — flips to `revoked` (if not already `uninstalled`), idempotently.
4. `event.type: "user_change"` — calls `slackUsers.handleUserChange` (Phase 3 3E).

Plus add three internal mutations in `convex/slack/installations.ts`: `markUninstalled`, `markRevoked`, and `reactivate` (called by 6B).

**Why:** Per [§9.1](../slackbot-design.md), Slack delivers `app_uninstalled` and `tokens_revoked` on uninstall — but **delivery order is not guaranteed**. Both events idempotently trigger terminal install states, with `uninstalled` winning over `revoked` if both arrive. Per [§13.4](../slackbot-design.md), the URL-verification handshake is a one-shot Slack-side health check that fires the moment the manifest is published; it must echo `body.challenge` or Slack disables event delivery.

**Where:**
- `convex/slack/events.ts` (new)
- `convex/slack/installations.ts` (modify — add `markUninstalled`, `markRevoked`, `reactivate`)
- `convex/http.ts` (modify — register the route)

**How:**

**Step 1: Implement the events handler**

```typescript
// Path: convex/slack/events.ts
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { verifySlackSignature } from "../lib/slackSignature";
import { persistRawSlackEvent } from "./rawEventsAudit";
import { emitDomainEventInAction } from "../lib/domainEventsAction";

const SIG_HEADER = "x-slack-signature";
const TS_HEADER = "x-slack-request-timestamp";

/**
 * `/slack/events` POST handler.
 * Per .docs/slack/events-api.md.
 *
 * Three payload shapes:
 *   1. url_verification (one-shot at manifest publish; echo body.challenge)
 *   2. event_callback with event.type ∈ { app_uninstalled, tokens_revoked, user_change }
 *   3. (everything else logged + 200 — Slack does not retry on 200)
 *
 * 3-second ack budget applies same as commands/interactivity. We do all writes
 * inside the request lifecycle because Slack expects 200 within 3s; lifecycle
 * mutations are tiny (1–2 patches each).
 */
export const handleEvent = httpAction(async (ctx, req) => {
  const rawBody = await req.text();

  const ok = verifySlackSignature({
    rawBody,
    timestamp: req.headers.get(TS_HEADER) ?? "",
    signature: req.headers.get(SIG_HEADER) ?? "",
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
    previousSigningSecret: process.env.SLACK_SIGNING_SECRET_PREVIOUS,
  });
  if (!ok) {
    console.warn("[Slack:Events] bad signature");
    return new Response("Bad signature", { status: 401 });
  }

  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    console.warn("[Slack:Events] body not JSON");
    return new Response("Bad request", { status: 400 });
  }

  // ── 1. URL verification handshake ───────────────────────────────────────
  if (body.type === "url_verification") {
    await persistRawSlackEvent(ctx, {
      teamId: body.team_id ?? "",
      apiAppId: body.api_app_id ?? undefined,
      eventType: "url_verification",
      rawBody,
      parsedPayload: body,
    });
    console.log("[Slack:Events] url_verification handshake");
    return new Response(body.challenge ?? "", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // ── 2. event_callback envelope ──────────────────────────────────────────
  if (body.type !== "event_callback") {
    console.log("[Slack:Events] ignored top-level type", { type: body.type });
    return new Response("", { status: 200 });
  }

  const teamId = (body.team_id ?? body.team?.id ?? "") as string;
  const appId = (body.api_app_id ?? "") as string;
  const evt = body.event;
  const evtType = evt?.type as string | undefined;
  if (!teamId || !appId) {
    console.warn("[Slack:Events] missing team_id/api_app_id", { teamId, appId, evtType });
    return new Response("", { status: 200 });
  }

  // Audit (await helper enqueue/write; never fire-and-forget).
  await persistRawSlackEvent(ctx, {
    teamId,
    apiAppId: appId || undefined,
    eventType: `event_callback:${evtType ?? "unknown"}`,
    rawBody,
    parsedPayload: body,
    slackEventId: body.event_id,
  });

  // ── 3. Branch on event.type ─────────────────────────────────────────────
  if (evtType === "app_uninstalled") {
    const rows = await ctx.runMutation(
      internal.slack.installations.markUninstalled,
      { teamId, appId },
    );
    for (const row of rows) {
      await emitDomainEventInAction(ctx, {
        tenantId: row.tenantId,
        entityType: "slackInstallation",
        entityId: row.installationId,
        eventType: "slack.installation.uninstalled",
        source: "system",
        occurredAt: Date.now(),
        metadata: { teamId, appId, previousStatus: row.previousStatus },
      });
    }
    console.log("[Slack:Events] app_uninstalled", { teamId });
    return new Response("", { status: 200 });
  }

  if (evtType === "tokens_revoked") {
    const rows = await ctx.runMutation(
      internal.slack.installations.markRevoked,
      { teamId, appId },
    );
    for (const row of rows) {
      await emitDomainEventInAction(ctx, {
        tenantId: row.tenantId,
        entityType: "slackInstallation",
        entityId: row.installationId,
        eventType: "slack.installation.tokens_revoked",
        source: "system",
        occurredAt: Date.now(),
        metadata: { teamId, appId, previousStatus: row.previousStatus },
      });
    }
    console.log("[Slack:Events] tokens_revoked", { teamId });
    return new Response("", { status: 200 });
  }

  if (evtType === "user_change") {
    if (!evt.user) {
      console.warn("[Slack:Events] user_change without user payload");
      return new Response("", { status: 200 });
    }
    const inst = await ctx.runQuery(internal.slack.installations.byTeamIdAndAppId, {
      teamId,
      appId,
    });
    if (!inst || inst.status !== "active") {
      console.log("[Slack:Events] user_change ignored — installation inactive/missing", {
        teamId,
        appId,
        status: inst?.status,
      });
      return new Response("", { status: 200 });
    }
    await ctx.runMutation(internal.slack.users.handleUserChange, {
      installationId: inst._id,
      userPayload: evt.user,
    });
    console.log("[Slack:Events] user_change applied", {
      teamId, appId, userId: evt.user.id,
    });
    return new Response("", { status: 200 });
  }

  console.log("[Slack:Events] ignored event.type", { evtType });
  return new Response("", { status: 200 });
});
```

**Step 2: Add the lifecycle mutations to `installations.ts`**

```typescript
// Path: convex/slack/installations.ts (additions)

/**
 * Mark the installation for `(teamId, appId)` as `uninstalled`. Idempotent.
 * Order-tolerant: if `tokens_revoked` already flipped status to `revoked`,
 * `app_uninstalled` overrides it (uninstalled is the most-final state).
 */
export const markUninstalled = internalMutation({
  args: { teamId: v.string(), appId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("slackInstallations")
      .withIndex("by_teamId_and_appId", (q) =>
        q.eq("teamId", args.teamId).eq("appId", args.appId))
      .unique();
    if (!row) return [];

    const now = Date.now();
    const affected = [{
      tenantId: row.tenantId,
      installationId: row._id,
      previousStatus: row.status,
    }];
    // Idempotent — only patch if not already uninstalled.
    if (row.status !== "uninstalled") {
      await ctx.db.patch(row._id, {
        status: "uninstalled",
        uninstalledAt: now,
        // Clear sensitive tokens — bot is no longer authorized.
        botAccessToken: "",
        refreshToken: "",
        refreshLockHolder: undefined,
        refreshLockAcquiredAt: undefined,
      });
    }
    return affected;
  },
});

/**
 * Mark the installation for `(teamId, appId)` as `revoked`.
 * Order-tolerant: if `app_uninstalled` already flipped to `uninstalled`,
 * leave it alone — uninstalled is the more-specific state.
 */
export const markRevoked = internalMutation({
  args: { teamId: v.string(), appId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("slackInstallations")
      .withIndex("by_teamId_and_appId", (q) =>
        q.eq("teamId", args.teamId).eq("appId", args.appId))
      .unique();
    if (!row) return [];

    const now = Date.now();
    const affected = [{
      tenantId: row.tenantId,
      installationId: row._id,
      previousStatus: row.status,
    }];
    // Don't downgrade an `uninstalled` row to `revoked`; idempotent if already revoked.
    if (row.status !== "uninstalled" && row.status !== "revoked") {
      await ctx.db.patch(row._id, {
        status: "revoked",
        uninstalledAt: now,                       // re-use as "lifecycle ended at"
        botAccessToken: "",
        refreshToken: "",
        refreshLockHolder: undefined,
        refreshLockAcquiredAt: undefined,
      });
    }
    return affected;
  },
});

/**
 * Re-activate an existing installation row with a fresh token tuple.
 * Called by Phase 6B's reinstall branch in `oauthRedirect`.
 */
export const reactivate = internalMutation({
  args: {
    id: v.id("slackInstallations"),
    botAccessToken: v.string(),
    refreshToken: v.string(),
    tokenExpiresAt: v.number(),
    scopes: v.array(v.string()),
    botUserId: v.string(),
    appId: v.string(),
    installedByWorkosUserId: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      status: "active",
      botAccessToken: args.botAccessToken,
      refreshToken: args.refreshToken,
      tokenExpiresAt: args.tokenExpiresAt,
      scopes: args.scopes,
      botUserId: args.botUserId,
      appId: args.appId,
      installedByWorkosUserId: args.installedByWorkosUserId,
      lastRefreshedAt: undefined,
      refreshLockHolder: undefined,
      refreshLockAcquiredAt: undefined,
      uninstalledAt: undefined,
    });
  },
});
```

**Step 3: Register the route in `http.ts`**

```typescript
// Path: convex/http.ts (modify)

import { handleEvent } from "./slack/events";   // NEW

http.route({
  path: "/slack/events",
  method: "POST",
  handler: handleEvent,
});
```

**Step 4: Verify**

In dev:

```bash
# 1. URL verification handshake — Slack only sends this once per manifest publish.
#    Re-trigger by re-pasting the manifest in the Slack App Config UI.
#    Watch logs for "[Slack:Events] url_verification handshake".

# 2. Test app_uninstalled by uninstalling the bot from the dev Slack workspace:
#    Slack workspace settings → Apps → Magnus CRM (dev) → Remove → Confirm.
#    Within ~5 seconds, Convex logs should show:
#      [Slack:Events] app_uninstalled { teamId: 'T...' }
#      [Slack:Events] tokens_revoked { teamId: 'T...' }
#    (Either order; both fire.)
npx convex data slackInstallations | grep <teamId>
#    status: "uninstalled" (since uninstalled wins over revoked).

# 3. Test user_change by editing your Slack profile (display name, photo).
#    Slack pushes user_change immediately. Watch logs for:
#      [Slack:Events] user_change applied { teamId, appId, userId }
npx convex data slackUsers | head
#    The patched row's displayName / avatarUrl reflect the change.
```

**Key implementation notes:**
- **Order-tolerance is the entire point of the design.** Slack does not guarantee `app_uninstalled` arrives before or after `tokens_revoked`. Treating both as idempotent triggers + having `uninstalled` win over `revoked` (because uninstalled is strictly more terminal) gives consistent end state regardless of arrival order.
- **Lifecycle domain events use real tenant IDs.** `markUninstalled` / `markRevoked` return the matched installation rows, and the action emits one domain event per row using `row.tenantId`. Do not use placeholder tenant IDs; `domainEvents` is tenant-scoped and must remain queryable by tenant.
- **`url_verification` returns `text/plain`**, not JSON. Slack expects the raw challenge string. Returning JSON breaks the handshake.
- **`user_change` for unknown users is ignored at the mutation layer** ([§14.9](../slackbot-design.md)) — the events handler always passes through to `handleUserChange`; the mutation's filter is the gate.
- **`event.user` is the full `users.info`-shaped object.** No need for a follow-up `users.info` call after `user_change` — Slack pushes the data we'd otherwise fetch.
- **`reactivate` clears `botAccessToken: ""` first via `markUninstalled`/`markRevoked`, then re-fills via the new tuple.** A brief intermediate state has the empty token; if a slash command arrived in that window, it'd correctly fail the `status !== "active"` check in 2C.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/slack/events.ts` | Create | The events handler |
| `convex/slack/installations.ts` | Modify | Add `markUninstalled`, `markRevoked`, `reactivate` |
| `convex/http.ts` | Modify | Register `/slack/events` POST route |

---

### 6B — Reactivate Flow in `oauthRedirect`

**Type:** Backend
**Parallelizable:** No — depends on 6A's `reactivate` mutation. Tiny diff.

**What:** Modify `convex/slack/oauth.ts:oauthRedirect` (Phase 1 1E) so it distinguishes three reinstall paths per [§9.2](../slackbot-design.md):

1. **No existing row** — call `upsertOnInstall` (current behavior).
2. **Existing row, same tenant** in `uninstalled` / `revoked` / `token_expired` — call `reactivate` with the new tuple.
3. **Existing row, different tenant** — throw `"Slack workspace already linked to another tenant"`.

**Why:** Without this branch, a tenant who uninstalls and re-installs would get `upsertOnInstall`'s "tenantId mismatch" path (because the existing row isn't for them) — which would throw the wrong error. Or worse, silently insert a duplicate row.

**Where:**
- `convex/slack/oauth.ts` (modify — within `oauthRedirect`)

**How:**

**Step 1: Adjust `oauthRedirect` to branch on existing row**

```typescript
// Path: convex/slack/oauth.ts (within oauthRedirect; modify the upsert section)

// Locate (Phase 1):
//   await ctx.runMutation(internal.slack.installations.upsertOnInstall, { ... });

// REPLACE that single mutation call with a discriminating branch:

const existing = await ctx.runQuery(internal.slack.installations.byTeamIdAndAppId, {
  teamId: data.team.id,
  appId: data.app_id!,
});

if (existing) {
  // Same workspace already known.
  if (existing.tenantId !== state.tenantId) {
    console.error("[Slack:OAuth] cross-tenant install attempt", {
      existingTenantId: existing.tenantId,
      attemptingTenantId: state.tenantId,
      teamId: data.team.id,
    });
    return new Response(
      "This Slack workspace is already connected to a different CRM tenant. Contact support to reassign.",
      { status: 409 },
    );
  }

  if (existing.status === "active") {
    // Already active. Could be a refresh-via-OAuth scenario — patch tokens.
    await ctx.runMutation(internal.slack.installations.reactivate, {
      id: existing._id,
      botAccessToken: data.access_token,
      refreshToken: data.refresh_token,
      tokenExpiresAt: Date.now() + (data.expires_in ?? 43_200) * 1000,
      scopes: (data.scope ?? "").split(",").filter(Boolean),
      botUserId: data.bot_user_id!,
      appId: data.app_id!,
      installedByWorkosUserId: state.workosUserId,
    });
    console.log("[Slack:OAuth] active row re-OAuth'd", { id: existing._id });
  } else if (
    existing.status === "uninstalled" ||
    existing.status === "revoked" ||
    existing.status === "token_expired"
  ) {
    // Reinstall — patch the row to active with the fresh tuple.
    await ctx.runMutation(internal.slack.installations.reactivate, {
      id: existing._id,
      botAccessToken: data.access_token,
      refreshToken: data.refresh_token,
      tokenExpiresAt: Date.now() + (data.expires_in ?? 43_200) * 1000,
      scopes: (data.scope ?? "").split(",").filter(Boolean),
      botUserId: data.bot_user_id!,
      appId: data.app_id!,
      installedByWorkosUserId: state.workosUserId,
    });
    console.log("[Slack:OAuth] reinstall reactivated row", {
      id: existing._id,
      previousStatus: existing.status,
    });
  }
} else {
  // Fresh install — upsert path (Phase 1 behavior, unchanged).
  await ctx.runMutation(internal.slack.installations.upsertOnInstall, {
    tenantId: state.tenantId,
    teamId: data.team.id,
    teamName: data.team.name,
    enterpriseId: data.enterprise?.id,
    isEnterpriseInstall: Boolean(data.is_enterprise_install),
    appId: data.app_id!,
    botUserId: data.bot_user_id!,
    botAccessToken: data.access_token,
    refreshToken: data.refresh_token,
    tokenExpiresAt: Date.now() + (data.expires_in ?? 43_200) * 1000,
    scopes: (data.scope ?? "").split(",").filter(Boolean),
    installedByWorkosUserId: state.workosUserId,
  });
}

// Continue to redirect — unchanged. This is Convex code, so use APP_URL.
const dest = new URL(`${process.env.APP_URL!}/workspace/settings`);
dest.searchParams.set("tab", "integrations");
dest.searchParams.set("slack", "connected");
// pickChannel param: only suggest if the row has no notify channel configured yet.
const needsChannelPicker = existing
  ? !existing.notifyChannelId
  : true;
if (needsChannelPicker) dest.searchParams.set("pickChannel", "true");
return Response.redirect(dest.toString(), 302);
```

**Step 2: Verify `byTeamIdAndAppId` already exists**

```typescript
// Path: convex/slack/installations.ts (created in Phase 1; verify unchanged)

export const byTeamIdAndAppId = internalQuery({
  args: { teamId: v.string(), appId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("slackInstallations")
      .withIndex("by_teamId_and_appId", (q) =>
        q.eq("teamId", args.teamId).eq("appId", args.appId))
      .unique();
  },
});
```

Do not add a second `byTeamIdAndAppId` export in Phase 6. If it is missing, stop and patch Phase 1/1E first because Phase 2 inbound handlers already depend on it.

**Step 3: Verify**

```bash
# In the dev Slack workspace:
# 1. Uninstall the app (Slack settings → Apps → Magnus CRM (dev) → Remove).
# 2. Wait ~5s for app_uninstalled event to land.
# 3. Verify in Convex: status "uninstalled".
# 4. Click "Reconnect" on the Integrations card.
# 5. Walk OAuth.
# 6. Land on /workspace/settings?tab=integrations&slack=connected (no pickChannel — channel was already set).
# 7. Verify in Convex: same row's status flipped to "active", new token tuple.
```

Cross-tenant rejection test:

```bash
# This is harder to set up — requires two CRM tenants both attempting to install
# into the same Slack workspace. If you have a second test tenant:
# 1. Tenant A connects to Slack workspace W1.
# 2. Tenant B starts the install flow against W1 (workspace admin would have to approve again,
#    which Slack doesn't permit cleanly, so this scenario is rare in practice).
# 3. Verify the redirect handler responds 409 with the explanatory text.
```

**Key implementation notes:**
- **`pickChannel=true` only suggests the dialog when channels aren't yet configured.** Reinstalling a workspace that already had channels reuses the configuration — no need to re-pick. The Integrations card UI auto-opens the dialog only when `pickChannel=true`.
- **`reactivate` is called both for `active`-row re-OAuth and reinstall paths.** This is intentional — the operation is the same (replace tokens, ensure active status). The log message differentiates.
- **The cross-tenant 409 returns a human-readable string**, not JSON. Slack's UI doesn't show response bodies on OAuth failures; the user sees a generic browser error. The Integrations card on the *attempting* tenant's CRM should detect this scenario via a status query and surface a more useful message — but for v1, the 409 is the structural defense.
- **`existing.status === "active"` re-OAuth path** handles the rare case of a tenant clicking Reconnect on an already-active integration. Updating the tuple is harmless — Slack's response includes a fresh access_token + refresh_token, and the next refresh is suppressed because the new `tokenExpiresAt` is way in the future.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/slack/oauth.ts` | Modify | Replace single `upsertOnInstall` with branched reinstall logic |
| `convex/slack/installations.ts` | Verify | `byTeamIdAndAppId` already exists from Phase 1 |

---

### 6C — Conversion Metrics Queries

**Type:** Backend
**Parallelizable:** Yes — independent of 6A, 6B, 6D (different files).

**What:** Three queries in `convex/slack/metrics.ts`:
1. `conversionMetrics(windowStart, windowEnd)` — Slack-qualified total + booked count + ratio + truncated flag for a date range.
2. `perSlackUserBreakdown(windowStart, windowEnd)` — group by `qualifiedBy.slackUserId`, joined to `slackUsers` for display.
3. `perPlatformConversion(windowStart, windowEnd)` — group by primary `leadIdentifiers.type`.

All gated by `requireTenantUser(["tenant_master", "tenant_admin"])`.

**Why:** Per [§9.3](../slackbot-design.md), these are the metrics surfaces that justify the feature. The "Slack-qualified → booked" conversion ratio is *the* number that proves the feature's value.

> **Performance note:** v1 implements these as in-mutation queries with a 1000-row cap. Per [§9.3](../slackbot-design.md): "MVP bound; replace with aggregates before larger tenant rollout." The dashboard treats `truncated: true` as a signal to show "window too large." Phase 6's `convex-performance-audit` invocation will produce the aggregate-replacement plan.

**Where:**
- `convex/slack/metrics.ts` (new)

**How:**

**Step 1: Implement `conversionMetrics`**

```typescript
// Path: convex/slack/metrics.ts

import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

const ROW_CAP = 1000;

export const conversionMetrics = query({
  args: {
    windowStart: v.number(),     // epoch ms — inclusive
    windowEnd: v.number(),       // epoch ms — exclusive
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const opps = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_source_and_createdAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("source", "slack_qualified")
          .gte("createdAt", args.windowStart)
          .lt("createdAt", args.windowEnd))
      .take(ROW_CAP);

    const total = opps.length;
    const truncated = total === ROW_CAP;
    const booked = opps.filter((o) => o.latestMeetingId !== undefined).length;
    const lost = opps.filter((o) => o.status === "lost").length;
    const stillPending = opps.filter((o) => o.status === "qualified_pending").length;

    return {
      total,
      booked,
      lost,
      stillPending,
      ratio: total === 0 ? null : booked / total,
      truncated,
      windowStart: args.windowStart,
      windowEnd: args.windowEnd,
    };
  },
});
```

> **Note on the index:** these metrics intentionally use the existing `by_tenantId_and_source_and_createdAt` index because conversion math needs all Slack-qualified statuses in the same window. Do not use the status-scoped `by_tenantId_and_source_and_status_and_createdAt` index here unless you split the query per status and merge the bounded results.

**Step 2: Implement `perSlackUserBreakdown`**

```typescript
// Path: convex/slack/metrics.ts (continues)

export const perSlackUserBreakdown = query({
  args: {
    windowStart: v.number(),
    windowEnd: v.number(),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const opps = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_source_and_createdAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("source", "slack_qualified")
          .gte("createdAt", args.windowStart)
          .lt("createdAt", args.windowEnd))
      .take(ROW_CAP);

    // Group by slackUserId
    const counts = new Map<string, { total: number; booked: number }>();
    for (const o of opps) {
      const key = o.qualifiedBy?.slackUserId;
      if (!key) continue;
      const cur = counts.get(key) ?? { total: 0, booked: 0 };
      cur.total += 1;
      if (o.latestMeetingId !== undefined) cur.booked += 1;
      counts.set(key, cur);
    }

    // Hydrate display info from slackUsers.
    const result: {
      slackUserId: string;
      displayName: string | null;
      avatarUrl: string | null;
      total: number;
      booked: number;
      ratio: number | null;
    }[] = [];
    for (const [slackUserId, c] of counts) {
      const user = await ctx.db
        .query("slackUsers")
        .withIndex("by_tenantId_and_slackUserId", (q) =>
          q.eq("tenantId", tenantId).eq("slackUserId", slackUserId))
        .unique();
      result.push({
        slackUserId,
        displayName:
          user?.displayName ?? user?.realName ?? user?.username ?? null,
        avatarUrl: user?.avatarUrl ?? null,
        total: c.total,
        booked: c.booked,
        ratio: c.total === 0 ? null : c.booked / c.total,
      });
    }
    // Sort: highest total first.
    result.sort((a, b) => b.total - a.total);

    return {
      rows: result.slice(0, 25),       // top 25 contributors
      truncated: opps.length === ROW_CAP,
    };
  },
});
```

**Step 3: Implement `perPlatformConversion`**

```typescript
// Path: convex/slack/metrics.ts (continues)

import { SOCIAL_PLATFORMS, SOCIAL_PLATFORM_LABELS } from "../lib/socialPlatform";

export const perPlatformConversion = query({
  args: {
    windowStart: v.number(),
    windowEnd: v.number(),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const opps = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_source_and_createdAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("source", "slack_qualified")
          .gte("createdAt", args.windowStart)
          .lt("createdAt", args.windowEnd))
      .take(ROW_CAP);

    // For each opp, look up the primary social identifier by leadId.
    const platformCounts: Record<string, { total: number; booked: number }> =
      Object.fromEntries(
        SOCIAL_PLATFORMS.map((p) => [p, { total: 0, booked: 0 }] as const),
      );

    for (const o of opps) {
      const idents = await ctx.db
        .query("leadIdentifiers")
        .withIndex("by_leadId", (q) => q.eq("leadId", o.leadId))
        .take(10);
      const social = idents
        .filter((i) =>
          ["instagram", "tiktok", "twitter", "facebook", "linkedin", "other_social"].includes(i.type))
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      if (!social) continue;
      const bucket = platformCounts[social.type];
      if (!bucket) continue;
      bucket.total += 1;
      if (o.latestMeetingId !== undefined) bucket.booked += 1;
    }

    return {
      rows: SOCIAL_PLATFORMS.map((p) => {
        const c = platformCounts[p];
        return {
          platform: p,
          label: SOCIAL_PLATFORM_LABELS[p],
          total: c.total,
          booked: c.booked,
          ratio: c.total === 0 ? null : c.booked / c.total,
        };
      }).filter((r) => r.total > 0)
        .sort((a, b) => b.total - a.total),
      truncated: opps.length === ROW_CAP,
    };
  },
});
```

**Step 4: Verify**

```bash
# Path: terminal
npx convex run slack/metrics:conversionMetrics \
  '{"windowStart": 0, "windowEnd": 9999999999999}' --auth-id <admin>
# Returns { total, booked, ratio, truncated, ... }

npx convex run slack/metrics:perSlackUserBreakdown \
  '{"windowStart": 0, "windowEnd": 9999999999999}' --auth-id <admin>
```

**Step 5: Invoke `convex-performance-audit`**

Per [§17](../slackbot-design.md), this is the moment to run the audit:

> "After Phase 6 ships — audit the hot-path slash-command route (sub-3s budget) and the stale-reminder fan-out for read amplification."

Specifically focus the audit on:
- `conversionMetrics` query — does it hit `by_tenantId_and_source_and_createdAt`, and does the 1000-row cap keep dashboard renders bounded?
- `perPlatformConversion` — the per-opp `leadIdentifiers` lookup is O(opps) reads; for tenants with many opportunities, this is expensive. Consider caching the primary identifier on `opportunities` directly (denormalization).
- The slash-command path latency under realistic load.

The audit's output may produce a v1.1 follow-up plan (e.g. denormalize identifier → opportunity, or build a real aggregate table). For v1 launch, the 1000-row cap is sufficient.

**Key implementation notes:**
- **`truncated: boolean`** is the signal to the frontend to suggest a narrower window. Don't render a misleading partial number.
- **`booked` uses `latestMeetingId !== undefined`** — for Slack-qualified opps, `latestMeetingId` is set when Phase 4's join happens (because the new meeting is inserted, then `updateOpportunityMeetingRefs` patches `latestMeetingId`). This is a clean structural signal that the opp has converted.
- **`stillPending` and `lost`** are exposed so the dashboard can break down the funnel: "1000 qualified → 600 booked, 200 still pending, 200 lost."
- **`perSlackUserBreakdown` joins to `slackUsers` for display.** Slack-side names refresh via `user_change` (3E + 6A); the UI always reads the live name without retroactive copying.
- **`perPlatformConversion` is the most read-heavy** — bounded by `ROW_CAP` × identifier-fetches. Acceptable for v1; revisit post-audit.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/slack/metrics.ts` | Create | Three queries + helpers |

---

### 6D — Frontend: Metrics Cards

**Type:** Frontend (RSC + client component)
**Parallelizable:** Yes — depends on 6C. Independent of 6A/6B.

**What:** Three new cards on the admin dashboard at `/workspace`:
1. `<SlackQualifiedTotalCard>` — total Slack-qualified leads in the date window, with WoW / MoM trend if data permits.
2. `<SlackConversionRatioCard>` — booked / total ratio with a small donut or sparkline.
3. `<SlackUserLeaderboardCard>` — top 5 Slack contributors with avatar + display name + booked-of-total.

Hidden from `closer` role per [§9.3](../slackbot-design.md) and [§13.3](../slackbot-design.md).

**Why:** These are the user-visible payoff for the entire feature build. Without them, no one sees the conversion number. Per [§17](../slackbot-design.md), the `frontend-design` skill polishes the per-Slack-user card; `web-design-guidelines` audits accessibility.

**Where:**
- `app/workspace/_components/skeletons/slack-metrics-skeleton.tsx` (new)
- `app/workspace/_components/dashboard/slack-metrics-section.tsx` (new) — RSC
- `app/workspace/_components/dashboard/slack-qualified-total-card.tsx` (new)
- `app/workspace/_components/dashboard/slack-conversion-ratio-card.tsx` (new)
- `app/workspace/_components/dashboard/slack-user-leaderboard-card.tsx` (new)
- `app/workspace/page.tsx` (modify — add the section to admin view)

**How:**

**Step 1: Build the RSC section**

```tsx
// Path: app/workspace/_components/dashboard/slack-metrics-section.tsx

import { preloadQuery } from "convex/nextjs";
import { Suspense } from "react";
import { api } from "@/convex/_generated/api";
import { getAccessToken } from "@/lib/auth";
import { SlackQualifiedTotalCard } from "./slack-qualified-total-card";
import { SlackConversionRatioCard } from "./slack-conversion-ratio-card";
import { SlackUserLeaderboardCard } from "./slack-user-leaderboard-card";
import { SlackMetricsSkeleton } from "../skeletons/slack-metrics-skeleton";
import { SectionErrorBoundary } from "../section-error-boundary";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export async function SlackMetricsSection() {
  const token = await getAccessToken();
  const now = Date.now();
  const args = { windowStart: now - THIRTY_DAYS_MS, windowEnd: now };

  const [conv, breakdown] = await Promise.all([
    preloadQuery(api.slack.metrics.conversionMetrics, args, { token }),
    preloadQuery(api.slack.metrics.perSlackUserBreakdown, args, { token }),
  ]);

  return (
    <SectionErrorBoundary sectionName="Slack metrics">
      <Suspense fallback={<SlackMetricsSkeleton />}>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <SlackQualifiedTotalCard preloadedConv={conv} />
          <SlackConversionRatioCard preloadedConv={conv} />
          <SlackUserLeaderboardCard preloadedBreakdown={breakdown} />
        </div>
      </Suspense>
    </SectionErrorBoundary>
  );
}
```

**Step 2: Build the three cards (sketches; polish via `frontend-design`)**

```tsx
// Path: app/workspace/_components/dashboard/slack-qualified-total-card.tsx
"use client";

import { usePreloadedQuery } from "convex/react";
import type { Preloaded } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Slack } from "lucide-react";

type Props = {
  preloadedConv: Preloaded<typeof api.slack.metrics.conversionMetrics>;
};

export function SlackQualifiedTotalCard({ preloadedConv }: Props) {
  const conv = usePreloadedQuery(preloadedConv);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Slack className="size-4" aria-hidden /> Slack-qualified (30d)
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-semibold">
          {conv.total.toLocaleString()}
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          {conv.stillPending > 0
            ? `${conv.stillPending} still pending`
            : "All booked or closed"}
          {conv.truncated && (
            <span className="ml-1 text-amber-700">• window too large</span>
          )}
        </p>
      </CardContent>
    </Card>
  );
}
```

```tsx
// Path: app/workspace/_components/dashboard/slack-conversion-ratio-card.tsx
"use client";

import { usePreloadedQuery } from "convex/react";
import type { Preloaded } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Props = {
  preloadedConv: Preloaded<typeof api.slack.metrics.conversionMetrics>;
};

export function SlackConversionRatioCard({ preloadedConv }: Props) {
  const conv = usePreloadedQuery(preloadedConv);
  const pct = conv.ratio === null ? null : Math.round(conv.ratio * 100);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Conversion ratio (30d)</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-semibold">
          {pct === null ? "—" : `${pct}%`}
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          {conv.booked.toLocaleString()} of {conv.total.toLocaleString()} qualified
          → booked
        </p>
      </CardContent>
    </Card>
  );
}
```

```tsx
// Path: app/workspace/_components/dashboard/slack-user-leaderboard-card.tsx
"use client";

import { usePreloadedQuery } from "convex/react";
import type { Preloaded } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

type Props = {
  preloadedBreakdown: Preloaded<typeof api.slack.metrics.perSlackUserBreakdown>;
};

export function SlackUserLeaderboardCard({ preloadedBreakdown }: Props) {
  const breakdown = usePreloadedQuery(preloadedBreakdown);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Top Slack qualifiers (30d)</CardTitle>
      </CardHeader>
      <CardContent>
        {breakdown.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No Slack qualifications yet.
          </p>
        ) : (
          <ul className="space-y-2 text-sm">
            {breakdown.rows.slice(0, 5).map((row) => (
              <li key={row.slackUserId} className="flex items-center gap-3">
                <Avatar className="size-7">
                  <AvatarImage src={row.avatarUrl ?? undefined} />
                  <AvatarFallback>
                    {(row.displayName ?? row.slackUserId).slice(0, 1).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <p className="truncate font-medium">
                    {row.displayName ?? row.slackUserId}
                  </p>
                </div>
                <div className="text-right text-xs">
                  <div className="font-semibold">{row.total}</div>
                  <div className="text-muted-foreground">
                    {row.booked} booked
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
```

**Step 3: Build the skeleton**

```tsx
// Path: app/workspace/_components/skeletons/slack-metrics-skeleton.tsx

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function SlackMetricsSkeleton() {
  return (
    <div
      className="grid grid-cols-1 md:grid-cols-3 gap-4"
      role="status"
      aria-label="Loading Slack metrics"
    >
      {Array.from({ length: 3 }).map((_, i) => (
        <Card key={i}>
          <CardHeader className="pb-2"><Skeleton className="h-4 w-32" /></CardHeader>
          <CardContent>
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-3 w-40 mt-2" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
```

**Step 4: Wire into the admin dashboard**

Per [`AGENTS.md` § Three-layer page pattern](../../../AGENTS.md):

```tsx
// Path: app/workspace/page.tsx (modify)

import { SlackMetricsSection } from "./_components/dashboard/slack-metrics-section";

// In the existing dashboard structure, add the Slack metrics section.
// EXACT placement varies — locate near the existing admin metric cards.
//
// (Sketch — adjust to match the existing dashboard layout.)
<>
  {/* Existing dashboard cards */}
  <SlackMetricsSection />
</>
```

> **Closer dashboard:** the closer dashboard at `/workspace/closer` does NOT show these cards (per [§9.3](../slackbot-design.md) and [§13.3](../slackbot-design.md)). Slack metrics are admin-only.

**Step 5: Verify**

1. Sign in as `tenant_master` → `/workspace` → see three Slack cards with real numbers.
2. Sign in as `closer` → `/workspace/closer` → no Slack cards.
3. Click an avatar in the leaderboard — does it route somewhere meaningful (e.g. a filtered pipeline view)? If not, that's a v1.1 polish — leave the avatar non-clickable for v1.

**Step 6: Accessibility audit**

Run the `web-design-guidelines` skill against the three cards. Specifically check:
- Color contrast for the percentage and trend indicators.
- Screen-reader labels on the percentage card (`aria-label="35% conversion rate"` on the big number).
- Focus order through the leaderboard list.
- Skeleton's `role="status"` + `aria-label`.

Adjust per the audit's findings.

**Key implementation notes:**
- **30-day window is hard-coded.** A future v1.1 enhancement adds a date-range selector that re-fetches the queries reactively. v1 keeps it simple.
- **`SectionErrorBoundary` wraps the whole section** per AGENTS.md so a metrics-query failure doesn't kill the rest of the dashboard. Each card is in the same Suspense boundary because they share the same query — if one fails they all do, by design.
- **Leaderboard avatar fallback** uses the first letter of the display name (or the first letter of `slackUserId` if no name). Standard shadcn pattern.
- **`Slack` icon from lucide-react** — already imported in Phase 5's Integrations card. Reuse.
- **`Promise.all` of two `preloadQuery` calls** parallelizes the two queries on the server. Two RTTs become one wall-clock RTT.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/skeletons/slack-metrics-skeleton.tsx` | Create | Loading state |
| `app/workspace/_components/dashboard/slack-metrics-section.tsx` | Create | RSC wrapper |
| `app/workspace/_components/dashboard/slack-qualified-total-card.tsx` | Create | Total card |
| `app/workspace/_components/dashboard/slack-conversion-ratio-card.tsx` | Create | Ratio card |
| `app/workspace/_components/dashboard/slack-user-leaderboard-card.tsx` | Create | Leaderboard card |
| `app/workspace/page.tsx` | Modify | Add `<SlackMetricsSection />` |

---

### 6E — Alerting, Dogfood, and Final Go-Live Activation

**Type:** Manual (operations + product gate)
**Parallelizable:** No — final phase. Gates on 6A–6D being deployed.

**What:** Three sequential activities:
1. **Alerting setup** for the catastrophic refresh-write-fail signature ([§4.7.3](../slackbot-design.md), [§14.3](../slackbot-design.md)).
2. **Dogfood with one tenant** for at least one calendar week (per [§9.4.3](../slackbot-design.md) "Recommended Approach in the brainstorm").
3. **Activate Public Distribution** on the prod Slack app — the final unblocked step.

**Why:** Per the design's [§9.4 manual checklist](../slackbot-design.md), these are the ops-grade steps that turn "feature deployed" into "feature available to users." Skipping any of them risks the catastrophic scenarios catalogued in §14.

**Where:** No project files. External targets:
- The team's log alerting / paging tooling.
- The dogfood tenant's CRM + Slack workspace.
- The prod Slack App Config UI.

**How:**

**Step 1: Set up log alerting on `[Slack:Tokens] CATASTROPHIC refresh-write-fail`**

This was queued from Phase 1 1H Step 10 — confirm it's in place. The exact mechanism depends on your log forwarder (Datadog, BetterStack, native Convex log webhooks, etc.). The rule:

- **Match string:** literal `[Slack:Tokens] CATASTROPHIC refresh-write-fail`
- **Severity:** P1 (page; not just notify)
- **Frequency:** every occurrence (no debouncing)
- **Notification target:** the team's primary on-call channel + paging system

Verify the rule fires:

1. Manually trigger the log line in dev. The simplest reproducer is a temporary `internalAction`:
   ```typescript
   // Path: convex/slack/_temp_alertTest.ts (REMOVE after verification)
   import { internalAction } from "../_generated/server";
   export const fire = internalAction({
     args: {},
     handler: async () => {
       console.error(
         "[Slack:Tokens] CATASTROPHIC refresh-write-fail (TEST — disregard)",
         { test: true },
       );
     },
   });
   ```
2. Run it: `npx convex run slack/_temp_alertTest:fire`.
3. Within ~1 minute (or whatever the alerting pipeline's lag is), the alert should hit. If it doesn't, fix the rule before proceeding.
4. Delete the `_temp_alertTest.ts` file.

**Step 2: Set up secondary alerting**

Per [§9.4.2](../slackbot-design.md):
- **`status: "token_expired"` > 7 days** — likely an abandoned tenant. Useful for support outreach. Lower priority than P1.
- **Unexpected `processed: false` rows in `rawSlackEvents`** after each deploy. In v1 these should be rare because Slack requests process inline and persist as `processed: true`; set up a daily check that emits a metric if any false rows appear.
- **Heartbeat watch on the 08:00 ET stale-reminder cron** — defer to v1.1 unless missed digests become a noticed problem.

Each of these is a separate alerting rule; the team's log-tooling docs are the canonical source for setup syntax.

**Step 3: Dogfood with one real tenant**

Pick one tenant who:
- Is willing to be the first user (likely the team's own internal-use tenant or a friendly customer).
- Has a Slack workspace with multiple users who can run `/qualify-lead`.
- Has Calendly bookings happening at a normal rate so the join path gets exercised.

Walk them through:
1. Tenant admin connects Slack via the Integrations card (Phase 5).
2. They pick notify + stale-reminder channels.
3. Their team uses `/qualify-lead` over the course of a week.
4. Some leads book Calendly meetings (Phase 4 join exercises).
5. Backdate at least one dev/test `qualified_pending` opportunity to older than 30 days, then run/observe the stale digest. A one-week dogfood window cannot naturally validate a 30-day threshold without this seeded stale row.

Watch the metrics during the week:
- `npx convex data slackInstallations` — refresh tokens advancing on schedule, no `token_expired` rows.
- `npx convex data domainEvents | grep slack.notify.failed` — should be empty or very rare.
- The CATASTROPHIC log signature — should be empty.
- The Integrations card render correctness throughout (status pill matches actual state).

Daily (or as friction allows): check in with the dogfood tenant for qualitative feedback — copy issues, UX papercuts, rate-limit issues, etc. Track in a spreadsheet.

**Step 4: Address dogfood findings**

For every issue surfaced:
- **Showstopper** (e.g. dedup guard wrong, channel post fails 100%): block the prod Public Distribution activation. Fix, redeploy, re-dogfood.
- **Polish** (e.g. confirmation message copy, padding): file as v1.1 follow-up. Don't block launch.

This step takes ~1–2 days; budget accordingly.

**Step 5: Final go-live checklist (per [§9.4.3](../slackbot-design.md))**

- [ ] **All manual steps from §4.7.1 + §4.7.2 completed for the prod deployment.** Re-verify `token_rotation_enabled: true` rendered correctly on the prod app — last chance.
- [ ] **CI lint rule for `token_rotation_enabled`** (1I Step 1) merged + green on main.
- [ ] **Runbook entry** for refresh-write-fail (1I Step 2) published in the team's ops doc.
- [ ] **Alerting on `[Slack:Tokens] CATASTROPHIC refresh-write-fail`** verified (this subphase Step 1).
- [ ] **Dogfood tenant ran ≥ 1 week without P1 issues** (this subphase Step 3).
- [ ] **All manual QA from Phase 4C, 5F passing on prod** (re-run against prod, not just dev).
- [ ] **Public Distribution still NOT active** — keep flipped off until the very end.

When all checked: in Slack App Config → prod app → "Manage Distribution" → "Public Distribution" → **"Activate Public Distribution"**.

**Step 6: Post-launch monitoring (first 48 hours)**

For the first two days after Public Distribution is active:

- **Watch logs hourly** for `[Slack:Cmd]`, `[Slack:Int]`, `[Slack:Notify]`, `[Slack:Tokens]` patterns.
- **Watch `domainEvents`** for `slack.notify.failed` and `slack.installation.uninstalled` — anomalous volumes suggest a regression.
- **Watch the `refresh-slack-tokens` cron** — should produce a "[Slack:Tokens] cron tick { dueCount }" log every hour.
- **No CATASTROPHIC log lines** — if any fire, treat as a P1 incident immediately.

After 48h with clean signals, the launch is "done" — communicate completion to the team.

**Key implementation notes:**
- **The dogfood week is non-negotiable.** It's the only way to surface UX, copy, and rate-limit issues that synthetic testing won't find. Skipping it is the most common cause of post-launch regrets.
- **The Public Distribution toggle is the irreversible launch act.** Once flipped, third-party tenants can attempt installs at any time. There's no "soft-launch" beyond dogfood — the toggle is binary.
- **Post-launch monitoring is implicit ops work, not a separate phase.** Budget for it in the team's calendar.
- **Final go-live cannot be skipped if any earlier phase QA gate failed.** If Phase 4C or 5F has any ❌ entries unfixed, hold launch.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/slack/_temp_alertTest.ts` | Create + delete | Verify alerting rule fires |
| Team alerting / paging config (external) | Manual | Configure rules for CATASTROPHIC + secondary signatures |
| Dogfood tenant feedback log (external) | Manual | Daily checkpoints during dogfood week |
| Slack App Config (prod, external) | Manual | Activate Public Distribution at end of checklist |
| Team launch comms (external) | Manual | Communicate "launched" once 48h monitoring clean |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/slack/events.ts` | Create | 6A |
| `convex/slack/installations.ts` | Modify / verify | 6A lifecycle mutations; 6B verifies existing `byTeamIdAndAppId` |
| `convex/http.ts` | Modify | 6A (register `/slack/events`) |
| `convex/slack/oauth.ts` | Modify | 6B (reinstall branch) |
| `convex/slack/metrics.ts` | Create | 6C |
| `app/workspace/_components/skeletons/slack-metrics-skeleton.tsx` | Create | 6D |
| `app/workspace/_components/dashboard/slack-metrics-section.tsx` | Create | 6D |
| `app/workspace/_components/dashboard/slack-qualified-total-card.tsx` | Create | 6D |
| `app/workspace/_components/dashboard/slack-conversion-ratio-card.tsx` | Create | 6D |
| `app/workspace/_components/dashboard/slack-user-leaderboard-card.tsx` | Create | 6D |
| `app/workspace/page.tsx` | Modify | 6D |
| Team alerting config (external) | Manual | 6E |
| Dogfood feedback log (external) | Manual | 6E |
| Slack App Config — prod Public Distribution | Manual | 6E |
