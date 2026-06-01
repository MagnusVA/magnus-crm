# Phase 1 — OAuth Install & Token Rotation

**Goal:** Land the foundational install pipeline for the distributed Slack app — Convex schema for installations + OAuth state, an authenticated install start route gated by WorkOS, an HMAC-state-protected redirect handler, a JIT token-refresh helper with distributed-lock semantics, a proactive refresh cron, and the irreversible `token_rotation_enabled: true` manifest publication. After this phase, a tenant admin can connect a Slack workspace from the CRM and the system holds a continuously-rotating bot token.

**Prerequisite:** None — this is the first Slack-bot phase and is on the critical path. The existing Calendly token-rotation pattern (`convex/calendly/tokens.ts`) and the `requireTenantUser` shape (`convex/requireTenantUser.ts`) are the references we adapt.

**Runs in PARALLEL with:** Nothing — every subsequent Slack phase imports primitives from this one (`getValidSlackBotToken`, `verifySlackSignature`, `slackInstallations` lookup by `(team_id, api_app_id)`).

> **Critical path:** This phase is on the critical path (Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6). Specifically the manifest-publish step (1H) is **irreversible** for `token_rotation_enabled: true` — this is the single most important gate in the project (see [`slackbot-design.md` §4.1, §14.10](../slackbot-design.md)). Pay extreme attention to subphase 1H.

**Skills to invoke:**
- `convex-create-component` — *consider deferring* — the `slackInstallations` + token-rotation cluster could plausibly be extracted as a reusable Convex component for future Slack-app projects. Out of scope for v1; flagged in the design (§17).
- `workos` — reference only. The `/api/slack/start` route is gated by WorkOS `withAuth({ ensureSignedIn: true })`, but the Slack OAuth flow itself is independent of WorkOS.
- `shadcn` — used only at the very end of 1H (the "Connect Slack" CTA placement on the existing Settings page). Polishing happens in Phase 5.

**Acceptance Criteria:**
1. `npx convex dev` runs without schema errors after adding the `slackInstallations` and `slackOAuthStates` tables.
2. `convex/lib/slackSignature.ts:verifySlackSignature` accepts a known-good Slack POST body + signature pair from a recorded fixture and rejects: stale timestamps (> 5 min skew), tampered bodies, length mismatches.
3. `convex/lib/slackOAuthState.ts:createSlackOAuthState` produces a token whose HMAC verifies and whose nonce is stored as `nonceHash` (sha256, never raw); `validateAndConsumeSlackOAuthState` rejects: bad signature, expired (> 10 min), already-consumed, and tampered payloads.
4. `GET /api/slack/start` (Next.js route) redirects unauthenticated users to `/sign-in`, redirects non-admin CRM users to `/workspace`, and for `tenant_master` / `tenant_admin` users redirects to `https://slack.com/oauth/v2/authorize?...&state=...`.
5. The Slack OAuth callback handler at `https://<convex-host>.convex.site/slack/oauth_redirect` exchanges a real Slack `code` for tokens, upserts an `slackInstallations` row with `status: "active"` and a non-null `refreshToken`, and 302s back to `/workspace/settings?tab=integrations&slack=connected&pickChannel=true`.
6. `getValidSlackBotToken` returns the cached `botAccessToken` when `tokenExpiresAt - Date.now() > 60_000` (fast path) and refreshes via `oauth.v2.access` (`grant_type=refresh_token`) when the token is expiring or expired.
7. Force-expire a token row (`db.patch({ tokenExpiresAt: Date.now() - 1 })`) and verify (a) the proactive cron `refresh-slack-tokens` refreshes it within one tick, and (b) two concurrent calls to `getValidSlackBotToken` exhibit lock-then-wait-then-read behavior — only one performs the network refresh, the other observes the post-refresh value.
8. The Slack app manifest published to **prod** has `token_rotation_enabled: true` rendered correctly in the saved-manifest preview before final save (manual gate in 1H), and **Public Distribution remains disabled** until Phase 6's final go-live gate.
9. CI lint rule fails any commit that introduces or modifies `slack-manifest.prod.yaml` with `token_rotation_enabled` set to anything other than `true`.
10. `pnpm tsc --noEmit` passes — `Doc<"slackInstallations">` and `Id<"slackOAuthStates">` resolve from `convex/_generated/dataModel`.

---

## Subphase Dependency Graph

```
1A (manual: Slack app registration)  ──────────────────────────────────────────┐
                                                                                │
1B (schema: installations + oauthStates) ──┐                                    │
                                            ├─ 1D (action auth helper) ────┐    │
1C (signing primitives) ────────────────────┘                              │    │
                                                                            ├── 1E (OAuth flow code) ──┐
                                                                            │                          │
                                                                            └── 1F (token rotation) ───┤
                                                                                                       │
                                                                                                       └── 1G (HTTP+cron wiring) ──→ 1H (manual: manifest + env)
                                                                                                                                                            │
                                                                                                                                                            └─→ 1I (CI lint + runbook)
```

**Optimal execution:**
1. Start **1A** in browser (Slack app registration, branding, secrets — irreversible artifacts that the engineer setup steps depend on) and **1B** + **1C** simultaneously in code (schema + signing primitives have no inter-dependency).
2. Once **1B** is deployed, start **1D** (action auth helper imports `Id<"tenants">`) — can run in parallel with the tail of 1C.
3. Once **1C** + **1D** are merged, **1E** (OAuth flow) and **1F** (token rotation) start in parallel — they share no files.
4. Once **1E** + **1F** are merged, **1G** wires routes + cron registrations into `convex/http.ts` and `convex/crons.ts` (small, single-PR).
5. **1H** is gated by a successfully-deployed 1G — manifest publish runs URL verification on save and will fail if the routes don't respond.
6. **1I** can run alongside 1H (separate file: `.github/workflows/slack-manifest-lint.yml` does not touch any Convex code).

**Estimated time:** 5–7 days of focused work. The code is moderate (~600 LOC across 8 files); the hours come from the manual-step operational discipline of 1A and 1H, the catastrophic-recovery thinking required for the token-refresh race, and the dev/prod manifest publication choreography.

---

## Subphases

### 1A — Manual Slack App Registration & Pre-dev Setup

**Type:** Manual (browser + shell)
**Parallelizable:** Yes — fully independent of code subphases (1B–1G), but **must complete before 1H**.

**What:** Register two Slack apps (dev + prod), generate the four required secrets per environment, prepare branding assets, and set the privacy/support URLs. **No code is written in this subphase.**

**Why:** Everything downstream depends on `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, and `SLACK_STATE_SIGNING_SECRET`. Creation of the Slack app itself has no API — it is browser-only at <https://api.slack.com/apps>. Branding (display name, 512×512 PNG icon, background color) is required *before* Public Distribution can be activated, so we collect it now. Privacy + support URLs are required by Slack for distributed apps even before App Directory listing.

**Where:** No project files. The artifacts live in:
- Slack App Config UI (one app per environment)
- A password manager (or `.env.local.example` redacted entries) for the four secrets per environment
- The team's design folder (icon PNG, copy)

**How:**

> **You must do this yourself in a browser. None of these steps can be automated.**

**Step 1: Decide Slack-app ownership**

Register both apps under a **shared / company** Slack workspace, never a personal Slack account. Ownership transfer is awkward — the app must outlive the registering admin's tenure. A teammate with admin permissions on the company Slack workspace should be the registering account. Document the registering account in the team's ops doc.

**Step 2: Create the dev Slack app**

1. Go to <https://api.slack.com/apps> while signed in as the registering account.
2. Click **"Create New App"** → **"From a manifest"**.
3. Pick a workspace — the company's dev / sandbox Slack workspace.
4. Paste a **minimal bootstrap** manifest (we'll re-paste the full one in 1H once code is deployed). The redirect URL in this stub must still be a real HTTPS URL you control:

```yaml
# Path: ad-hoc Slack manifest paste (not in repo yet)
display_information:
  name: "Magnus CRM (dev)"
  description: "Qualify leads from Slack into your CRM."
  background_color: "#0b1020"
features:
  bot_user:
    display_name: "Magnus"
    always_online: true
oauth_config:
  redirect_urls:
    - "https://<actual-convex-dev-host>.convex.site/slack/oauth_redirect"
  scopes:
    bot:
      - commands
settings:
  socket_mode_enabled: false
  token_rotation_enabled: true
```

   Replace `<actual-convex-dev-host>` before pasting. Do **not** use `example.com` or a made-up placeholder — Slack validates redirect URLs when token rotation is enabled. This URL does not need to be tenant-specific; all tenants use the same app-level Convex callback, and tenant routing is carried by the HMAC-signed OAuth `state` created in 1E. In 1H, verify this same callback is deployed and then keep `SLACK_REDIRECT_URI` matching it character-for-character.

5. Click **"Create"**. The app is now created with a `client_id`, `client_secret`, `signing_secret`. **`token_rotation_enabled: true`** has been recorded — this stub is enough to commit the irreversible flag at app creation time. (See [`slackbot-design.md` §4.1](../slackbot-design.md) — the flag is unrecoverable once committed.)

**Step 3: Repeat Step 2 for prod**

Same flow, same workspace owner, but:
- `display_information.name`: `"Magnus CRM"` (no `(dev)` suffix)
- `oauth_config.redirect_urls[0]`: use the real prod Convex callback URL, `https://<actual-convex-prod-host>.convex.site/slack/oauth_redirect`, not the dev URL.
- This is the app real tenants will install later. **Treat with extreme care.**
- **Verify in the saved-manifest preview that `token_rotation_enabled: true` is rendered correctly before clicking save.** This is the ⚠️ ⚠️ moment.

**Step 4: Generate state-signing secrets**

```bash
# Path: terminal — run twice (one per environment)
openssl rand -hex 32   # SLACK_STATE_SIGNING_SECRET (dev)
openssl rand -hex 32   # SLACK_STATE_SIGNING_SECRET (prod)
```

These are **ours** — distinct from Slack's `signing_secret`. They sign our OAuth `state` parameter (see 1C). Do not share between environments. Store both in the team password manager.

**Step 5: Read off the four Slack-issued secrets per environment**

Slack App Config → **"Basic Information"** → **"App Credentials"**. Read off:

- `Client ID`
- `Client Secret`
- `Signing Secret`
- (No refresh-token-specific secret — refresh uses `client_id` + `client_secret`.)

These do **not** appear in the manifest YAML. Browser copy-paste only. Save to the password manager keyed `slack-dev` and `slack-prod`.

**Step 6: Prepare branding assets**

