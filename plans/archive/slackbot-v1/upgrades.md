# Slackbot v1 Upgrades

This file tracks intentionally deferred improvements discovered while building
Slackbot v1. These are **not** required for the initial end-to-end launch unless
a phase explicitly promotes them into scope.

---

## Upgrade S0 — Slack Message Auth-Aware CRM Deep Links

**Status:** Deferred after Phase 5 manual QA.

**Priority:** Medium after v1 ships. The current Slack buttons can link directly
to CRM opportunity pages, but the durable version should route through a server
entrypoint that understands the current user's session, role, and access.

**Related files / systems:**

- `convex/lib/slackBlockKit.ts`
- `convex/slack/notify.ts`
- `convex/slack/staleReminders.ts`
- Future `app/api/slack/open-opportunity/route.ts` or equivalent
- `lib/auth.ts`
- `app/workspace/opportunities/[opportunityId]/*`
- `app/workspace/closer/*`

### Problem

Slack messages are sent into a workspace context, not a CRM browser session. A
direct link such as `/workspace/opportunities/:id` only works correctly when the
recipient is already signed into the CRM and the route is appropriate for their
role. It also cannot distinguish between tenant admins, closers, unauthenticated
users, users from the wrong tenant, or users who no longer have access.

The v1 button can remain a simple direct opportunity link, but a production-grade
deep link should go through a Next.js route first.

### Goal

Replace direct Slack CRM links with an auth-aware redirect route, for example:

```text
/api/slack/open-opportunity?opportunityId=<id>
```

That route should inspect the current WorkOS/AuthKit cookies and redirect the
browser to the correct CRM destination for the current user.

Future implementation should decide:

- Route shape: query parameter, path segment, or signed short token.
- Whether the route should accept `opportunityId` directly or a signed opaque
  token to avoid exposing raw IDs in Slack links.
- Whether admins go to `/workspace/opportunities/:id` while closers route to a
  closer-specific view, meeting detail, or role-appropriate fallback.
- How to handle an authenticated CRM user who belongs to a different tenant than
  the opportunity.
- How to handle an authenticated user who has tenant access but is not allowed to
  view that opportunity.
- Whether the stale digest and new-lead confirmation should share the same route.

### Desired Redirect Behavior

Recommended behavior for the future route:

1. If the user is unauthenticated, start the normal sign-in flow and preserve the
   intended opportunity destination as the post-login return URL.
2. If the user is a system admin, route according to the system-admin product
   decision. Do not silently expose tenant workspace data unless the admin route
   explicitly supports it.
3. If the user is a tenant admin/master for the opportunity's tenant, redirect to
   `/workspace/opportunities/:id`.
4. If the user is a closer and has access to the opportunity, redirect to the
   closest role-appropriate destination.
5. If the user is authenticated but lacks access, redirect to their normal
   workspace landing page with a small error state or toast.
6. Never trust tenant, role, or user identity from URL parameters. Derive all
   access from the current session and server-side Convex checks.

### Current v1 Decision

Use direct `/workspace/opportunities/:id` links for the Slack `Open in CRM`
buttons for now. Do not block v1 on the redirect route. Treat the route as a
post-v1 hardening/polish upgrade before broader production rollout.

---

## Upgrade S1 — Admin-Facing Slack Reconnect Alert

**Status:** Deferred until after all Slackbot v1 capabilities are implemented.

**Priority:** High after v1 ships. This should be one of the first polish and
operability upgrades after Phase 6 because it closes the user-facing loop for
token expiry, uninstall, and revocation states.

**Related files / systems:**

- `runbooks/slack-token-refresh-write-failure.md`
- `components/calendly-connection-guard.tsx`
- `app/ConvexClientProvider.tsx`
- `app/workspace/settings/_components/settings-page-client.tsx`
- `app/api/slack/start/route.ts`
- `convex/slack/installations.ts`
- `convex/slack/tokens.ts`
- Future Phase 5/6 Slack integration card and lifecycle handlers

### Problem

The current Phase 1 foundation correctly records Slack installation lifecycle
states:

- `active`
- `token_expired`
- `revoked`
- `uninstalled`

It also has a P1 operator runbook for the catastrophic token refresh write-fail
case. However, the product experience still depends on an operator noticing the
problem and telling the tenant to reconnect.

That is not sufficient long-term. If Slack is disconnected, lead qualification,
confirmation messages, stale-lead reminders, and lifecycle telemetry can silently
stop working from the tenant's point of view. Tenant owners/admins need an
in-app, persistent, obvious reconnect prompt, similar to the current Calendly
disconnect banner, but tuned to Slack's lower criticality and without blocking
normal CRM work.

### Why Defer

Do **not** implement this during the early Slackbot buildout.

Reasons:

1. The final UX should account for all Slack capabilities, not only OAuth:
   slash command, channel configuration, notifications, stale-lead digest,
   lifecycle events, reconnect, and metrics.
2. Phase 5 is already planned to build the real Integrations card. The reconnect
   alert should reuse that status model instead of creating a second one-off UI.
3. Phase 6 adds `revoked`, `uninstalled`, and reconnect semantics. Building the
   alert before those states exist would either be incomplete or need rework.
4. The current runbook is enough during dev and dogfood while the operator count
   is small. Productized tenant-facing alerting becomes important before broad
   production rollout.

### Goal

When Slack integration is not usable, tenant owners and admins should see a
clear but non-disruptive alert that urges them to reconnect Slack.

The alert should:

- Be visible to `tenant_master` and `tenant_admin`.
- Be hidden from `closer` users unless a later product decision says otherwise.
- Avoid modals, route blocking, or hard redirects.
- Persist until Slack is reconnected.
- Be dismissible for the current browser session or for a short cool-down.
- Link directly into the reconnect flow.
- Explain what is broken in concrete terms.
- Avoid promising Slack messages can be sent while the token is invalid.

### UX Requirements

Use the Calendly reconnect guard as the behavioral reference, but do not copy its
severity one-to-one.

Calendly is core ingestion. If Calendly disconnects, the CRM stops receiving
meeting data. Slack is important, but less foundational. The Slack alert should
feel urgent without being fully disruptive.

Recommended UX:

1. **Workspace-level banner**
   - Mount inside the app-level provider tree, adjacent to or composed with
     `CalendlyConnectionGuard`.
   - Show only on `/workspace/*` routes.
   - Use `Alert`, `Button`, and `X` dismiss affordance like Calendly.
   - Use warning/default styling, not destructive red, unless the state is the
     catastrophic token refresh write-fail state.
   - Copy should be direct:
     - Title: `Slack disconnected`
     - Body: `Slack lead qualification is paused. Reconnect Slack to restore /qualify-lead, channel notifications, and stale-lead reminders.`
     - CTA: `Reconnect Slack`

2. **Settings Integrations card**
   - The real Phase 5 Slack card should show the same state with more detail.
   - Include status pill:
     - `Connected`
     - `Needs reconnect`
     - `Uninstalled`
     - `Revoked`
     - `Token expired`
     - `Channels not configured`
   - The card should always be the durable source of detail; the banner is only
     the cross-page prompt.

3. **Dismiss behavior**
   - Dismissal should not mark the problem resolved.
   - Recommended first version: local `useState` dismissal until page reload,
     exactly like `CalendlyConnectionGuard`.
   - Later version: persist dismissal in localStorage for a short cool-down
     keyed by tenant + installation status + status timestamp.
   - Do not let dismissal hide a newer failure state. If status changes from
     `token_expired` to `uninstalled`, show the banner again.

4. **Reconnect flow**
   - CTA should go to `/api/slack/start`.
   - The start route must still derive tenant from WorkOS/Convex auth and must
     not accept a client-supplied `tenantId`.
   - After successful OAuth, redirect to
     `/workspace/settings?tab=integrations&slack=connected&pickChannel=true`.
   - Show a success toast after redirect:
     - `Slack reconnected.`
   - Show failure toasts for:
     - `slack=denied`
     - `slack=start_failed`
     - `slack=oauth_failed`
     - `slack=admin_required`

### State Model

Add a public Convex query, likely in `convex/slack/installations.ts` or a new
`convex/slack/queries.ts`:

```ts
export const getConnectionStatus = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    // Return a sanitized status object. Never return botAccessToken or refreshToken.
  },
});
```

Return shape:

```ts
type SlackConnectionStatus = {
  tenantId: Id<"tenants">;
  installationId: Id<"slackInstallations"> | null;
  status:
    | "not_installed"
    | "active"
    | "token_expired"
    | "revoked"
    | "uninstalled";
  needsReconnect: boolean;
  needsChannelConfig: boolean;
  teamName: string | null;
  appId: string | null;
  botUserId: string | null;
  installedAt: number | null;
  lastRefreshedAt: number | null;
  tokenExpiresAt: number | null;
  notifyChannelName: string | null;
  staleReminderChannelName: string | null;
};
```

Rules:

- `not_installed`: no banner unless the user is already on the Integrations tab.
- `active` + missing notify/stale channels: no global reconnect banner; surface
  this in the Integrations card as setup incomplete.
- `token_expired`: global banner, reconnect CTA.
- `revoked`: global banner, reconnect CTA.
- `uninstalled`: global banner, reinstall CTA using the same OAuth start route.
- Any query must use `requireTenantUser(ctx, ["tenant_master", "tenant_admin"])`.
- Do not return token fields, refresh lock holder, or raw secrets.

### Component Shape

Add a new guard, likely:

```text
components/slack-connection-guard.tsx
```

Mounting options:

1. Preferred: compose with `CalendlyConnectionGuard` in
   `app/ConvexClientProvider.tsx`.
2. Alternative: mount inside `WorkspaceShellClient` if role context is needed.

Preferred behavior:

- Query `api.users.queries.getCurrentUser` first, as Calendly does, because the
  app-level provider is outside `RoleProvider`.
- Skip on non-workspace routes.
- Skip for non-admin users.
- Query Slack status only when admin.
- Render children transparently with the banner prepended.

Potential composition:

```tsx
<CalendlyConnectionGuard>
  <SlackConnectionGuard>{children}</SlackConnectionGuard>
</CalendlyConnectionGuard>
```

Ordering decision:

- Calendly should stay first if both are broken because Calendly is more
  critical.
- Slack appears below Calendly. Avoid stacking two red destructive banners.

### Alert Copy

Use state-specific copy so admins understand what happened.

`token_expired`:

```text
Slack disconnected
Slack lead qualification is paused because the Slack token expired. Reconnect Slack to restore /qualify-lead, channel notifications, and stale-lead reminders.
```

`revoked`:

```text
Slack access revoked
Slack revoked this app's tokens. Reconnect Slack to restore lead qualification and notifications.
```

`uninstalled`:

```text
Slack app uninstalled
The Magnus Slack app was removed from your workspace. Reinstall it to restore /qualify-lead and Slack notifications.
```

Catastrophic refresh write-fail state:

- Today this collapses to `token_expired`.
- If a future field tracks `disconnectReason: "refresh_write_failed"`, use more
  urgent copy:

```text
Slack needs reconnect
Slack disconnected unexpectedly during token refresh. Reconnect Slack now to restore lead qualification and notifications.
```

### Non-Goals

- Do not send Slack notifications for Slack disconnection. The token may be
  invalid, and using Slack to report Slack failure is unreliable.
- Do not email tenant admins in the first version unless the product later adds
  an email notification system.
- Do not block closers from using the CRM.
- Do not put reconnect logic in the client. The client only links to
  `/api/slack/start`; all authorization and tenant resolution stay server-side.
- Do not expose raw Slack token metadata beyond timing/status fields.

### Security Requirements

- The reconnect CTA must not accept `tenantId`, `teamId`, or `installationId`
  from the browser.
- The public status query must require `tenant_master` or `tenant_admin`.
- The status query must never return `botAccessToken`, `refreshToken`,
  `refreshLockHolder`, `refreshLockAcquiredAt`, or OAuth state data.
- The reconnect flow must keep the signed one-time OAuth state from Phase 1.
- If a Slack workspace is already linked to another tenant, reconnect must fail
  with the existing server-side guard.

### Data / Backend Requirements

Minimum version:

- Reuse `slackInstallations.status`.
- Reuse `tokenExpiresAt`, `lastRefreshedAt`, `teamName`, channel names.
- No schema change required if only showing generic status.

Optional improved version:

Add these optional fields to `slackInstallations`:

```ts
lastDisconnectedAt: v.optional(v.number()),
disconnectReason: v.optional(
  v.union(
    v.literal("token_expired"),
    v.literal("tokens_revoked"),
    v.literal("app_uninstalled"),
    v.literal("refresh_write_failed"),
  ),
),
```

This would improve copy and localStorage dismissal keys, but it is not required
for the first implementation.

Migration note:

- Adding optional fields is safe and does not require a data backfill.
- If this becomes required state later, use the `convex-migration-helper` skill.

### Acceptance Criteria

1. Tenant admins see no Slack banner when Slack is `active`.
2. Tenant admins see no global banner for `not_installed`; the Integrations card
   handles initial setup.
3. Tenant admins see a warning banner for `token_expired`, `revoked`, and
   `uninstalled`.
4. Closers never see the banner.
5. Dismissing the banner hides it only temporarily and does not mutate backend
   status.
6. Clicking `Reconnect Slack` starts `/api/slack/start` and completes the same
   secure OAuth flow as Phase 1.
7. After reconnect, the banner disappears reactively when the installation row
   returns to `status: "active"`.
8. The settings Integrations card still displays exact status and channel setup
   state even if the banner is dismissed.
9. `pnpm build` passes.
10. Targeted ESLint for the new guard/query files passes.

### Recommended Implementation Timing

Implement after:

- Phase 5 Integrations card exists.
- Phase 6 lifecycle handlers exist for `tokens_revoked` and `app_uninstalled`.
- Reconnect flow has been verified against a real dev Slack uninstall/reinstall.

Suggested implementation window:

```text
After Phase 6 dogfood, before broad production activation / Public Distribution.
```

This places the alert after the Slack product surface is complete, but before
real tenants can get stuck in a silent disconnected state.