- **512×512 PNG icon** — must be uploaded via Slack App Config UI (no manifest field for it). One file, used by both dev and prod apps.
- Background color hex: `#0b1020` (matches our brand; final pick may differ — confirm with design before final prod publish).
- Display name: `Magnus` (same in both environments; the `(dev)` suffix is in `display_information.name`, not the bot's display name).
- Short description (140 char): `"Qualify leads from Slack into your CRM."` (final copy in [`slackbot-design.md` §16.4](../slackbot-design.md), open to a 30-min copy session with marketing — see Phase 5 Open Q5).
- Long description (~1500 char): draft in advance; save to the team's product copy doc.

**Step 7: Set privacy + support URLs**

Slack App Config → **"Basic Information"** → **"Display Information"**. Both required for distributed apps:

- **Privacy Policy URL** — `https://magnuscrm.com/privacy` (or the CRM's actual privacy page; flag with legal if it doesn't exist yet).
- **Support URL** — `https://magnuscrm.com/support` (or `mailto:support@magnuscrm.com`).

Public Distribution will not activate without these.

**Step 8: Document the registered apps**

Append to the team's ops doc:

```markdown
# Slack apps (registered <date>)

## Dev
- App ID: <copy from Basic Information>
- Workspace: <dev Slack workspace name>
- Registering account: <admin@magnuscrm.com>
- Token rotation: enabled (verified in saved manifest)

## Prod
- App ID: <copy from Basic Information>
- Workspace: <company Slack workspace name>
- Registering account: <admin@magnuscrm.com>
- Token rotation: enabled (verified in saved manifest)
- Public Distribution: NOT YET ACTIVATED — Phase 6 flips it on after dogfood and final QA.
```

**Key implementation notes:**
- **🚨 IRREVERSIBLE:** `token_rotation_enabled: true` cannot be reverted on the same app. The stub manifest in Step 2 commits the flag at app-creation time. If a teammate accidentally creates an app with `token_rotation_enabled: false` (or omits it — defaults to `false`), the only remediation is registering a brand-new app and re-OAuthing every existing tenant. Document this loudly in the ops doc.
- **📋 ONE-TIME per environment:** Steps 2–8 fire once. Subsequent manifest updates (URL changes after Convex deploys) re-publish the manifest YAML but do not re-create the app.
- **Slack workspace policy edge:** If your dev / company workspace requires admin approval for new apps, Step 2's "Create" click triggers an approval queue. Out of our control; budget half a day if your IT team gates installs.
- **Two apps, one icon, one branding doc.** Resist the temptation to brand them differently — when a tenant uninstalls dev because they thought it was prod, the cleanup is awkward.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| *(none)* | Manual | Slack App Config UI is the canonical location |
| Team ops doc (external) | Manual | Append "Slack apps registered" section per Step 8 |
| Team password manager (external) | Manual | 4 × 2 = 8 secrets to file (per env: client_id, client_secret, signing_secret, state_signing_secret) |

---

### 1B — Schema: `slackInstallations` + `slackOAuthStates`

**Type:** Backend
**Parallelizable:** Yes — independent of 1C (different files), but blocks 1D, 1E, 1F (which import the generated types).

**What:** Add the two new Convex tables required for Phase 1: `slackInstallations` (one row per tenant per Slack workspace, holding the bot tokens and lifecycle status) and `slackOAuthStates` (transient one-time-use OAuth state nonces). All composite indexes are added in this same change so 1E/1F can `withIndex` against them immediately.

**Why:** Every other 1× subphase imports types from `convex/_generated/dataModel`. Without the schema deployed, `Doc<"slackInstallations">` is `never` and TypeScript fails. Deploying schema first also lets the next-deploy code start writing rows without coordinating multiple migrations.

> **Schema strategy: widen-only.** Per [`slackbot-design.md` §10.10](../slackbot-design.md), this is the additive widen step of a widen-migrate-narrow rollout. Existing rows in other tables are unaffected. Schema 1B + Schema 3A (in Phase 3) ship in two separate deploys — no need to bundle them. **No data backfill required at this phase.**

**Where:**
- `convex/schema.ts` (modify — additions only)

**How:**

**Step 1: Add the `slackInstallations` table definition**

Open `convex/schema.ts` and locate the bottom of the `defineSchema({ ... })` body — just below the last existing table. Add:

```typescript
// Path: convex/schema.ts

  // ─── Slack Bot v1 (Phase 1) ────────────────────────────────────────────────

  /**
   * One row per tenant per installed Slack workspace.
   * Holds the rotated bot token, refresh token, and lifecycle status.
   * The hot path lookup is by `(team_id, app_id)`. Every inbound Slack payload includes
   * `team_id`; slash commands and Events API envelopes also include `api_app_id`.
   * `team_id` alone is diagnostics-only because dev/prod Slack apps can share a workspace.
   */
  slackInstallations: defineTable({
    tenantId: v.id("tenants"),

    // Slack workspace identity (from oauth.v2.access response)
    teamId: v.string(),                            // e.g. "T9TK3CUKW" — join key on every inbound payload
    teamName: v.string(),
    enterpriseId: v.optional(v.string()),          // null for non-Grid workspaces (deferred — see §1 Non-Goals)
    isEnterpriseInstall: v.boolean(),
    appId: v.string(),

    // Bot identity (from oauth.v2.access response)
    botUserId: v.string(),                         // e.g. "U0KRQLJ9H"
    botAccessToken: v.string(),                    // ROTATED every ~12h — never trust beyond tokenExpiresAt
    scopes: v.array(v.string()),

    // Notification targets (set in Phase 5 onboarding step 2; null until configured)
    notifyChannelId: v.optional(v.string()),
    notifyChannelName: v.optional(v.string()),
    staleReminderChannelId: v.optional(v.string()),    // falls back to notifyChannelId when unset
    staleReminderChannelName: v.optional(v.string()),

    // Audit
    installedByWorkosUserId: v.string(),
    installedAt: v.number(),

    // Token rotation — required from day one (see §4.4)
    tokenExpiresAt: v.number(),                    // epoch ms; access-token expiry
    refreshToken: v.string(),                      // SINGLE-USE — invalidated server-side the moment a new one is issued
    lastRefreshedAt: v.optional(v.number()),       // observability only
    refreshLockHolder: v.optional(v.string()),     // distributed-lock holder UUID (see 1F)
    refreshLockAcquiredAt: v.optional(v.number()), // for stale-lock detection (>30s = abandoned)

    // Lifecycle (see §4.6 state diagram)
    status: v.union(
      v.literal("active"),
      v.literal("token_expired"),                  // refresh failed; tenant must re-OAuth
      v.literal("revoked"),                        // tokens_revoked event fired
      v.literal("uninstalled"),                    // app_uninstalled event fired
    ),
    uninstalledAt: v.optional(v.number()),
  })
    .index("by_tenantId", ["tenantId"])
    .index("by_teamId", ["teamId"])                                          // diagnostics/migration only
    .index("by_teamId_and_appId", ["teamId", "appId"])                       // inbound trust boundary
    .index("by_status_and_tokenExpiresAt", ["status", "tokenExpiresAt"]),    // refresh-cron query
```

**Step 2: Add the `slackOAuthStates` table definition**

Immediately below `slackInstallations`:

```typescript
// Path: convex/schema.ts

  /**
   * Transient one-time-use OAuth state nonces.
   * `createSlackOAuthState` inserts a row before redirecting to slack.com/oauth/v2/authorize;
   * `validateAndConsumeSlackOAuthState` reads-and-patches `consumedAt` atomically.
   * Daily cleanup (cron in 1G) removes expired rows.
   */
  slackOAuthStates: defineTable({
    tenantId: v.id("tenants"),
    workosUserId: v.string(),
    stateHash: v.string(),                         // sha256(state token), never store raw state — see §13
    nonceHash: v.string(),                         // sha256(nonce) for replay detection
    issuedAt: v.number(),
    expiresAt: v.number(),                         // now + 10 minutes (TTL — see slackOAuthState.ts)
    consumedAt: v.optional(v.number()),
  })
    .index("by_stateHash", ["stateHash"])           // primary lookup on redirect
    .index("by_expiresAt", ["expiresAt"]),          // cleanup cron
```

**Step 3: Push the schema and verify**

```bash
# Path: terminal
npx convex dev
```

Watch for type-generation success. Then:

```bash
# Path: terminal
npx convex data slackInstallations    # should print "No documents" (table exists)
npx convex data slackOAuthStates      # should print "No documents"
```

If either fails with "table does not exist," the deploy didn't complete — investigate before continuing.

**Step 4: Verify type generation**

```bash
# Path: terminal
pnpm tsc --noEmit
```

Open any file (e.g. `convex/lib/identity.ts`) and add a temporary line:

```typescript
// Path: convex/lib/identity.ts (temporary, remove after verification)
import type { Doc, Id } from "../_generated/dataModel";
type _CheckSlackInstallations = Doc<"slackInstallations">;
type _CheckSlackOAuthStates = Doc<"slackOAuthStates">;
type _CheckIds = [Id<"slackInstallations">, Id<"slackOAuthStates">];
```

If this compiles, generation worked. Remove the lines.

**Key implementation notes:**
- **Index naming follows the codebase convention** (`by_<field1>_and_<field2>`) — see [`AGENTS.md` § Convex Backend Standards](../../../AGENTS.md). Anything else fails the existing convention check.
- **`refreshToken: v.string()` is non-optional.** Slack guarantees a refresh token in the OAuth response when `token_rotation_enabled: true` (see [`.docs/slack/using-token-rotation.md`](../../../.docs/slack/using-token-rotation.md)). If we ever observe a missing refresh token in production, that signals a manifest drift to investigate immediately.
- **`status` literal `"uninstalled"` is distinct from `"revoked"`.** Slack fires both `app_uninstalled` and `tokens_revoked` on uninstall but **does not guarantee delivery order** ([§9.1](../slackbot-design.md)). Phase 6 treats both as terminal-state triggers: `tokens_revoked` alone marks `revoked`, while `app_uninstalled` marks `uninstalled` and wins if both arrive.
- **`slackOAuthStates.stateHash`, not raw token.** Storing the raw state token would let a DB-read attacker forge an OAuth callback. We store `sha256(token)` and verify by computing the hash of the inbound `state` URL parameter and looking it up.
- **No backfill.** Both tables start empty; the first row in `slackInstallations` arrives only when a tenant completes 1H + a real install.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Add `slackInstallations` + `slackOAuthStates` table definitions and 6 indexes total |

---

### 1C — Signing Primitives: `slackOAuthState.ts` + `slackSignature.ts`

**Type:** Backend (utility)
**Parallelizable:** Yes — independent of 1B (different files, but does import `internal` from `_generated/api` for the slackOAuthStates mutations). Practically, run after 1B is merged so the generated types resolve without ambiguity.

**What:** Two side-by-side helpers in `convex/lib/`:
1. `slackSignature.ts` — verifies inbound Slack HMAC signatures (`X-Slack-Signature` + `X-Slack-Request-Timestamp`); reused by every Phase 2/5/6 handler.
2. `slackOAuthState.ts` — signs the OAuth `state` parameter with `SLACK_STATE_SIGNING_SECRET`, persists a hashed nonce in `slackOAuthStates`, and validates+consumes the nonce one-time on redirect.

**Why:** Slack's request-verification protocol ([`.docs/slack/verifying-requests-from-slack.md`](../../../.docs/slack/verifying-requests-from-slack.md)) is the *only* trust boundary for inbound `commands`/`interactivity`/`events` — there is no CRM session on those requests. The state primitive prevents CSRF on `/slack/oauth_redirect` and ensures the `tenantId` on the install path was admin-attested at start time. Both helpers are tiny (~30–60 LOC each) and shared by 4–5 callers; centralizing avoids copy-paste in the inbound handlers.

The shape mirrors `convex/webhooks/calendly.ts` (`createSignature`, `timingSafeEqualHex`) so reviewers can pattern-match across the two integrations.

**Where:**
- `convex/lib/slackSignature.ts` (new)
- `convex/lib/slackOAuthState.ts` (new)
- `convex/slack/oauthStateMutations.ts` (new) — internal mutations used by `slackOAuthState.ts`

**How:**

**Step 1: Implement `slackSignature.ts`**

```typescript
// Path: convex/lib/slackSignature.ts

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Per https://api.slack.com/authentication/verifying-requests-from-slack
 * Slack documents a 5-minute replay window — we mirror that exactly.
 */
const REPLAY_WINDOW_SECONDS = 60 * 5;

export type VerifySlackSignatureArgs = {
  /** Raw HTTP body — must be captured BEFORE any parsing. */
  rawBody: string;
  /** `X-Slack-Request-Timestamp` header value (decimal seconds since epoch). */
  timestamp: string;
  /** `X-Slack-Signature` header value, e.g. `"v0=abc123..."`. */
  signature: string;
  /** App-level signing secret (env var SLACK_SIGNING_SECRET). */
  signingSecret: string;
  /** Previous signing secret during a Slack secret-rotation window. */
  previousSigningSecret?: string;
};

/**
 * Verifies a Slack-issued HMAC signature on an inbound HTTP body.
 *
 * Returns `true` only if all of the following hold:
 *   - `timestamp` parses as a finite number
 *   - `|now - timestamp| <= 5 minutes` (replay protection)
 *   - HMAC-SHA256 of `v0:{timestamp}:{rawBody}` with the current or previous
 *     signing secret matches `signature`
 *   - Comparison is constant-time (`crypto.timingSafeEqual`)
 *
 * The shape mirrors `convex/webhooks/calendly.ts:createSignature`/`timingSafeEqualHex`.
 */
export function verifySlackSignature(args: VerifySlackSignatureArgs): boolean {
  if (!args.signingSecret) {
    return false;
  }

  const ts = Number(args.timestamp);
  if (!Number.isFinite(ts)) {
    return false;
  }

  const now = Date.now() / 1000;
  if (Math.abs(now - ts) > REPLAY_WINDOW_SECONDS) {
    // Either an old retransmit or a bad clock — reject either way.
    return false;
  }

  const base = `v0:${args.timestamp}:${args.rawBody}`;
  const candidateSecrets = [
    args.signingSecret,
    args.previousSigningSecret,
  ].filter((secret): secret is string => Boolean(secret));

  for (const secret of candidateSecrets) {
    const expected =
      "v0=" +
      createHmac("sha256", secret).update(base).digest("hex");

    // Length-check first — `timingSafeEqual` throws if buffers differ in length.
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(args.signature, "utf8");
    if (a.length === b.length && timingSafeEqual(a, b)) {
      return true;
    }
  }
  return false;
}
```

**Step 2: Implement the OAuth state primitive — `slackOAuthState.ts`**

```typescript
// Path: convex/lib/slackOAuthState.ts

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const STATE_TTL_DEFAULT_SECONDS = 600; // 10 minutes — see slackbot-design.md §4.2

type StatePayload = {
  /** Tenant chosen by the authenticated install start route. */
  tenantId: Id<"tenants">;
  /** WorkOS user that started the install — re-verified as admin on redirect. */
  workosUserId: string;
  /** 32-byte random nonce; stored hashed in slackOAuthStates. */
  nonce: string;
  /** Issued-at, ms since epoch. */
  iat: number;
  /** Expiry, ms since epoch. */
  exp: number;
};

export type CreatedState = {
  /** Opaque token to send as the `state` URL param. Format: `<base64url(payload)>.<hex(hmac)>`. */
  token: string;
  expiresAt: number;
};

export type ValidatedState = {
  tenantId: Id<"tenants">;
  workosUserId: string;
};

/* ────────────────────────────────────────────────────────────────────────── */
/* Encoding                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function base64urlDecode(s: string): Buffer {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(s.length + ((4 - (s.length % 4)) % 4), "=");
  return Buffer.from(padded, "base64");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}
function verify(payload: string, signature: string, secret: string): boolean {
  const expected = sign(payload, secret);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function sha256Hex(input: string): string {
  return createHmac("sha256", "").update(input).digest("hex");
  // Note: HMAC with empty key is fine here — we just need a deterministic hash for
  // index lookup. We sign the payload with the real secret separately above.
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Public API                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

export async function createSlackOAuthState(
  ctx: ActionCtx,
  args: {
    tenantId: Id<"tenants">;
    workosUserId: string;
    ttlSeconds?: number;
    signingSecret?: string;
  },
): Promise<CreatedState> {
  const signingSecret = args.signingSecret ?? process.env.SLACK_STATE_SIGNING_SECRET;
  if (!signingSecret) {
    throw new Error("SLACK_STATE_SIGNING_SECRET not set");
  }

  const now = Date.now();
  const ttl = (args.ttlSeconds ?? STATE_TTL_DEFAULT_SECONDS) * 1000;
  const nonce = randomBytes(32).toString("hex");

  const payload: StatePayload = {
    tenantId: args.tenantId,
    workosUserId: args.workosUserId,
    nonce,
    iat: now,
    exp: now + ttl,
  };
  const payloadEncoded = base64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const signature = sign(payloadEncoded, signingSecret);
  const token = `${payloadEncoded}.${signature}`;

  // Persist the hashes (never the raw nonce or raw token).
  await ctx.runMutation(internal.slack.oauthStateMutations.insertState, {
    tenantId: args.tenantId,
    workosUserId: args.workosUserId,
    stateHash: sha256Hex(token),
    nonceHash: sha256Hex(nonce),
    issuedAt: now,
    expiresAt: payload.exp,
  });

  return { token, expiresAt: payload.exp };
}

export async function validateAndConsumeSlackOAuthState(
  ctx: ActionCtx,
  args: { token: string; signingSecret?: string },
): Promise<ValidatedState | null> {
  const signingSecret = args.signingSecret ?? process.env.SLACK_STATE_SIGNING_SECRET;
  if (!signingSecret) {
    throw new Error("SLACK_STATE_SIGNING_SECRET not set");
  }

  const dot = args.token.lastIndexOf(".");
  if (dot < 0) return null;
  const payloadEncoded = args.token.slice(0, dot);
  const signature = args.token.slice(dot + 1);

  if (!verify(payloadEncoded, signature, signingSecret)) {
    return null; // bad signature — log at caller
  }

  let payload: StatePayload;
  try {
    payload = JSON.parse(base64urlDecode(payloadEncoded).toString("utf8")) as StatePayload;
  } catch {
    return null;
  }
  if (typeof payload?.exp !== "number" || Date.now() >= payload.exp) {
    return null; // expired
  }
  if (sha256Hex(payload.nonce) === "") {
    return null; // structural failure — should be unreachable
  }

  // Atomic consume — fails if already consumed or row missing.
  const consumed = await ctx.runMutation(
    internal.slack.oauthStateMutations.consumeState,
    {
      stateHash: sha256Hex(args.token),
      nonceHash: sha256Hex(payload.nonce),
    },
  );
  if (!consumed) {
    return null;
  }

  return {
    tenantId: payload.tenantId,
    workosUserId: payload.workosUserId,
  };
}
```

**Step 3: Implement the internal mutations the state primitive depends on**

```typescript
// Path: convex/slack/oauthStateMutations.ts

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

export const insertState = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    workosUserId: v.string(),
    stateHash: v.string(),
    nonceHash: v.string(),
    issuedAt: v.number(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("slackOAuthStates", {
      tenantId: args.tenantId,
      workosUserId: args.workosUserId,
      stateHash: args.stateHash,
      nonceHash: args.nonceHash,
      issuedAt: args.issuedAt,
      expiresAt: args.expiresAt,
    });
  },
});

/**
 * One-time-use consumption. Returns true iff a non-consumed, non-expired row matches.
 * `nonceHash` is verified server-side as well — defends against an attacker who
 * compromised state-token storage but not the nonce.
 */
export const consumeState = internalMutation({
  args: { stateHash: v.string(), nonceHash: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("slackOAuthStates")
      .withIndex("by_stateHash", (q) => q.eq("stateHash", args.stateHash))
      .unique();
    if (!row) return false;
    if (row.consumedAt) return false;
    if (row.nonceHash !== args.nonceHash) return false;
    if (row.expiresAt <= Date.now()) return false;

    await ctx.db.patch(row._id, { consumedAt: Date.now() });
    return true;
  },
});
```

**Step 4: Verify with a unit-style harness**

There's no test runner in this repo (per [`AGENTS.md` § Testing](../../../AGENTS.md), QA is manual). Verify with a temporary Convex action that exercises happy path + 4 failure modes; remove after the run:

```typescript
// Path: convex/slack/_temp_signatureSmokeTest.ts (REMOVE after verification)
"use node";
import { internalAction } from "../_generated/server";
import { createHmac } from "node:crypto";
import { verifySlackSignature } from "../lib/slackSignature";

export const smokeTest = internalAction({
  args: {},
  handler: async () => {
    const secret = "test_signing_secret";
    const now = Math.floor(Date.now() / 1000).toString();
    const body = "command=/qualify-lead&team_id=T1&api_app_id=A1";
    const sig = createHmac("sha256", secret)
      .update(`v0:${now}:${body}`)
      .digest("hex");

    console.log("good:", verifySlackSignature({
      rawBody: body, timestamp: now, signature: `v0=${sig}`, signingSecret: secret,
    })); // expect true
    console.log("stale:", verifySlackSignature({
      rawBody: body, timestamp: "1", signature: `v0=${sig}`, signingSecret: secret,
    })); // expect false
    console.log("tampered body:", verifySlackSignature({
      rawBody: body + "x", timestamp: now, signature: `v0=${sig}`, signingSecret: secret,
    })); // expect false
    console.log("length mismatch:", verifySlackSignature({
      rawBody: body, timestamp: now, signature: `v0=${sig.slice(0, 10)}`, signingSecret: secret,
    })); // expect false
    console.log("bad ts:", verifySlackSignature({
      rawBody: body, timestamp: "not-a-number", signature: `v0=${sig}`, signingSecret: secret,
    })); // expect false
    return "ok";
  },
});
```

Run via `npx convex run slack/_temp_signatureSmokeTest:smokeTest`. After all five lines print `true / false / false / false / false`, **delete the file** (it pollutes the API surface).

**Key implementation notes:**
- **The production helpers use Web Crypto and the default Convex runtime.** The temporary smoke-test action above uses `node:crypto` only to generate an independent expected signature; do not carry `"use node"` into the production Slack HTTP handlers just for HMAC verification or `fetch`.
- **State token format is `<base64url(payload)>.<hex(hmac)>`** — chosen for ease of debugging (the payload is human-readable after decoding). The full token's sha256 is the DB lookup key.
- **`sha256Hex` uses `createHmac` with empty key as a stand-in.** This is technically HMAC-SHA256 with `""` not raw SHA-256 — but it's deterministic and one-way, which is all we need for the index. If you prefer plain SHA-256, swap to `createHash("sha256").update(input).digest("hex")` and import `createHash` — semantically equivalent for this use.
- **The state nonce is `randomBytes(32)`** — 256 bits of entropy, indistinguishable from random. Reusing the same nonce for two installs is structurally impossible for a single Slack workspace because we'd hit the consumed-row check.
- **`consumeState` returns `false`, not throwing**, on any failure — keeps the call site clean (`if (!consumed) return null` rather than `try/catch`).
- **No race in `consumeState`** because Convex mutations are serialized per-document; even if two parallel redirects fired, the second would observe `row.consumedAt` set and reject.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/slackSignature.ts` | Create | HMAC verification primitive |
| `convex/lib/slackOAuthState.ts` | Create | State signing + nonce management |
| `convex/slack/oauthStateMutations.ts` | Create | Internal mutations: `insertState`, `consumeState` |

---

### 1D — Action-Context Auth Helper: `requireTenantUserFromAction`

**Type:** Backend (utility)
**Parallelizable:** Yes — independent of 1C (different file). Depends on 1B (uses `Id<"tenants">`).

**What:** A small sibling helper to the existing `convex/requireTenantUser.ts` that works in **action** contexts. The current helper accepts `QueryCtx | MutationCtx`; actions need a different shape because `ctx.db` is unavailable. We move the user/tenant lookup to an internal query and call it from the action.

**Why:** The OAuth start (1E) and the channel list (Phase 5) are actions that need to derive a `tenantId` + role from `ctx.auth.getUserIdentity()`. The browser must never supply `tenantId` directly — see [`slackbot-design.md` §4.1, §13.2](../slackbot-design.md). Introducing this helper once means the same trust boundary is enforced in every action that the frontend can call.

**Where:**
- `convex/requireTenantUserFromAction.ts` (new)
- `convex/lib/userLookup.ts` (new) — shared internal queries used by both action and query helpers (so the lookup logic isn't duplicated)

**How:**

**Step 1: Extract the user-lookup logic into a shared internal query**

The existing `requireTenantUser` resolves: `identity → orgId → workosUserId → users row → tenants row`. We need to call those steps from an action. Introduce a single internal query that takes the already-extracted identity bits and returns the resolved user + tenant.

```typescript
// Path: convex/lib/userLookup.ts

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import type { CrmRole } from "./roleMapping";
import { getWorkosUserIdCandidates } from "./workosUserId";

/**
 * Internal query — given a list of WorkOS user-id candidates and an org id,
 * resolve the matching CRM `users` row, validate tenant membership, and
 * return identity bundle. Throws on the same conditions as `requireTenantUser`.
 *
 * Both `requireTenantUser` (queries/mutations) and `requireTenantUserFromAction`
 * (actions) call this via `ctx.runQuery`. Keep the throw-message strings
 * stable — the action helper re-throws them upward.
 */
export const resolveCrmUserByIdentity = internalQuery({
  args: {
    workosUserIdCandidates: v.array(v.string()),
    orgId: v.string(),
    subjectFallback: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let user = null;
    for (const candidate of args.workosUserIdCandidates) {
      user = await ctx.db
        .query("users")
        .withIndex("by_workosUserId", (q) => q.eq("workosUserId", candidate))
        .unique();
      if (user) break;
    }

    if (!user && args.subjectFallback && !args.workosUserIdCandidates.includes(args.subjectFallback)) {
      user = await ctx.db
        .query("users")
        .withIndex("by_workosUserId", (q) => q.eq("workosUserId", args.subjectFallback!))
        .unique();
    }

    if (!user) throw new Error("User not found — please complete setup");
    if (user.isActive === false) throw new Error("User account is inactive");

    const tenant = await ctx.db.get(user.tenantId);
    if (!tenant || tenant.workosOrgId !== args.orgId) {
      throw new Error("Organization mismatch");
    }

    return {
      userId: user._id,
      tenantId: user.tenantId,
      role: user.role as CrmRole,
      // Echo the canonical id back so callers can persist `installedByWorkosUserId` etc.
      workosUserId: user.workosUserId,
    };
  },
});
```

**Step 2: Implement `requireTenantUserFromAction`**

```typescript
// Path: convex/requireTenantUserFromAction.ts

import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { getIdentityOrgId } from "./lib/identity";
import {
  getCanonicalIdentityWorkosUserId,
  getWorkosUserIdCandidates,
} from "./lib/workosUserId";
import type { CrmRole } from "./lib/roleMapping";
import type { Id } from "./_generated/dataModel";

export type TenantUserResult = {
  userId: Id<"users">;
  tenantId: Id<"tenants">;
  role: CrmRole;
  workosUserId: string;
};

/**
 * Action-context analog of `convex/requireTenantUser.ts:requireTenantUser`.
 *
 * Use this from any Convex `action` that the frontend calls with auth — it
 * derives `tenantId` + `role` from the WorkOS-issued JWT instead of trusting
 * any client argument. Patterned after `requireTenantUser` so log shapes and
 * thrown error strings are identical (operators can pattern-match).
 *
 * Trust boundary: the only client input we read is `ctx.auth.getUserIdentity()`,
 * which Convex itself validated against `auth.config.ts`.
 */
export async function requireTenantUserFromAction(
  ctx: ActionCtx,
  allowedRoles: CrmRole[],
): Promise<TenantUserResult> {
  console.log("[Auth:Action] requireTenantUserFromAction called", { allowedRoles });

  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    console.error("[Auth:Action] no identity");
    throw new Error("Not authenticated");
  }

  const orgId = getIdentityOrgId(identity);
  if (!orgId) {
    console.error("[Auth:Action] no orgId from identity");
    throw new Error("No organization context");
  }

  const workosUserId = getCanonicalIdentityWorkosUserId(identity);
  if (!workosUserId) {
    console.error("[Auth:Action] no workosUserId");
    throw new Error("Missing WorkOS user ID");
  }

  const resolved = await ctx.runQuery(internal.lib.userLookup.resolveCrmUserByIdentity, {
    workosUserIdCandidates: getWorkosUserIdCandidates(workosUserId),
    orgId,
    subjectFallback: identity.subject ?? undefined,
  });

  if (!allowedRoles.includes(resolved.role)) {
    console.error("[Auth:Action] insufficient permissions", {
      userRole: resolved.role,
      allowedRoles,
    });
    throw new Error("Insufficient permissions");
  }

  console.log("[Auth:Action] succeeded", {
    userId: resolved.userId,
    tenantId: resolved.tenantId,
    role: resolved.role,
  });
  return resolved;
}
```

**Step 3: Optional — refactor `requireTenantUser.ts` to share `userLookup.ts`**

This is **not blocking** Phase 1 and you may defer to a follow-up cleanup PR. If you do refactor in this phase: change the inline lookup loop in `convex/requireTenantUser.ts` to `await ctx.runQuery(internal.lib.userLookup.resolveCrmUserByIdentity, …)`, dedup the lookup logic, ship in the same PR. **Skip it if the diff feels risky** — Phase 1 already has a long blast radius.

**Key implementation notes:**
- **Why the internal query?** Actions cannot read `ctx.db` directly. `ctx.runQuery(internal.foo.bar)` is the only path for an action to read DB state — the indirection is structural, not stylistic.
- **Throw-message parity.** The thrown strings (`"Not authenticated"`, `"No organization context"`, …) match `requireTenantUser` so existing client-side error handling (which keys off these strings in some places) keeps working.
- **`subjectFallback` mirrors `requireTenantUser`'s alternate-subject lookup** at line 60–73 of the existing file. Some old WorkOS sessions issue `identity.subject` distinct from the canonical `workosUserId`; we tolerate both.
- **No new env vars** introduced by this subphase.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/userLookup.ts` | Create | Shared internal query: `resolveCrmUserByIdentity` |
| `convex/requireTenantUserFromAction.ts` | Create | Action-context wrapper around `userLookup` |
| `convex/requireTenantUser.ts` | Optional modify | Refactor to call `userLookup` (defer if risky) |

---

### 1E — OAuth Flow: `startInstall` Action + `/slack/oauth_redirect` Handler + Next.js `/api/slack/start` Route

**Type:** Full-Stack (Convex action + httpAction + Next.js route handler)
**Parallelizable:** Yes — depends only on 1B (schema), 1C (state primitive), 1D (action auth). Independent of 1F.

**What:**
- `convex/slack/oauth.ts` exports the `startInstall` Convex action and the `/slack/oauth_redirect` `httpAction`.
- `app/api/slack/start/route.ts` is the Next.js GET route that calls `startInstall` with the WorkOS access token and 302s the browser to Slack's authorize URL.
- `convex/slack/installations.ts` exports the DB helpers the OAuth and inbound flows depend on: `byTeamIdAndAppId`, `byTenantId`, `byId`, `verifyInstallerStillAdmin`, and `upsertOnInstall`. `byTeamId` may exist only for diagnostics/migration sweeps; inbound handlers must not use it. Phase 6 adds `reactivate` when lifecycle reinstall support lands.

**Why:** This is the visible install path the tenant admin will walk. Three trust boundaries land here at once: WorkOS session (Next.js side), action auth (Convex side), HMAC-state nonce (callback side). The architecture deliberately **does not** include a Next.js callback route — the callback is a Convex `httpAction` because there's no cookie context to consult; the trust we need (admin-attested `tenantId`) is already inside the signed state token.

**Where:**
- `app/api/slack/start/route.ts` (new)
- `convex/slack/oauth.ts` (new)
- `convex/slack/installations.ts` (new)

**How:**

**Step 1: Implement `convex/slack/installations.ts` (lookup + upsert mutations)**

```typescript
// Path: convex/slack/installations.ts

import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
} from "../_generated/server";

/**
 * Hot-path lookup used by every inbound Slack handler (Phase 2/5/6).
 * Both values come from a HMAC-verified payload. `team_id` alone is not a
 * tenant trust boundary because dev/prod Slack apps can share one workspace.
 */
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

/**
 * Diagnostics/migration helper only. Never use this as the inbound trust
 * boundary; use `byTeamIdAndAppId` instead.
 */
export const byTeamId = internalQuery({
  args: { teamId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("slackInstallations")
      .withIndex("by_teamId", (q) => q.eq("teamId", args.teamId))
      .take(10);
  },
});

export const byTenantId = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("slackInstallations")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", args.tenantId))
      .first();
  },
});

export const byId = internalQuery({
  args: { id: v.id("slackInstallations") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

/**
 * Re-verifies on the redirect path that the workosUserId who started the install
 * is still an admin of the tenant. Defends against a brief flow where a user
 * starts the install, gets demoted, and the redirect arrives later.
 */
export const verifyInstallerStillAdmin = internalQuery({
  args: { tenantId: v.id("tenants"), workosUserId: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", args.workosUserId))
      .unique();
    if (!user) return null;
    if (user.tenantId !== args.tenantId) return null;
    if (user.isActive === false) return null;
    if (user.role !== "tenant_master" && user.role !== "tenant_admin") return null;
    return { userId: user._id };
  },
});

/**
 * Insert (fresh install) or update (a reinstall — same tenantId + teamId).
 * Idempotent: rerunning with the same tokens is safe.
 */
export const upsertOnInstall = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    teamId: v.string(),
    teamName: v.string(),
    enterpriseId: v.optional(v.string()),
    isEnterpriseInstall: v.boolean(),
    appId: v.string(),
    botUserId: v.string(),
    botAccessToken: v.string(),
    refreshToken: v.string(),
    tokenExpiresAt: v.number(),
    scopes: v.array(v.string()),
    installedByWorkosUserId: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("slackInstallations")
      .withIndex("by_teamId_and_appId", (q) => q.eq("teamId", args.teamId).eq("appId", args.appId))
      .unique();

    const now = Date.now();
    const base = {
      ...args,
      installedAt: now,
      lastRefreshedAt: undefined,
      refreshLockHolder: undefined,
      refreshLockAcquiredAt: undefined,
      status: "active" as const,
      uninstalledAt: undefined,
    };

    if (existing) {
      // Reinstall path. If the team already mapped to a different tenant, fail loudly —
      // this is the "Slack workspace already linked to another tenant" guard.
      if (existing.tenantId !== args.tenantId) {
        throw new Error("Slack workspace already linked to another tenant");
      }
      await ctx.db.patch(existing._id, base);
      return existing._id;
    }
    return await ctx.db.insert("slackInstallations", base);
  },
});
```

**Step 2: Implement `convex/slack/oauth.ts`**

```typescript
// Path: convex/slack/oauth.ts
import { v } from "convex/values";
import { action, httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { requireTenantUserFromAction } from "../requireTenantUserFromAction";
import {
  createSlackOAuthState,
  validateAndConsumeSlackOAuthState,
} from "../lib/slackOAuthState";

const SLACK_BOT_SCOPES = [
  "commands",
  "chat:write",
  "chat:write.public",
  "channels:read",
  "groups:read",
  "users:read",
] as const;

/**
 * Authenticated entry point — called by `/api/slack/start` (Next.js).
 * Returns the slack.com authorize URL with our HMAC-signed `state`.
 *
 * SECURITY: `tenantId` is derived from `ctx.auth.getUserIdentity()`, NOT
 * accepted as an argument. The browser must never claim a tenant context.
 */
export const startInstall = action({
  args: {},
  handler: async (ctx) => {
    const access = await requireTenantUserFromAction(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const clientId = process.env.SLACK_CLIENT_ID;
    const redirectUri = process.env.SLACK_REDIRECT_URI;
    if (!clientId || !redirectUri) {
      throw new Error("Slack OAuth env vars missing (SLACK_CLIENT_ID, SLACK_REDIRECT_URI)");
    }

    const state = await createSlackOAuthState(ctx, {
      tenantId: access.tenantId,
      workosUserId: access.workosUserId,
      ttlSeconds: 600,
    });

    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state.token);

    console.log("[Slack:OAuth] startInstall issued", {
      tenantId: access.tenantId,
      workosUserId: access.workosUserId,
      stateExpiresAt: state.expiresAt,
    });
    return { authorizeUrl: url.toString() };
  },
});

/**
 * The Slack OAuth redirect handler.
 * URL: https://<convex-host>.convex.site/slack/oauth_redirect
 *
 * Flow (per slackbot-design.md §4.3):
 *   1. Parse `code` + `state` from the query string.
 *   2. Validate + consume the state nonce (one-time-use). Reject if expired/replayed/forged.
 *   3. Re-verify the installer is still an admin of the tenant.
 *   4. POST `oauth.v2.access` with `client_secret` (server-side only).
 *   5. Upsert the `slackInstallations` row.
 *   6. 302 to /workspace/settings?tab=integrations&slack=connected&pickChannel=true
 */
export const oauthRedirect = httpAction(async (ctx, req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const stateRaw = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  // Slack will sometimes redirect with `error=access_denied` if the installer canceled.
  if (errorParam) {
    console.warn("[Slack:OAuth] redirect with error", { errorParam });
    return Response.redirect(
      `${process.env.APP_URL}/workspace/settings?tab=integrations&slack=denied`,
      302,
    );
  }
  if (!code || !stateRaw) {
    return new Response("Bad request — missing code or state", { status: 400 });
  }

  const state = await validateAndConsumeSlackOAuthState(ctx, { token: stateRaw });
  if (!state) {
    console.error("[Slack:OAuth] invalid or expired state");
    return new Response("Invalid state", { status: 401 });
  }

  const installer = await ctx.runQuery(
    internal.slack.installations.verifyInstallerStillAdmin,
    {
      tenantId: state.tenantId,
      workosUserId: state.workosUserId,
    },
  );
  if (!installer) {
    console.error("[Slack:OAuth] installer no longer authorized", {
      tenantId: state.tenantId,
      workosUserId: state.workosUserId,
    });
    return new Response("Installer no longer authorized", { status: 403 });
  }

  // Per .docs/slack/installing-with-oauth.md — POST application/x-www-form-urlencoded
  const tokenRes = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.SLACK_CLIENT_ID!,
      client_secret: process.env.SLACK_CLIENT_SECRET!,
      redirect_uri: process.env.SLACK_REDIRECT_URI!,
    }),
  });
  const data = (await tokenRes.json()) as {
    ok: boolean;
    error?: string;
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    bot_user_id?: string;
    app_id?: string;
    team?: { id: string; name: string };
    enterprise?: { id: string } | null;
    is_enterprise_install?: boolean;
  };

  if (!data.ok || !data.access_token || !data.refresh_token || !data.team) {
    console.error("[Slack:OAuth] oauth.v2.access failed", { error: data.error });
    return new Response(`Slack OAuth failed: ${data.error ?? "unknown"}`, { status: 502 });
  }

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

  console.log("[Slack:OAuth] install complete", {
    tenantId: state.tenantId,
    teamId: data.team.id,
  });

  const dest = new URL(`${process.env.APP_URL}/workspace/settings`);
  dest.searchParams.set("tab", "integrations");
  dest.searchParams.set("slack", "connected");
  dest.searchParams.set("pickChannel", "true");
  return Response.redirect(dest.toString(), 302);
});
```

**Step 3: Implement the Next.js install start route**

```typescript
// Path: app/api/slack/start/route.ts

import { withAuth } from "@workos-inc/authkit-nextjs";
import { ConvexHttpClient } from "convex/browser";
import { NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";

export const dynamic = "force-dynamic";

/**
 * GET /api/slack/start
 *
 * Authenticated install entry point. Patterned after `app/callback/calendly/route.ts`.
 *
 *   1. WorkOS verifies the session (redirects to /sign-in if not).
 *   2. Convex action verifies the user is `tenant_master` / `tenant_admin`.
 *   3. Convex action signs the state nonce and returns the slack.com authorize URL.
 *   4. We 302 the browser to it.
 */
export async function GET() {
  const auth = await withAuth({ ensureSignedIn: true });
  if (!auth.user || !auth.accessToken) {
    return NextResponse.redirect(
      new URL("/sign-in", process.env.NEXT_PUBLIC_APP_URL!),
    );
  }

  const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
  convex.setAuth(auth.accessToken);

  try {
    const { authorizeUrl } = await convex.action(api.slack.oauth.startInstall, {});
    return NextResponse.redirect(authorizeUrl);
  } catch (err) {
    // Common case: user is closer (not admin). Redirect to /workspace with a soft error.
    const message = err instanceof Error ? err.message : "unknown";
    console.error("[/api/slack/start] startInstall failed:", message);

    if (message === "Insufficient permissions") {
      const url = new URL(
        "/workspace?error=slack_admin_required",
        process.env.NEXT_PUBLIC_APP_URL!,
      );
      return NextResponse.redirect(url);
    }
    // Unexpected error — render a generic failure page.
    const url = new URL(
      "/workspace/settings?tab=integrations&slack=start_failed",
      process.env.NEXT_PUBLIC_APP_URL!,
    );
    return NextResponse.redirect(url);
  }
}
```

**Step 4: Add a placeholder "Connect Slack" CTA on the existing Settings page**

This is intentionally **minimal** — Phase 5 is where the Integrations tab lands properly with channel pickers and a status pill. For Phase 1 we just need a link to `/api/slack/start` so we can verify the flow end-to-end during 1H.

Locate the existing settings tab list (per the survey, in `app/workspace/settings/_components/settings-page-client.tsx`) and add a temporary tab + content:

```tsx
// Path: app/workspace/settings/_components/settings-page-client.tsx
// Inside the existing <Tabs> block — add an Integrations tab.

<TabsTrigger value="integrations">Integrations</TabsTrigger>
{/* ... */}

<TabsContent value="integrations">
  <Card>
    <CardHeader>
      <CardTitle>Slack</CardTitle>
      <CardDescription>
        Connect a Slack workspace to qualify leads from anywhere.
      </CardDescription>
    </CardHeader>
    <CardContent>
      {/* TEMPORARY for Phase 1 verification — Phase 5 replaces this with the proper card */}
      <Button asChild>
        <a href="/api/slack/start">Connect Slack</a>
      </Button>
    </CardContent>
  </Card>
</TabsContent>
```

**Key implementation notes:**
- **`startInstall` takes no `tenantId` argument.** This is the structural defense from [§13.2](../slackbot-design.md). If a future PR adds an arg here, treat as a security regression.
- **The OAuth redirect URL is not a tenant boundary.** Slack redirects every installing workspace to the same app-level Convex `httpAction`; the tenant boundary is the signed, one-time `state` payload created only after WorkOS + CRM admin authorization. Never add `tenantId`, org slug, or user-controlled tenant context to `redirect_uri`.
- **`oauthRedirect` is `httpAction`, not `action`.** Convex `httpAction`s run at `*.convex.site/<path>` and are the only entry point Slack can reach (we have no Next.js route mapped to a Convex callback). The route is registered in 1G.
- **`byTeamIdAndAppId` uses `unique()`.** `(teamId, appId)` is the installation identity. Multiple rows for the same `teamId` can exist across dev/prod apps or stale diagnostic rows, but inbound handlers must disambiguate with `api_app_id`.
- **Why no PKCE?** Slack's OAuth v2 doesn't require PKCE — `client_secret` is sufficient because the exchange is server-to-server. Calendly uses PKCE because of a different security profile.
- **`is_enterprise_install`** is captured but unused in v1 (per Open Q1). Capturing it now means we don't need a schema migration when Phase 1.5 enables Grid.
- **`scope: "..."`** in the response is a comma-separated string. We split + filter empties because Slack occasionally sends a trailing comma after a config change.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/slack/oauth.ts` | Create | `startInstall` action + `oauthRedirect` httpAction |
| `convex/slack/installations.ts` | Create | `byTeamIdAndAppId`, diagnostics-only `byTeamId`, `byTenantId`, `byId`, `verifyInstallerStillAdmin`, `upsertOnInstall` |
| `app/api/slack/start/route.ts` | Create | Authenticated install entry point |
| `app/workspace/settings/_components/settings-page-client.tsx` | Modify | Add temporary "Integrations" tab + Connect Slack button (replaced in Phase 5) |

---

### 1F — Token Rotation: `getValidSlackBotToken` + Lock Primitives + Refresh Cron

**Type:** Backend
**Parallelizable:** Yes — runs in parallel with 1E. Depends only on 1B (schema).

**What:** The token-refresh subsystem. Three parts:
1. `convex/slack/tokens.ts` — `getValidSlackBotToken(ctx, tenantId)` JIT helper, the single entry point any Phase 2/5/6 code calls when it needs a bot token. Internally calls `refreshBotToken` when the token is within the `REFRESH_BUFFER_MS` window.
2. Lock-state mutations in `convex/slack/installations.ts` — `tryAcquireRefreshLock`, `releaseRefreshLock`, `completeRefresh`, `markTokenExpired`. The lock holder is a UUID written into `refreshLockHolder`; only the holder may complete or release the lock.
3. `convex/slack/refreshCron.ts` — `refreshExpiringTokens` internal action, called hourly by `crons.ts`. Refreshes anything within 2h of expiry, fanning out via `ctx.scheduler.runAfter(0, …)`.

**Why:** Slack invalidates the old refresh token the instant it issues the new one. Without atomic single-mutation persistence we can land in the catastrophic state of [§14.3](../slackbot-design.md): "refresh succeeded, persist write failed." Without a distributed lock, two parallel `getValidSlackBotToken` calls would both call `oauth.v2.access` with the same refresh token — only one succeeds; the other strands a `token_revoked` error that quietly invalidates a perfectly-fine token. The pattern lifts directly from `convex/calendly/tokens.ts:refreshTenantTokenCore` (line 69) and adapts it to Slack's single-use refresh-token semantics.

**Where:**
- `convex/slack/tokens.ts` (new)
- `convex/slack/installations.ts` (modify — add the four lock-state mutations)
- `convex/slack/refreshCron.ts` (new)

**How:**

**Step 1: Add the lock-state mutations to `installations.ts`**

```typescript
// Path: convex/slack/installations.ts (additions — append to existing file from 1E)

import { internalAction } from "../_generated/server";

const STALE_LOCK_MS = 30_000;

/**
 * Atomically acquire the refresh lock if free or stale.
 * Returns true iff this caller now owns the lock.
 *
 * Pattern lifts from convex/calendly/tokenMutations.ts:acquireTokenRefreshLock.
 */
export const tryAcquireRefreshLock = internalMutation({
  args: {
    installationId: v.id("slackInstallations"),
    lockHolder: v.string(),
    staleAfterMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const inst = await ctx.db.get(args.installationId);
    if (!inst) return false;

    const now = Date.now();
    const stale = args.staleAfterMs ?? STALE_LOCK_MS;
    const heldBySomeone =
      Boolean(inst.refreshLockHolder) &&
      Boolean(inst.refreshLockAcquiredAt) &&
      now - (inst.refreshLockAcquiredAt ?? 0) < stale;

    if (heldBySomeone && inst.refreshLockHolder !== args.lockHolder) {
      return false;
    }

    await ctx.db.patch(args.installationId, {
      refreshLockHolder: args.lockHolder,
      refreshLockAcquiredAt: now,
    });
    return true;
  },
});

export const releaseRefreshLock = internalMutation({
  args: { id: v.id("slackInstallations"), lockHolder: v.string() },
  handler: async (ctx, args) => {
    const inst = await ctx.db.get(args.id);
    if (!inst) return;
    if (inst.refreshLockHolder !== args.lockHolder) return;  // not our lock — leave it
    await ctx.db.patch(args.id, {
      refreshLockHolder: undefined,
      refreshLockAcquiredAt: undefined,
    });
  },
});

/**
 * THE atomic write that persists the refreshed token tuple.
 *
 * CRITICAL: this mutation is intentionally ultra-thin. Anything that fails
 * here invalidates the new refresh-token tuple (Slack already rotated; the
 * old one is dead). See slackbot-design.md §14.3.
 *
 * Constraints:
 *   - Single ctx.db.patch, zero scheduler calls, zero side effects.
 *   - Verify lock ownership before writing (loser of a race can't overwrite).
 */
export const completeRefresh = internalMutation({
  args: {
    id: v.id("slackInstallations"),
    lockHolder: v.string(),
    botAccessToken: v.string(),
    refreshToken: v.string(),
    tokenExpiresAt: v.number(),
    lastRefreshedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const inst = await ctx.db.get(args.id);
    if (!inst) throw new Error("Installation gone during refresh");
    if (inst.refreshLockHolder !== args.lockHolder) {
      throw new Error("Lock lost during refresh — this is the catastrophic case");
    }
    await ctx.db.patch(args.id, {
      botAccessToken: args.botAccessToken,
      refreshToken: args.refreshToken,
      tokenExpiresAt: args.tokenExpiresAt,
      lastRefreshedAt: args.lastRefreshedAt,
      refreshLockHolder: undefined,
      refreshLockAcquiredAt: undefined,
      // Re-affirm active in case we were in token_expired and a tenant manually re-auth'd.
      status: "active",
    });
  },
});

/**
 * Marks an installation `token_expired` after Slack rejected our refresh.
 * Tenant must re-OAuth from the CRM Integrations page.
 */
export const markTokenExpired = internalMutation({
  args: { id: v.id("slackInstallations") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      status: "token_expired",
      refreshLockHolder: undefined,
      refreshLockAcquiredAt: undefined,
    });
  },
});
```

**Step 2: Implement `tokens.ts`**

```typescript
// Path: convex/slack/tokens.ts
import { v } from "convex/values";
import type { ActionCtx } from "../_generated/server";
import { action, internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

const REFRESH_BUFFER_MS = 60_000;     // refresh JIT when within 1 min of expiry
const PROACTIVE_BUFFER_MS = 2 * 60 * 60 * 1000; // proactive cron: anything within 2 h
const STALE_LOCK_MS = 30_000;
const REFRESH_BACKOFF_MIN_MS = 500;
const REFRESH_BACKOFF_JITTER_MS = 500;

export class SlackInstallationMissingError extends Error {
  constructor(public tenantId: Id<"tenants">) { super(`Slack installation missing for tenant ${tenantId}`); }
}
export class SlackInstallationNotActiveError extends Error {
  constructor(public status: string) { super(`Slack installation status=${status}`); }
}
export class SlackTokenExpiredError extends Error {
  constructor() { super("Slack refresh token rejected — tenant must re-OAuth"); }
}
export class SlackTokenRefreshContentionError extends Error {
  constructor() { super("Slack token refresh contention — peer holds lock"); }
}

/**
 * THE only entry point for any code that needs a Slack bot token.
 *
 * Fast path: token has > REFRESH_BUFFER_MS of life — return cached.
 * Slow path: refresh under lock, persist atomically.
 *
 * Pattern lifted from convex/calendly/tokens.ts:getValidAccessToken (line 287).
 */
export async function getValidSlackBotToken(
  ctx: ActionCtx,
  tenantId: Id<"tenants">,
): Promise<string> {
  const inst = await ctx.runQuery(internal.slack.installations.byTenantId, { tenantId });
  if (!inst) throw new SlackInstallationMissingError(tenantId);
  if (inst.status !== "active") throw new SlackInstallationNotActiveError(inst.status);

  const remainingMs = inst.tokenExpiresAt - Date.now();
  if (remainingMs > REFRESH_BUFFER_MS) {
    return inst.botAccessToken;
  }
  return await refreshBotToken(ctx, inst);
}

async function refreshBotToken(
  ctx: ActionCtx,
  inst: Doc<"slackInstallations">,
): Promise<string> {
  const lockHolder = crypto.randomUUID();
  const acquired = await ctx.runMutation(
    internal.slack.installations.tryAcquireRefreshLock,
    { installationId: inst._id, lockHolder, staleAfterMs: STALE_LOCK_MS },
  );

  if (!acquired) {
    // Loser path: wait briefly with jitter, re-read, accept the freshly-rotated token.
    await new Promise((r) =>
      setTimeout(r, REFRESH_BACKOFF_MIN_MS + Math.random() * REFRESH_BACKOFF_JITTER_MS),
    );
    const fresh = await ctx.runQuery(internal.slack.installations.byId, { id: inst._id });
    if (fresh && fresh.tokenExpiresAt - Date.now() > REFRESH_BUFFER_MS) {
      return fresh.botAccessToken;
    }
    throw new SlackTokenRefreshContentionError();
  }

  let slackIssuedNewTuple = false;
  try {
    const r = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: inst.refreshToken,
        client_id: process.env.SLACK_CLIENT_ID!,
        client_secret: process.env.SLACK_CLIENT_SECRET!,
      }),
    });
    const d = (await r.json()) as {
      ok: boolean;
      error?: string;
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };

    if (!d.ok) {
      // Per .docs/slack/using-token-rotation.md, both errors are unrecoverable
      // without re-OAuth. Mark the installation token_expired so the CRM surfaces
      // a Reconnect CTA.
      if (d.error === "invalid_grant" || d.error === "token_revoked") {
        await ctx.runMutation(internal.slack.installations.markTokenExpired, {
          id: inst._id,
        });
        console.error("[Slack:Tokens] refresh failed permanently", {
          installationId: inst._id, error: d.error,
        });
        throw new SlackTokenExpiredError();
      }
      // Transient errors (rate-limited, 5xx) — release the lock and surface to caller.
      console.warn("[Slack:Tokens] refresh transient failure", {
        installationId: inst._id, error: d.error,
      });
      throw new Error(`Slack refresh transient: ${d.error}`);
    }

    if (!d.access_token || !d.refresh_token || !d.expires_in) {
      throw new Error("Slack refresh response missing required fields");
    }

    // Single atomic mutation. Anything thrown from here is the catastrophic case.
    // From this line onward Slack has invalidated the old refresh token.
    slackIssuedNewTuple = true;
    await ctx.runMutation(internal.slack.installations.completeRefresh, {
      id: inst._id,
      lockHolder,
      botAccessToken: d.access_token,
      refreshToken: d.refresh_token,
      tokenExpiresAt: Date.now() + d.expires_in * 1000,
      lastRefreshedAt: Date.now(),
    });
    console.log("[Slack:Tokens] refresh ok", { installationId: inst._id });
    return d.access_token;
  } catch (e) {
    // Any throw before completeRefresh succeeded — release the lock so the next caller can retry.
    // If completeRefresh itself threw (catastrophic), the lock holder check inside it already prevents
    // a second writer from corrupting state; we still release so the row is unblocked.
    if (e instanceof SlackTokenExpiredError) {
      // markTokenExpired already cleared the lock fields.
      throw e;
    }
    if (slackIssuedNewTuple) {
      console.error("[Slack:Tokens] CATASTROPHIC refresh-write-fail", {
        installationId: inst._id,
        tenantId: inst.tenantId,
        teamId: inst.teamId,
        error: e instanceof Error ? e.message : "unknown",
      });
      await ctx.runMutation(internal.slack.installations.markTokenExpired, {
        id: inst._id,
      });
      throw e;
    }
    await ctx.runMutation(internal.slack.installations.releaseRefreshLock, {
      id: inst._id,
      lockHolder,
    });
    throw e;
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Proactive refresh cron entry                                               */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Hourly cron — registered in convex/crons.ts (1G).
 * Fans out per-installation refreshes via `ctx.scheduler.runAfter(0, …)`
 * to keep each transaction bounded.
 */
export const refreshExpiringTokens = internalAction({
  args: {},
  handler: async (ctx) => {
    const dueIds = await ctx.runQuery(
      internal.slack.refreshCron.listExpiringInstallationIds,
      { withinMs: PROACTIVE_BUFFER_MS },
    );
    console.log("[Slack:Tokens] cron tick", { dueCount: dueIds.length });

    for (const id of dueIds) {
      // Stagger to avoid burst — same idea as TOKEN_REFRESH_STAGGER_MS in calendly/tokens.ts.
      await ctx.scheduler.runAfter(0, internal.slack.tokens.refreshOneInstallation, {
        installationId: id,
      });
    }
  },
});

export const refreshOneInstallation = internalAction({
  args: { installationId: v.id("slackInstallations") },
  handler: async (ctx, args) => {
    const inst = await ctx.runQuery(internal.slack.installations.byId, { id: args.installationId });
    if (!inst || inst.status !== "active") return;
    if (inst.tokenExpiresAt - Date.now() > PROACTIVE_BUFFER_MS) return; // already refreshed by another path
    try {
      await refreshBotToken(ctx, inst);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown";
      console.warn("[Slack:Tokens] cron refresh skipped", {
        installationId: args.installationId, error: msg,
      });
    }
  },
});
```

**Step 3: Implement the cron-driven query**

```typescript
// Path: convex/slack/refreshCron.ts
import { v } from "convex/values";
import { internalQuery } from "../_generated/server";

/**
 * Returns the IDs of `active` installations whose tokens are within `withinMs` of expiry.
 * Bounded to 200 — the proactive cron should never be sweeping more than a few-hundred
 * tenants per tick. If we ever hit the bound, paginate via createdAt cursor.
 */
export const listExpiringInstallationIds = internalQuery({
  args: { withinMs: v.number() },
  handler: async (ctx, args) => {
    const cutoff = Date.now() + args.withinMs;
    const rows = await ctx.db
      .query("slackInstallations")
      .withIndex("by_status_and_tokenExpiresAt", (q) =>
        q.eq("status", "active").lt("tokenExpiresAt", cutoff),
      )
      .take(200);
    return rows.map((r) => r._id);
  },
});
```

**Step 4: Manual end-to-end verification (after 1G is wired)**

Wait until 1G registers the cron. Then:

```bash
# Path: terminal
# Force-expire the only existing dev installation:
npx convex data slackInstallations
# Note the _id of the installation row.

# Patch tokenExpiresAt to a past timestamp via the dashboard (or write a one-off internal action):
npx convex run slack/tokens:refreshOneInstallation '{"installationId":"<id>"}'

# Verify it refreshed:
npx convex data slackInstallations
# tokenExpiresAt should now be ~12h in the future, lastRefreshedAt set.
```

To verify the lock prevents a double-refresh, run two refresh actions in parallel from two terminals; one should succeed, the other should observe the freshly-rotated token via `byId` (or throw `SlackTokenRefreshContentionError` if the refresh hadn't completed when it re-read).

**Key implementation notes:**
- **`completeRefresh` is the only writer of `botAccessToken` + `refreshToken`.** No other code path touches those fields. Any future PR that does is a bug.
- **The catastrophic log signature is `[Slack:Tokens] CATASTROPHIC refresh-write-fail`.** Set up alerting on this exact prefix in 1H step 9. **Page on first occurrence** — this is the highest-severity log signature in the system.
- **The 30s stale-lock policy is identical to Calendly's.** A stuck lock for > 30s is treated as abandoned (caller crashed or timed out) and forcibly stolen — `tryAcquireRefreshLock` ignores `refreshLockHolder` if `Date.now() - refreshLockAcquiredAt > 30_000`.
- **Why 1h proactive cron + 12h token TTL?** With a 12h TTL and a 2h buffer, every token gets refreshed ≥ 10h before expiry; even if the cron skips a tick, we're nowhere near the cliff. The fast-path JIT helper handles the unlucky window.
- **Lock holder is `crypto.randomUUID()`** — 122 bits of entropy. Collision probability across all in-flight refreshes is negligible.
- **Backoff is 500ms ± 500ms jitter** — chosen to almost always observe the post-refresh value (real refreshes finish in 100–300ms) without holding the action open too long.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/slack/tokens.ts` | Create | `getValidSlackBotToken` + `refreshBotToken` + `refreshExpiringTokens` cron + `refreshOneInstallation` |
| `convex/slack/installations.ts` | Modify | Add `tryAcquireRefreshLock`, `releaseRefreshLock`, `completeRefresh`, `markTokenExpired` |
| `convex/slack/refreshCron.ts` | Create | `listExpiringInstallationIds` internal query |

---

### 1G — HTTP Route + Cron Wiring

**Type:** Backend (configuration)
**Parallelizable:** No — must come after 1E + 1F. Single-PR. Tiny diff.

**What:** Wire `oauthRedirect` into `convex/http.ts` at `/slack/oauth_redirect`, add HMAC-verifying manifest-safe stubs for `/slack/commands`, `/slack/interactivity`, and `/slack/events`, and wire the proactive token-refresh cron into `convex/crons.ts`. Also schedule the `slackOAuthStates` cleanup cron — daily, 24h retention for consumed/expired rows.

**Why:** Until these wirings exist, the OAuth callback URL 404s and the cron never fires. The full Slack manifest in 1H also points at commands, interactivity, and events URLs; those endpoints must verify Slack signatures and return valid HTTP before the manifest is saved. Phase 2/6 replace the stubs with real handlers, but Phase 1 must make the manifest publish safe.

**Where:**
- `convex/http.ts` (modify)
- `convex/crons.ts` (modify)
- `convex/slack/inboundStubs.ts` (new) — temporary route handlers replaced by Phase 2 and Phase 6
- `convex/slack/cleanup.ts` (new) — `deleteExpiredOAuthStates`; Phase 3 appends `deleteExpiredRawEvents` once `rawSlackEvents` exists

**How:**

**Step 1: Register the OAuth redirect route**

```typescript
// Path: convex/http.ts

import { httpRouter } from "convex/server";
import { authKit } from "./auth";
import { handleCalendlyWebhook } from "./webhooks/calendly";
import { oauthRedirect } from "./slack/oauth";   // NEW
import {
  slackCommandStub,
  slackEventsStub,
  slackInteractivityStub,
} from "./slack/inboundStubs";                  // NEW

const http = httpRouter();
authKit.registerRoutes(http);

http.route({
  path: "/webhooks/calendly",
  method: "POST",
  handler: handleCalendlyWebhook,
});

// ─── Slack Bot v1 ────────────────────────────────────────────────────────────

http.route({
  path: "/slack/oauth_redirect",
  method: "GET",
  handler: oauthRedirect,
});

http.route({
  path: "/slack/commands",
  method: "POST",
  handler: slackCommandStub,        // Phase 2 swaps this for the real slash handler.
});

http.route({
  path: "/slack/interactivity",
  method: "POST",
  handler: slackInteractivityStub,  // Phase 2 swaps this for the real interactivity handler.
});

http.route({
  path: "/slack/events",
  method: "POST",
  handler: slackEventsStub,         // Phase 6 swaps this for lifecycle handling.
});

export default http;
```

**Step 2: Implement the manifest-safe inbound stubs**

```typescript
// Path: convex/slack/inboundStubs.ts
import { httpAction } from "../_generated/server";
import { verifySlackSignature } from "../lib/slackSignature";

const SIG_HEADER = "x-slack-signature";
const TS_HEADER = "x-slack-request-timestamp";

function verifyInboundSlackRequest(req: Request, rawBody: string): boolean {
  return verifySlackSignature({
    rawBody,
    timestamp: req.headers.get(TS_HEADER) ?? "",
    signature: req.headers.get(SIG_HEADER) ?? "",
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
    previousSigningSecret: process.env.SLACK_SIGNING_SECRET_PREVIOUS,
  });
}

export const slackCommandStub = httpAction(async (_ctx, req) => {
  const rawBody = await req.text();
  if (!verifyInboundSlackRequest(req, rawBody)) {
    return new Response("Bad signature", { status: 401 });
  }
  return new Response(
    JSON.stringify({
      response_type: "ephemeral",
      text: "Slack lead qualification is still being deployed. Please try again later.",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});

export const slackInteractivityStub = httpAction(async (_ctx, req) => {
  const rawBody = await req.text();
  if (!verifyInboundSlackRequest(req, rawBody)) {
    return new Response("Bad signature", { status: 401 });
  }
  return new Response("", { status: 200 });
});

export const slackEventsStub = httpAction(async (_ctx, req) => {
  const rawBody = await req.text();
  if (!verifyInboundSlackRequest(req, rawBody)) {
    return new Response("Bad signature", { status: 401 });
  }

  let body: { type?: string; challenge?: string } | null = null;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response("", { status: 200 });
  }

  if (body?.type === "url_verification") {
    return new Response(body.challenge ?? "", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }
  return new Response("", { status: 200 });
});
```

**Step 3: Implement the cleanup cron**

```typescript
// Path: convex/slack/cleanup.ts

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";

const OAUTH_STATE_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 h

export const findExpired = internalQuery({
  args: { cutoff: v.number(), limit: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("slackOAuthStates")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", args.cutoff))
      .take(args.limit);
    return rows.map((r) => r._id);
  },
});

export const deleteByIds = internalMutation({
  args: { ids: v.array(v.id("slackOAuthStates")) },
  handler: async (ctx, args) => {
    for (const id of args.ids) {
      await ctx.db.delete(id);
    }
  },
});

/**
 * Daily cleanup. Bounded batch size so we never blow transaction limits.
 * (Phase 3's rawSlackEvents cleanup follows the same pattern in this file.)
 */
export const deleteExpiredOAuthStates = internalAction({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - OAUTH_STATE_RETENTION_MS;
    let deleted = 0;
    for (let i = 0; i < 10; i++) {
      const ids = await ctx.runQuery(internal.slack.cleanup.findExpired, {
        cutoff, limit: 200,
      });
      if (ids.length === 0) break;
      await ctx.runMutation(internal.slack.cleanup.deleteByIds, { ids });
      deleted += ids.length;
    }
    console.log("[Slack:Cleanup] oauth states", { deleted });
    return { deleted };
  },
});

```

> **Generated API note:** after `npx convex dev` regenerates `_generated/api.d.ts`, use the generated `internal.slack.cleanup.findExpired` / `deleteByIds` references from the action. Do not call sibling functions through private handles; that bypasses Convex's generated type checks.

**Step 4: Register the crons**

```typescript
// Path: convex/crons.ts

import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// ... existing crons (Calendly tokens, health check, etc.) ...

// ─── Slack Bot v1 ────────────────────────────────────────────────────────────

crons.interval(
  "refresh-slack-tokens",
  { hours: 1 },
  internal.slack.tokens.refreshExpiringTokens,
  {},
);

crons.interval(
  "cleanup-slack-oauth-states",
  { hours: 24 },
  internal.slack.cleanup.deleteExpiredOAuthStates,
  {},
);

// (Phase 5 will register `slack-stale-qualified-leads-reminder`.)
// (Phase 3 will register `cleanup-slack-raw-events` once rawSlackEvents exists.)

export default crons;
```

**Step 5: Verify**

```bash
# Path: terminal
npx convex dev
# Watch the deploy log — should print:
#   [Crons] refresh-slack-tokens registered (every 1h)
#   [Crons] cleanup-slack-oauth-states registered (every 24h)
```

Then in the Convex dashboard → "Crons" → confirm both entries exist with their next-run timestamps.

Also smoke-test every manifest URL before 1H:

```bash
# Path: terminal
curl -i "https://<convex-host>.convex.site/slack/oauth_redirect"
# Expect: 400 "Bad request — missing code or state"

body='{"type":"url_verification","challenge":"ok"}'
ts="$(date +%s)"
sig="v0=$(printf "v0:%s:%s" "$ts" "$body" \
  | openssl dgst -sha256 -hmac "$SLACK_SIGNING_SECRET" -hex \
  | awk '{print $2}')"

curl -i -X POST "https://<convex-host>.convex.site/slack/events" \
  -H "Content-Type: application/json" \
  -H "X-Slack-Request-Timestamp: $ts" \
  -H "X-Slack-Signature: $sig" \
  --data "$body"
# Expect: 200 text/plain body "ok"
```

**Key implementation notes:**
- **`crons.interval`, never `.hourly`/`.daily`.** Per the existing `convex/crons.ts` and AGENTS.md, `.hourly`/`.daily` are deprecated.
- **`/slack/oauth_redirect` is `GET`, not `POST`** — Slack redirects the browser. The other Slack routes are POSTs; Phase 1 stubs verify signatures and keep manifest publication safe, and Phase 2/6 replace them with real handlers.
- **`/slack/oauth_redirect` URL must match `SLACK_REDIRECT_URI` env var character-for-character**, including trailing slash. See 1H Step 6.
- **Ordering of cron entries doesn't matter** — `cronJobs()` is just an emitter — but keep the section comment markers so future Slack-related crons land in the right block.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/http.ts` | Modify | Register `/slack/oauth_redirect` plus Slack inbound stubs |
| `convex/crons.ts` | Modify | Register `refresh-slack-tokens` (1h) + `cleanup-slack-oauth-states` (24h) |
| `convex/slack/inboundStubs.ts` | Create | Manifest-safe stubs for commands/interactivity/events |
| `convex/slack/cleanup.ts` | Create | OAuth-state cleanup primitives |

---

### 1H — Manifest Publish + Convex Env Vars (MANUAL — IRREVERSIBLE)

**Type:** Manual (browser + shell)
**Parallelizable:** No — must come after 1G is deployed. **Order-critical.**

**What:** The single most operationally fraught moment in the entire feature. Three coordinated activities:
1. Set the four Convex env vars per environment (dev → prod). Do this **before** Step 4.
2. Substitute the manifest URLs and paste the YAML into the Slack App Config UI. Save. URL verification + reachability checks fire here.
3. **Verify `token_rotation_enabled: true` rendered correctly** in the saved-manifest preview before final save (prod only).
4. Confirm Public Distribution remains disabled on prod. Phase 6 activates it after dogfood and final QA.

**Why:** Slack runs URL verification + reachability checks against the manifest URLs **the moment you save**. If the routes don't exist or the env vars are wrong, save either fails (recoverable) or saves with broken URLs you don't notice until users try to use the bot (silent failure). Separately, `token_rotation_enabled` is **irreversible at the app level** — saving with `false` once means registering a brand-new app and re-OAuthing every existing tenant. We accept this irreversibility deliberately (see [§4.1](../slackbot-design.md)) to avoid the much-worse retrofit.

**Where:** No project files in this subphase except the two manifest YAMLs added to source control:
- `slack-manifest.dev.yaml` (new, repo root)
- `slack-manifest.prod.yaml` (new, repo root)

**How:**

> **You must do this yourself in a browser + shell. None of the below can be automated. Treat each step like a deploy gate — read it, do it, check it off, only then move on.**

**Step 1: Commit the manifest YAMLs to source control**

The manifest is authoritative — whatever Slack stores must always be reproducible from the YAML in this repo. (When the Convex deployment URL changes, we re-paste; when the manifest changes, we update the YAML and re-paste.)

```yaml
# Path: slack-manifest.dev.yaml
_metadata:
  major_version: 2
  minor_version: 1
display_information:
  name: "Magnus CRM (dev)"
  description: "Qualify leads from Slack into your CRM."
  background_color: "#0b1020"
features:
  bot_user:
    display_name: "Magnus"
    always_online: true
  slash_commands:
    - command: "/qualify-lead"
      description: "Open a form to qualify a new lead"
      url: "https://<convex-dev>.convex.site/slack/commands"
      should_escape: false
oauth_config:
  redirect_urls:
    - "https://<convex-dev>.convex.site/slack/oauth_redirect"
  scopes:
    bot:
      - commands
      - chat:write
      - chat:write.public
      - channels:read
      - groups:read
      - users:read
settings:
  interactivity:
    is_enabled: true
    request_url: "https://<convex-dev>.convex.site/slack/interactivity"
  event_subscriptions:
    request_url: "https://<convex-dev>.convex.site/slack/events"
    bot_events:
      - app_uninstalled
      - tokens_revoked
      - user_change
  socket_mode_enabled: false
  token_rotation_enabled: true     # IRREVERSIBLE — see slackbot-design.md §4.1
```

```yaml
# Path: slack-manifest.prod.yaml
_metadata:
  major_version: 2
  minor_version: 1
display_information:
  name: "Magnus CRM"
  description: "Qualify leads from Slack into your CRM."
  background_color: "#0b1020"
features:
  bot_user:
    display_name: "Magnus"
    always_online: true
  slash_commands:
    - command: "/qualify-lead"
      description: "Open a form to qualify a new lead"
      url: "https://<convex-prod>.convex.site/slack/commands"
      should_escape: false
oauth_config:
  redirect_urls:
    - "https://<convex-prod>.convex.site/slack/oauth_redirect"
  scopes:
    bot:
      - commands
      - chat:write
      - chat:write.public
      - channels:read
      - groups:read
      - users:read
settings:
  interactivity:
    is_enabled: true
    request_url: "https://<convex-prod>.convex.site/slack/interactivity"
  event_subscriptions:
    request_url: "https://<convex-prod>.convex.site/slack/events"
    bot_events:
      - app_uninstalled
      - tokens_revoked
      - user_change
  socket_mode_enabled: false
  token_rotation_enabled: true     # IRREVERSIBLE — see slackbot-design.md §4.1, §14.10
```

> **Why two files?** Different `name` values (so installs don't show as the same app); different host URLs; identical scope/event/rotation. Keep them in lockstep on every change *except* the host URL.

**Step 2: Set Convex env vars on the dev deployment**

Per [§4.7.2](../slackbot-design.md). Use the secrets you saved during 1A Step 4–5:

```bash
# Path: terminal — run with the dev Convex deployment selected (CONVEX_DEPLOYMENT=dev:...)
npx convex env set SLACK_CLIENT_ID            "<dev client_id>"
npx convex env set SLACK_CLIENT_SECRET        "<dev client_secret>"
npx convex env set SLACK_SIGNING_SECRET       "<dev signing_secret>"
npx convex env set SLACK_STATE_SIGNING_SECRET "<dev openssl-generated hex>"
npx convex env set SLACK_REDIRECT_URI         "https://<convex-dev>.convex.site/slack/oauth_redirect"
npx convex env set APP_URL                    "https://<dev-app-host>"
```

```bash
# Path: terminal — verify
npx convex env list | grep -E 'SLACK|APP_URL'
# Should show all 6 entries.
```

**Step 3: Verify dev Convex routes are live**

```bash
# Path: terminal
curl -i "https://<convex-dev>.convex.site/slack/oauth_redirect"
# Expect: 400 "Bad request — missing code or state"
# (NOT a 404 — the route exists; it just rejects the empty request.)
```

If you get 404, 1G isn't deployed. Re-deploy and try again. **Do not proceed to Step 4 until you see 400.**

**Step 4: Substitute and paste the dev manifest**

1. Open `slack-manifest.dev.yaml` from the repo.
2. Replace every `<convex-dev>` placeholder with your actual Convex dev deployment hostname (e.g. `polished-rabbit-123`).
3. Open Slack App Config → your dev app → "App Manifest".
4. Paste the substituted YAML.
5. Click **"Save Changes"**.
   - Slack will run URL verification and reachability checks.
   - The Phase 1 `/slack/events` stub must verify Slack's signed request and echo `body.challenge`; if Slack rejects the request URL, check both 1G deployment and the `SLACK_SIGNING_SECRET` Convex env value.
6. **Verify in the saved-manifest preview that `token_rotation_enabled: true` is rendered.**

**Step 5: Install the dev app to your testing workspace**

In dev App Config → "Install App" → "Install to Workspace" → approve scopes. Generates the first set of dev tokens. Note the bot user ID + workspace ID for sanity checks.

**Step 6: End-to-end dev validation**

1. From a dev tenant browser session, go to `/workspace/settings?tab=integrations` → click "Connect Slack".
2. You should land on slack.com OAuth approval → click Allow.
3. You should redirect to `/workspace/settings?tab=integrations&slack=connected&pickChannel=true`.
4. `npx convex data slackInstallations` should show one row with `status: "active"`, `tokenExpiresAt` ~12h in the future, both `botAccessToken` and `refreshToken` non-empty.
5. Force-expire the token row's `tokenExpiresAt` and run the cron tick:
   ```bash
   npx convex run slack/tokens:refreshExpiringTokens '{}'
   ```
   Verify `tokenExpiresAt` advances and `lastRefreshedAt` is set.

> **Phase A exit gate (per [§5.6.1](../slackbot-design.md)):** force-expire the token + verify both the cron and the JIT helper refresh cleanly **before** running any Phase 2 end-to-end test. This catches lock-primitive bugs before they affect user-driven traffic.

**Step 7: Set Convex env vars on the prod deployment**

Same as Step 2 but for prod. Use the prod secrets from 1A Step 4–5.

```bash
# Path: terminal — switch to prod (CONVEX_DEPLOYMENT=prod:...)
npx convex env set SLACK_CLIENT_ID            "<prod client_id>"
npx convex env set SLACK_CLIENT_SECRET        "<prod client_secret>"
npx convex env set SLACK_SIGNING_SECRET       "<prod signing_secret>"
npx convex env set SLACK_STATE_SIGNING_SECRET "<prod openssl-generated hex>"
npx convex env set SLACK_REDIRECT_URI         "https://<convex-prod>.convex.site/slack/oauth_redirect"
npx convex env set APP_URL                    "https://<prod-app-host>"
```

**Step 8: Deploy the Phase 1 code to prod**

```bash
# Path: terminal
npx convex deploy --prod
```

Verify:

```bash
curl -i "https://<convex-prod>.convex.site/slack/oauth_redirect"
# Expect: 400 "Bad request — missing code or state"
```

**Step 9: Substitute and paste the prod manifest — IRREVERSIBLE GATE**

1. Open `slack-manifest.prod.yaml`.
2. Replace every `<convex-prod>` placeholder with your prod Convex deployment hostname.
3. Open Slack App Config → your prod app → "App Manifest".
4. Paste the substituted YAML.
5. **🚨 BEFORE clicking the final "Save Changes", read the rendered preview line-by-line. Confirm `token_rotation_enabled: true`.** If anything else looks off, **bail out, fix the YAML, re-paste**. Do not save until everything looks right.
6. Click "Save Changes."

**Step 10: Set up alerting on the catastrophic log signature**

Configure your log alerting (Convex Dashboard → "Logs" if available, or your forwarder's matching rule) to **page on first occurrence** of:

```
[Slack:Tokens] CATASTROPHIC refresh-write-fail
```

**Page** (not just notify) — this is the highest-severity scenario in the system per [§14.3](../slackbot-design.md). The runbook entry written in 1I Step 2 documents the response.

**Step 11: Confirm Public Distribution is still disabled (prod only)**

Slack App Config → "Manage Distribution" → "Public Distribution". Confirm it remains **not active**.

Until this toggle is on, no third-party tenant can install. Phase 6 activates it after final QA and the dogfood week.

**Key implementation notes:**
- **🚨 `token_rotation_enabled: true` is irreversible at the app level.** The mitigation rules in [§14.10](../slackbot-design.md) apply here. If it ever goes to prod with `false`, register a brand-new app and force every tenant to re-OAuth.
- **⚠️ ORDER-DEPENDENT (the prod path):** code deploy → env vars → curl smoke test → manifest paste → IRREVERSIBLE-flag preview check → save → leave Public Distribution disabled. Phase 6 performs the launch activation. Skipping the smoke test breaks every install silently.
- **Save the manifest *after* the new deploy is fully promoted** when you change the Convex deployment URL (e.g. branch deploys or a host migration). Slack re-runs URL verification on every save.
- **`SLACK_REDIRECT_URI` must match `oauth_config.redirect_urls[0]` character-for-character** including trailing slash. Mismatches manifest as `bad_redirect_uri` errors at install time.
- **Workspace policy edge:** Some Slack workspaces require workspace-owner approval before any new app install completes. Out of our control; budget half a day in the install window.
- **Distribute to dev workspace first.** Always. The prod app is one careless paste away from a non-recoverable state.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `slack-manifest.dev.yaml` | Create | Dev manifest source-of-truth |
| `slack-manifest.prod.yaml` | Create | Prod manifest source-of-truth (CI-protected — see 1I) |
| Slack App Config (external) | Manual | Paste manifest, verify Public Distribution remains disabled |
| Convex env (dev + prod) | Manual | Set 6 env vars per environment |
| Log alerting config (external) | Manual | Page rule on `[Slack:Tokens] CATASTROPHIC refresh-write-fail` |

---

### 1I — CI Lint Rule + Runbook Entry

**Type:** Config + Documentation
**Parallelizable:** Yes — independent of 1H but should be merged in the same PR window so the lint guard is in place before further manifest changes happen.

**What:** Two small artifacts:
1. A CI step that fails the build if `slack-manifest.prod.yaml` exists with `token_rotation_enabled` set to anything other than `true`.
2. A runbook entry for the catastrophic refresh-succeed-but-write-fail scenario from [§14.3](../slackbot-design.md).

**Why:** The lint rule is a structural defense against the only irreversible mistake in this feature. It's ~10 lines of CI config, and once merged, no PR can accidentally re-introduce the catastrophic configuration. The runbook entry takes a possibly-stressful 3am incident and reduces it to "follow the steps."

**Where:**
- `.github/workflows/slack-manifest-lint.yml` (new — adjust path if the repo uses a different CI provider)
- The team's ops doc / runbook home (external — the PR description should link to the page that's been added)

**How:**

**Step 1: Add the CI lint workflow**

```yaml
# Path: .github/workflows/slack-manifest-lint.yml
name: slack-manifest-lint

on:
  pull_request:
    paths:
      - "slack-manifest.prod.yaml"
  push:
    branches: [main]
    paths:
      - "slack-manifest.prod.yaml"

jobs:
  verify-token-rotation:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Verify token_rotation_enabled is true in prod manifest
        run: |
          # Use yq for robust YAML parsing (any other tool with grep is brittle to indentation).
          sudo wget -qO /usr/local/bin/yq https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64
          sudo chmod +x /usr/local/bin/yq

          VALUE=$(yq '.settings.token_rotation_enabled' slack-manifest.prod.yaml)
          echo "token_rotation_enabled = $VALUE"
          if [ "$VALUE" != "true" ]; then
            echo "::error file=slack-manifest.prod.yaml::token_rotation_enabled MUST be true (irreversible — see slackbot-design.md §4.1, §14.10). Got: $VALUE"
            exit 1
          fi
          echo "OK — token_rotation_enabled is true"
```

**Step 2: Author the runbook entry**

Add an entry to whatever the team uses (Notion, Confluence, `/runbooks/` in this repo). Sample text below — adapt to the tooling available:

```markdown
# Runbook: Slack token refresh write-failure (CATASTROPHIC)

**Severity:** P1 — page on first occurrence.
**Detector:** Log line matching `[Slack:Tokens] CATASTROPHIC refresh-write-fail` (configured in 1H Step 10).
**Affected blast radius:** One tenant — slash command + notifications stop working immediately for that tenant only.

## What happened

Slack returned a fresh `(access_token, refresh_token)` tuple, then our `completeRefresh` mutation
failed to persist it. Slack invalidates the old refresh token the instant a new one is issued —
the persisted refresh token in `slackInstallations` is now dead. The tenant's bot is offline.

## What to do

1. Identify the affected tenant from the log line — copy `tenantId`, `installationId`, `teamId`.
2. Mark the row `status = "token_expired"` if not already (the throw path should have done this;
   verify with `npx convex data slackInstallations | grep <installationId>`).
3. Email / message the tenant admin:
   > "Your Slack integration disconnected unexpectedly. Please go to /workspace/settings?tab=integrations
   > and click Reconnect Slack. Submissions and digests will resume immediately after."
4. (Optional, if the future quarantine table from §14.3 has been built): query
   `slackTokenQuarantine` for the same `installationId`, find the most recent row, and run the
   manual replay action to retry `completeRefresh` with the quarantined tuple.
5. Confirm reconnection: `npx convex data slackInstallations` shows `status: "active"` and a fresh
   `tokenExpiresAt`.

## Prevention

- The CI lint rule on `slack-manifest.prod.yaml` (1I Step 1) prevents the manifest-side cause.
- Section 14.3 of slackbot-design.md tracks code-level mitigation: keep `completeRefresh` ultra-thin
  (one `db.patch`, zero side effects).
```

**Step 3: Verify the lint rule fires**

Open a draft PR that mutates `slack-manifest.prod.yaml` to set `token_rotation_enabled: false`. Push and confirm CI fails red. Close the PR.

**Key implementation notes:**
- **The lint rule is path-scoped** — it only runs when the manifest YAML changes. No CI cost on unrelated PRs.
- **`yq` is robust to indentation** in a way `grep token_rotation_enabled: true` is not. Prefer `yq`.
- **Runbook publication is intentionally non-prescriptive about the storage medium.** What matters is that someone called at 3am can find it; whether it's a Notion page or `runbooks/slack-token-refresh-failure.md` in this repo is a team choice.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `.github/workflows/slack-manifest-lint.yml` | Create | CI guard against `token_rotation_enabled` regression |
| Team runbook (external) | Manual | Add entry for catastrophic refresh-write-fail |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| Slack App Config (external) | Manual | 1A, 1H |
| Team password manager (external) | Manual | 1A |
| Team ops doc (external) | Manual | 1A |
| Team runbook (external) | Manual | 1I |
| Log alerting config (external) | Manual | 1H |
| `convex/schema.ts` | Modify | 1B |
| `convex/lib/slackSignature.ts` | Create | 1C |
| `convex/lib/slackOAuthState.ts` | Create | 1C |
| `convex/slack/oauthStateMutations.ts` | Create | 1C |
| `convex/lib/userLookup.ts` | Create | 1D |
| `convex/requireTenantUserFromAction.ts` | Create | 1D |
| `convex/requireTenantUser.ts` | Optional modify | 1D (defer if risky) |
| `convex/slack/oauth.ts` | Create | 1E |
| `convex/slack/installations.ts` | Create + modify | 1E (CRUD) + 1F (lock primitives) |
| `app/api/slack/start/route.ts` | Create | 1E |
| `app/workspace/settings/_components/settings-page-client.tsx` | Modify | 1E (temporary CTA) |
| `convex/slack/tokens.ts` | Create | 1F |
| `convex/slack/refreshCron.ts` | Create | 1F |
| `convex/slack/cleanup.ts` | Create | 1G |
| `convex/http.ts` | Modify | 1G |
| `convex/crons.ts` | Modify | 1G |
| `slack-manifest.dev.yaml` | Create | 1H |
| `slack-manifest.prod.yaml` | Create | 1H |
| Convex env (dev + prod) | Manual | 1H |
| `.github/workflows/slack-manifest-lint.yml` | Create | 1I |
