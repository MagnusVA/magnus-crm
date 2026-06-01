# Phase 2 — Slash Command & Modal

**Goal:** Land the user-visible entry point: `/qualify-lead` opens a three-field Block Kit modal within Slack's overlapping 3-second deadlines (3s ack on the slash POST, 3s `trigger_id` lifetime), and `view_submission` lands at our `/slack/interactivity` route ready for Phase 3 to write a lead/opportunity. After this phase, a Slack user in any installed workspace can run the slash command, fill the modal, and submit it — but the submission only validates and acks; **no DB writes happen yet** (that's Phase 3).

**Prerequisite:** Phase 1 complete:
- `slackInstallations` rows can be looked up by `(team_id, api_app_id)` (1E `byTeamIdAndAppId`).
- `getValidSlackBotToken(ctx, tenantId)` returns a usable bot token (1F).
- `verifySlackSignature` from `convex/lib/slackSignature.ts` (1C) is importable.
- `/slack/oauth_redirect` is registered in `convex/http.ts` (1G); manifest published with `slash_commands[0].url = /slack/commands` and `interactivity.request_url = /slack/interactivity` (1H).

**Runs in PARALLEL with:** Nothing — Phase 3 depends on the `view_submission` payload shape we land here. (Phase 3 starts the moment 2D — the submission entry point — is merged.)

> **Critical path:** This phase is on the critical path (Phase 1 → **Phase 2** → Phase 3 → Phase 4 → Phase 5 → Phase 6). Specifically the 3-second ack budget in 2C is the single hardest engineering constraint in the project. Pay attention to the cold-start budget table.

**Skills to invoke:**
- `convex-performance-audit` — *consider after Phase 6 ships*. The slash-command hot path has a sub-3s budget, and `convex-performance-audit` is calibrated for exactly this kind of read amplification / cold-start work. Out of scope to invoke during Phase 2 because we don't yet have prod traffic, but the design (§17) flags this for post-launch.

**Acceptance Criteria:**
1. POSTing a Slack-shaped form-encoded body to `/slack/commands` with a valid HMAC signature returns 200 within 3 seconds end-to-end (measured via `curl -w "%{time_total}\n"` against the deployed dev Convex host with a recorded fixture body).
2. POSTing to `/slack/commands` with a tampered body, missing headers, or stale timestamp (> 5 min skew) returns 401 `Bad signature` and logs at warn level — with no DB read, no Slack API call.
3. Running `/qualify-lead` from the dev Slack workspace opens a modal whose title is "Qualify a Lead", whose submit button reads "Create lead", and whose three blocks (`full_name`, `platform`, `handle`) render in that order.
4. The platform select shows exactly the six options `Instagram | TikTok | Twitter/X | Facebook | LinkedIn | Other`, whose `value` strings match the `leadIdentifiers.type` social literals in `convex/schema.ts` (`instagram | tiktok | twitter | facebook | linkedin | other_social`) — verified by a TypeScript-checked `SocialPlatform` union shared between schema and modal builder.
5. Submitting the modal with an empty `handle` returns inline error `"Required"` on the `handle` block (`response_action: "errors"`); modal stays open.
6. Submitting the modal with all required fields returns `{}` (clears the modal); the `view_submission` payload reaches a parser that destructures `tenantId`, `slackUserId`, `teamId`, `appId`, `channelId` from `private_metadata` and `fullName`, `platform`, `handle` from `view.state.values`. The payload is logged but **no lead/opportunity write yet** — Phase 3 wires that.
7. If the slash command arrives with a `(team_id, api_app_id)` whose `slackInstallations` row is missing or `status != "active"`, the handler returns 200 with an ephemeral message: `"Slack integration disconnected — ask an admin to reconnect in the CRM."` (no modal opens).
8. If `views.open` returns `expired_trigger_id`, the handler logs at warn and returns 200 (Slack already gave up). If it returns any other Slack error, the handler logs at error and returns 200 (modal didn't open; Slack will not retry).
9. The `/slack/interactivity` route also verifies HMAC signature; tampered bodies return 401 with no parsing.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
2A (Block Kit + types) ────────────────────────┐
                                                ├── 2C (slash command handler) ───┐
2B (HTTP route registration + raw-event store) ─┤                                   │
                                                │                                   ├── 2E (E2E verify)
                                                └── 2D (interactivity ack-only) ────┘
```

**Optimal execution:**
1. Start **2A** (Block Kit builders + shared `SocialPlatform` union) and **2B** (HTTP route registration + `rawSlackEvents` insert helper) in parallel — they touch different files.
2. Once **2A** is merged, start **2C** (slash command handler — imports `buildQualifyLeadModal`).
3. **2D** (interactivity handler — ack-only stub) can land in parallel with 2C; both are independent and end at the same Slack-API surface.
4. **2E** is end-to-end manual verification — runs from a real dev Slack workspace once 2C + 2D are deployed.

**Estimated time:** 3–4 days. Code is small (~300 LOC) but the cold-start budget tuning, error-path handling, and modal-copy iteration take more time than the LOC count suggests.

---

## Subphases

### 2A — Block Kit Modal Builder + Shared Platform Union

**Type:** Backend (typed builder)
**Parallelizable:** Yes — independent of 2B, blocks 2C.

**What:** Two artifacts:
1. `convex/lib/slackBlockKit.ts` — typed builders for the Slack Block Kit modal payload. v1 contains only `buildQualifyLeadModal`; Phase 5 adds `buildQualifiedLeadConfirmation` and `buildStaleDigest` here.
2. A shared `SocialPlatform` union type, exported from a single source-of-truth file and imported by both `convex/schema.ts:leadIdentifiers.type` and `slackBlockKit.ts:buildQualifyLeadModal`. Stops drift dead.

**Why:** Per [`slackbot-design.md` §5.4](../slackbot-design.md), the `static_select` options must align 1:1 with `leadIdentifiers.type` social literals. Slack accepts any string — drift is silent until `resolveLeadIdentity` rejects an unknown handle type *after* the user already submitted. Centralizing the union turns this into a TypeScript compile-time check.

The Block Kit builder is typed to give us inline-error feedback when reviewing the YAML-shaped JSON payload, and so future blocks (e.g. the optional notes field in Open Q9) can be added with autocomplete.

**Where:**
- `convex/lib/socialPlatform.ts` (new) — single source of truth for the social-platform union
- `convex/lib/slackBlockKit.ts` (new)

**How:**

**Step 1: Establish the shared platform union**

```typescript
// Path: convex/lib/socialPlatform.ts

import { v } from "convex/values";

/**
 * Social-platform identifiers shared between:
 *   - `leadIdentifiers.type` (schema literals — convex/schema.ts line ~163)
 *   - `slackBlockKit.buildQualifyLeadModal` `static_select` options
 *
 * Adding a platform requires:
 *   1. Add literal here.
 *   2. Add to `leadIdentifiersTypeValidator` (re-export below).
 *   3. Add to `SOCIAL_PLATFORM_LABELS`.
 *   4. Run a widen-migrate-narrow (rare — historical types persist).
 */
export const SOCIAL_PLATFORMS = [
  "instagram",
  "tiktok",
  "twitter",
  "facebook",
  "linkedin",
  "other_social",
] as const;

export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export const SOCIAL_PLATFORM_LABELS: Record<SocialPlatform, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  twitter: "Twitter/X",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  other_social: "Other",
};

/**
 * Convex-values validator usable in `args:` blocks and table definitions.
 * Importing this from schema.ts plus blockKit.ts guarantees no drift.
 */
export const socialPlatformValidator = v.union(
  v.literal("instagram"),
  v.literal("tiktok"),
  v.literal("twitter"),
  v.literal("facebook"),
  v.literal("linkedin"),
  v.literal("other_social"),
);
```

**Step 2: Verify (don't yet refactor) `convex/schema.ts:leadIdentifiers.type` to use the shared validator**

The existing schema hand-rolls these literals. Tightening it to use `socialPlatformValidator` is **strictly better** but introduces a 1-line schema diff per literal — still safe (no data backfill, just a type-equivalent rewrite). Decide per PR-policy whether to do the rewrite in this subphase or leave it for a later cleanup. **Recommendation:** do it now while you're in the file.

```typescript
// Path: convex/schema.ts (locate the existing leadIdentifiers table definition)

// BEFORE:
type: v.union(
  v.literal("email"),
  v.literal("phone"),
  v.literal("instagram"),
  v.literal("tiktok"),
  v.literal("twitter"),
  v.literal("facebook"),
  v.literal("linkedin"),
  v.literal("other_social"),
),

// AFTER:
import { socialPlatformValidator } from "./lib/socialPlatform";  // top of file

type: v.union(
  v.literal("email"),
  v.literal("phone"),
  // Social platforms are sourced from convex/lib/socialPlatform.ts so the slash-command
  // modal options align by construction. Adding a platform changes both at once.
  ...socialPlatformValidator.members,
),
```

> **Note**: `v.union(...).members` is the documented way to splice another union — verify against `convex/_generated/dataModel.d.ts` after `npx convex dev` regenerates.

**Step 3: Implement the Block Kit builder**

```typescript
// Path: convex/lib/slackBlockKit.ts

import type { Id } from "../_generated/dataModel";
import { SOCIAL_PLATFORMS, SOCIAL_PLATFORM_LABELS } from "./socialPlatform";

/**
 * Verified context stuffed into `private_metadata` at modal-open time.
 * Slack returns this verbatim on `view_submission`. The 3000-char budget
 * is generous; we use a few hundred bytes.
 *
 * SECURITY: only put values we already verified from the slash-command HMAC
 * payload. Never trust `private_metadata` to introduce new tenantId/role data.
 */
export type QualifyLeadModalMetadata = {
  tenantId: Id<"tenants">;
  slackUserId: string;
  teamId: string;
  appId: string;
  channelId: string;
};

/**
 * Block Kit `views.open` payload for /qualify-lead.
 * Per .docs/slack/modals.md and .docs/slack/block-kit.md.
 */
export function buildQualifyLeadModal(meta: QualifyLeadModalMetadata) {
  return {
    type: "modal" as const,
    callback_id: "qualify_lead_submit",
    private_metadata: JSON.stringify(meta),
    title: { type: "plain_text" as const, text: "Qualify a Lead" },
    submit: { type: "plain_text" as const, text: "Create lead" },
    close: { type: "plain_text" as const, text: "Cancel" },
    blocks: [
      {
        type: "input" as const,
        block_id: "full_name",
        label: { type: "plain_text" as const, text: "Full name" },
        element: {
          type: "plain_text_input" as const,
          action_id: "v",
          max_length: 200,
        },
      },
      {
        type: "input" as const,
        block_id: "platform",
        label: { type: "plain_text" as const, text: "Social platform" },
        element: {
          type: "static_select" as const,
          action_id: "v",
          placeholder: { type: "plain_text" as const, text: "Pick one" },
          options: SOCIAL_PLATFORMS.map((p) => ({
            text: { type: "plain_text" as const, text: SOCIAL_PLATFORM_LABELS[p] },
            value: p,
          })),
        },
      },
      {
        type: "input" as const,
        block_id: "handle",
        label: { type: "plain_text" as const, text: "Social handle" },
        element: {
          type: "plain_text_input" as const,
          action_id: "v",
          placeholder: { type: "plain_text" as const, text: "@username" },
          max_length: 80,
        },
      },
    ],
  } as const;
}

/**
 * Parsed values from a `view_submission` payload.
 * Used by Phase 3's `convex/slack/createQualifiedLead.ts`.
 */
export type ParsedQualifyLeadSubmission = QualifyLeadModalMetadata & {
  fullName: string;
  platform: (typeof SOCIAL_PLATFORMS)[number];
  handle: string;
};

type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

function isSocialPlatform(value: unknown): value is SocialPlatform {
  return typeof value === "string" && SOCIAL_PLATFORMS.includes(value as SocialPlatform);
}

/**
 * Tolerant parser. Returns null on any structural mismatch — caller decides
 * whether to log + 401 or continue with errors.
 */
export function parseQualifyLeadSubmission(
  view: any,
): ParsedQualifyLeadSubmission | null {
  try {
    const meta = JSON.parse(view.private_metadata) as QualifyLeadModalMetadata;
    const v = view.state?.values;
    const fullName = String(v.full_name?.v?.value ?? "").trim();
    const platformRaw = v.platform?.v?.selected_option?.value;
    const handle = String(v.handle?.v?.value ?? "").trim();

    if (!isSocialPlatform(platformRaw)) return null;

    return {
      tenantId: meta.tenantId,
      slackUserId: meta.slackUserId,
      teamId: meta.teamId,
      appId: meta.appId,
      channelId: meta.channelId,
      fullName,
      platform: platformRaw,
      handle,
    };
  } catch {
    return null;
  }
}
```

**Step 4: Validate at deploy**

```bash
# Path: terminal
pnpm tsc --noEmit
npx convex dev
```

`SocialPlatform` should resolve identically wherever imported. If `convex/schema.ts` still has its hand-rolled literal list, this is the moment to delete it. Inverting: if a teammate already deleted the union somewhere else, the `.members` spread above will fail loudly — an excellent failure mode.

**Key implementation notes:**
- **Splicing the union via `socialPlatformValidator.members`** is fragile to Convex's internal representation. If the spread does not work in your version, fall back to repeating the literals in both `socialPlatform.ts` and `schema.ts`, with a comment in each pointing at the other. The union is small (six literals) — duplication is cheap.
- **`max_length` on inputs** is a defensive cap (200 chars on full name, 80 on handle). Slack itself enforces no maximum; without one, a hostile user can paste megabytes of text. Caps here mean Phase 3 doesn't need cap defense in turn.
- **Slack does not collect email or phone** in the qualification modal. Calendly or CRM contact surfaces own verified contact collection.
- **`private_metadata` carries already-verified context.** [§13.2](../slackbot-design.md) is explicit: never extend it to carry new `tenantId` or role data. The submission re-verifies the metadata's `tenantId` against the `(team_id, api_app_id)` on the submission payload before any write.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/socialPlatform.ts` | Create | Shared `SocialPlatform` union + validator |
| `convex/lib/slackBlockKit.ts` | Create | `buildQualifyLeadModal` + `parseQualifyLeadSubmission` |
| `convex/schema.ts` | Modify (recommended) | Refactor `leadIdentifiers.type` to import from `socialPlatform.ts` |

---

### 2B — HTTP Route Registration + Raw-Event Audit Helper

**Type:** Backend (configuration + utility)
**Parallelizable:** Yes — independent of 2A. Preserves the Phase 1 route stubs while landing the `rawSlackEvents` redaction helper used by 2C and 2D.

**What:**
- Leave the Phase 1 stub routes in `convex/http.ts` in place. Do not recreate `convex/slack/inboundStubs.ts` or remove `/slack/events`; 2C and 2D do in-place route swaps for commands/interactivity only.
- Implement `convex/slack/rawEventsAudit.ts` — the redaction-aware insert helper that every inbound handler will call to persist a tamper-resistant audit trail. Phase 3 schema extends this with the `rawSlackEvents` table; for Phase 2 we land the helper interface and a no-op implementation gated behind a feature flag, then flip it on in Phase 3.

**Why:** Two reasons:
1. **The manifest URLs must respond.** The Phase 1 manifest publish (1H) registered `slash_commands[0].url = /slack/commands` and `interactivity.request_url = /slack/interactivity`. If Slack sends a request to a 404, it surfaces as `dispatch_failed` to the user with no signal to operators. The stubs return clean 401s on bad signatures, eliminating the 404 case forever.
2. **Audit is non-negotiable.** Per [§13.7](../slackbot-design.md), every inbound payload must be redaction-stored for diagnostics. Centralizing now means 2C/2D are clean; the `rawSlackEvents` schema lands in Phase 3 alongside `slackUsers` and the Slack-side source/status widen.

**Where:**
- `convex/http.ts` (modify only in 2C/2D to swap handlers; no route removal in 2B)
- `convex/slack/inboundStubs.ts` (already created in Phase 1 — preserve, especially `slackEventsStub`)
- `convex/slack/rawEventsAudit.ts` (new) — redaction helper interface

**How:**

**Step 1: Implement the redaction helper interface**

```typescript
// Path: convex/slack/rawEventsAudit.ts

import { createHash } from "node:crypto";
import type { ActionCtx } from "../_generated/server";

/**
 * Sensitive keys that must be removed before persistence.
 * Per slackbot-design.md §13.7 — Slack inbound bodies can include PII
 * and short-lived response_url webhook URLs.
 */
const REDACTED_KEYS = new Set([
  "response_url",
  "trigger_id",
  "token",          // legacy verification token
  "ssl_check",
]);

const REDACTED_PII_KEYS = new Set([
  "email",
  "phone",
  "real_name",
  "first_name",
  "last_name",
]);

function redact(value: any, depth = 0): any {
  if (depth > 8) return "<redacted:depth>";
  if (value == null) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) {
    if (REDACTED_KEYS.has(k)) continue;
    if (REDACTED_PII_KEYS.has(k)) {
      out[k] = "<redacted:pii>";
      continue;
    }
    out[k] = redact(v, depth + 1);
  }
  return out;
}

export type RawSlackEventInsert = {
  teamId: string;
  apiAppId?: string;
  eventType: string;
  rawBody: string;
  parsedPayload: unknown; // already-parsed body for redaction; pass null if not parsed
  slackEventId?: string;
};

/**
 * Computes the persistence-safe envelope. Phase 3's schema deploy adds the
 * `rawSlackEvents` table; until then, callers receive a no-op (logs only).
 *
 * Returns the redacted JSON string + sha256(rawBody) so callers can log
 * the request hash even before the table exists.
 */
export function buildRawEventEnvelope(args: RawSlackEventInsert) {
  const requestHash = createHash("sha256").update(args.rawBody).digest("hex");
  const payloadRedacted = JSON.stringify(redact(args.parsedPayload));
  return {
    teamId: args.teamId,
    apiAppId: args.apiAppId,
    eventType: args.eventType,
    payloadRedacted,
    requestHash,
    slackEventId: args.slackEventId,
  };
}

/**
 * Side-effect-free placeholder. Phase 3 replaces this with a real internal
 * mutation that persists to the `rawSlackEvents` table.
 *
 * Until then we still call this from 2C/2D so the call-sites are stable —
 * we just log the envelope at info level.
 */
export async function persistRawSlackEvent(
  _ctx: ActionCtx,
  args: RawSlackEventInsert,
): Promise<void> {
  const envelope = buildRawEventEnvelope(args);
  console.log("[Slack:Audit] envelope", {
    teamId: envelope.teamId,
    apiAppId: envelope.apiAppId,
    eventType: envelope.eventType,
    requestHash: envelope.requestHash,
    slackEventId: envelope.slackEventId,
  });
  // Phase 3 will: await ctx.runMutation(internal.slack.rawEvents.insert, envelope);
}
```

**Step 2: Verify the Phase 1 stubs are still registered**

```typescript
// Path: convex/slack/inboundStubs.ts

// This file already exists from Phase 1 and must still export:
// - slackCommandStub
// - slackInteractivityStub
// - slackEventsStub
//
// Do not replace it with a two-export file. `/slack/events` must keep returning
// a manifest-safe URL-verification response until Phase 6 swaps in events.ts.
```

**Step 3: Confirm `http.ts` still has all three Phase 1 Slack routes**

```typescript
// Path: convex/http.ts

import { httpRouter } from "convex/server";
import { authKit } from "./auth";
import { handleCalendlyWebhook } from "./webhooks/calendly";
import { oauthRedirect } from "./slack/oauth";
import {
  slackCommandStub,         // replaced in 2C
  slackInteractivityStub,   // replaced in 2D
  slackEventsStub,          // preserved until Phase 6
} from "./slack/inboundStubs";

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
  handler: slackCommandStub,                    // 2C will swap to slashCommand
});

http.route({
  path: "/slack/interactivity",
  method: "POST",
  handler: slackInteractivityStub,              // 2D will swap to interactivity
});

http.route({
  path: "/slack/events",
  method: "POST",
  handler: slackEventsStub,                     // Phase 6 swaps this for events.handleEvent
});

export default http;
```

> **2C/2D do an in-place swap.** When `convex/slack/commands.ts` and `convex/slack/interactivity.ts` ship, change only those two imports/handlers. Keep `/slack/events` wired to `slackEventsStub` until Phase 6.

**Step 4: Verify**

```bash
# Path: terminal
curl -i -X POST "https://<convex-dev>.convex.site/slack/commands"
# Expect: 401 "Bad signature" (no signature provided)

curl -i -X POST "https://<convex-dev>.convex.site/slack/interactivity"
# Expect: 401 "Bad signature"
```

**Key implementation notes:**
- **The stub returns 503** (not 200) on a *valid* signature — so anyone hitting the route during the 2A→2C window gets a clear "not yet deployed" surface. After 2C, the real handler returns 200.
- **`rawEventsAudit.ts` is forward-compatible.** Phase 3's schema adds the table; Phase 2 ships the call sites and the no-op writer. This avoids wiring everything twice.
- **Redaction is recursive.** The depth limit (8) defends against a hostile or malformed payload.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/http.ts` | Verify / later modify | Preserve all Phase 1 routes; 2C/2D swap command + interactivity handlers only |
| `convex/slack/inboundStubs.ts` | Verify | Already created in Phase 1; preserve `slackEventsStub` |
| `convex/slack/rawEventsAudit.ts` | Create | Redaction helper + forward-compatible no-op writer |

---

### 2C — Slash Command Handler (`convex/slack/commands.ts`)

**Type:** Backend
**Parallelizable:** Yes — runs in parallel with 2D once 2A is merged.

**What:** The real `/slack/commands` POST handler. Verifies HMAC, parses the form-encoded body, looks up the installation by `(team_id, api_app_id)`, retrieves a valid bot token, and calls `views.open` — all before responding 200. The handler must complete within 3 seconds end-to-end.

**Why:** This is the single hardest engineering constraint in the project. Per [§5.1](../slackbot-design.md), two deadlines apply at once:
1. The slash command POST must receive 200 within **3 seconds**.
2. The `trigger_id` returned with that POST expires **3 seconds** after issuance — `views.open` must succeed before then.

You **cannot** ack first and open the modal asynchronously. Convex isolate cold-start is 50–200ms; with discipline this fits inside the budget.

**Where:**
- `convex/slack/commands.ts` (new)
- `convex/http.ts` (modify — swap stub for real handler)

**How:**

**Step 1: Implement the handler**

```typescript
// Path: convex/slack/commands.ts
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { verifySlackSignature } from "../lib/slackSignature";
import { buildQualifyLeadModal } from "../lib/slackBlockKit";
import { getValidSlackBotToken } from "./tokens";
import { persistRawSlackEvent } from "./rawEventsAudit";

const SIG_HEADER = "x-slack-signature";
const TS_HEADER = "x-slack-request-timestamp";

/**
 * `/slack/commands` POST handler.
 *
 * Hot path constraints:
 *   - 3-second budget end-to-end (Slack ack)
 *   - 3-second trigger_id lifetime (must views.open inside the same window)
 *   - Convex isolate cold-start: 50–200 ms
 *
 * Disciplined hot path:
 *   1. Capture rawBody before parsing (HMAC requires byte-exact body).
 *   2. Verify signature.
 *   3. Parse form body.
 *   4. ONE indexed query: byTeamIdAndAppId.
 *   5. ONE token call: getValidSlackBotToken (fast path returns cached).
 *   6. ONE Slack API call: views.open.
 *   7. Return 200.
 *
 * Anything else (audit log, error reporting, retries) goes on a scheduled
 * tail-call so it doesn't burn the budget.
 */
export const slashCommand = httpAction(async (ctx, req) => {
  const startedAt = Date.now();
  const rawBody = await req.text();

  // ── 1. Verify HMAC ────────────────────────────────────────────────────────
  const ok = verifySlackSignature({
    rawBody,
    timestamp: req.headers.get(TS_HEADER) ?? "",
    signature: req.headers.get(SIG_HEADER) ?? "",
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
    previousSigningSecret: process.env.SLACK_SIGNING_SECRET_PREVIOUS,
  });
  if (!ok) {
    console.warn("[Slack:Cmd] bad signature");
    return new Response("Bad signature", { status: 401 });
  }

  // ── 2. Parse form body (URL-encoded, per .docs/slack/implementing-slash-commands.md) ──
  const params = new URLSearchParams(rawBody);
  const teamId = params.get("team_id") ?? "";
  const apiAppId = params.get("api_app_id") ?? "";
  const triggerId = params.get("trigger_id") ?? "";
  const slackUserId = params.get("user_id") ?? "";
  const channelId = params.get("channel_id") ?? "";
  const command = params.get("command") ?? "";

  if (!teamId || !apiAppId || !triggerId || !slackUserId || command !== "/qualify-lead") {
    console.warn("[Slack:Cmd] malformed payload", { teamId, apiAppId, command, hasTrigger: Boolean(triggerId) });
    return new Response("Bad request", { status: 400 });
  }

  // ── 3. Lookup installation ────────────────────────────────────────────────
  const inst = await ctx.runQuery(internal.slack.installations.byTeamIdAndAppId, {
    teamId,
    appId: apiAppId,
  });
  if (!inst || inst.status !== "active") {
    // Audit-log the rejection. The helper is awaited so the audit path is durable.
    await persistRawSlackEvent(ctx, {
      teamId,
      apiAppId,
      eventType: "slash_command_rejected",
      rawBody,
      parsedPayload: { reason: !inst ? "no_installation" : `status_${inst.status}` },
    });
    // 200 with ephemeral text is the user-visible feedback Slack expects on disconnect.
    return jsonResponse({
      response_type: "ephemeral",
      text: "Slack integration disconnected — ask an admin to reconnect in the CRM.",
    });
  }

  // ── 4. Get bot token (fast path: in-memory; slow path: refresh under lock) ──
  let token: string;
  try {
    token = await getValidSlackBotToken(ctx, inst.tenantId);
  } catch (e) {
    console.error("[Slack:Cmd] token unavailable", {
      tenantId: inst.tenantId,
      err: e instanceof Error ? e.message : "unknown",
    });
    return jsonResponse({
      response_type: "ephemeral",
      text:
        "Couldn't open the form — Slack token is being refreshed. " +
        "Try `/qualify-lead` again in a moment.",
    });
  }

  // ── 5. views.open ─────────────────────────────────────────────────────────
  try {
    const response = await fetch("https://slack.com/api/views.open", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        trigger_id: triggerId,
        view: buildQualifyLeadModal({
        tenantId: inst.tenantId,
        slackUserId,
        teamId,
        appId: apiAppId,
        channelId,
      }),
      }),
    });
    const data = await response.json() as { ok: boolean; error?: string };
    if (!data.ok) throw new Error(data.error ?? "unknown");
  } catch (e: unknown) {
    const slackErr = e instanceof Error ? e.message : undefined;
    if (slackErr === "expired_trigger_id") {
      // Slack already gave up; modal cannot open. Best we can do is encourage retry.
      console.warn("[Slack:Cmd] expired_trigger_id", { tenantId: inst.tenantId, latencyMs: Date.now() - startedAt });
    } else {
      console.error("[Slack:Cmd] views.open failed", {
        tenantId: inst.tenantId,
        slackErr,
        err: e instanceof Error ? e.message : "unknown",
      });
    }
    // Slack does not retry slash commands. Returning 200 keeps Slack from showing
    // a generic operation_timeout — this is intentional even on failure.
    return jsonResponse({
      response_type: "ephemeral",
      text:
        slackErr === "expired_trigger_id"
          ? "Slack timed out opening the form. Try `/qualify-lead` again."
          : "Couldn't open the form. Please try again — if it persists, ask an admin.",
    });
  }

  // ── 6. Audit (await helper enqueue/write; do not fire-and-forget) ─────────
  await persistRawSlackEvent(ctx, {
    teamId,
    apiAppId,
    eventType: "slash_command",
    rawBody,
    parsedPayload: Object.fromEntries(params.entries()),
  });

  console.log("[Slack:Cmd] ok", {
    tenantId: inst.tenantId,
    latencyMs: Date.now() - startedAt,
  });

  // Plain 200; Slack ignores the body when no `response_type` is provided.
  return new Response("", { status: 200 });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
```

**Step 2: Swap the route registration**

```typescript
// Path: convex/http.ts (modify the import + handler)

// BEFORE (from 2B):
import {
  slackCommandStub,
  slackInteractivityStub,
  slackEventsStub,
} from "./slack/inboundStubs";
//
http.route({ path: "/slack/commands",      method: "POST", handler: slackCommandStub });

// AFTER:
import { slashCommand } from "./slack/commands";
import { slackInteractivityStub, slackEventsStub } from "./slack/inboundStubs";
//
http.route({ path: "/slack/commands",      method: "POST", handler: slashCommand });
http.route({ path: "/slack/interactivity", method: "POST", handler: slackInteractivityStub });
http.route({ path: "/slack/events",        method: "POST", handler: slackEventsStub });
```

**Step 3: Add Block Kit types**

```bash
# Path: terminal
pnpm add @slack/types
```

Verify:

```bash
ls node_modules/@slack/types/package.json     # should exist
```

**Step 4: Smoke-test against the live Slack workspace**

In the dev workspace from Phase 1:

1. Run `/qualify-lead` in any channel.
2. Modal should open within 1–2 seconds.
3. Check Convex logs:
   ```
   [Slack:Cmd] ok { tenantId: '…', latencyMs: 350 }
   ```
   `latencyMs` should be < 1500. If routinely > 1500, investigate what's taking time:
   - Cold-start is the most common culprit — Convex isolates may be evicted between calls.
   - `getValidSlackBotToken` taking the slow path (token refresh) adds ~300ms.
   - If `views.open` is slow, it's almost always Slack-side; nothing to do.

**Key implementation notes:**
- **Capture `rawBody` before parsing.** `URLSearchParams` is fine to call after, but the HMAC verification requires byte-exact input. `req.text()` consumes the body once — this is the correct order.
- **`Content-Type: application/x-www-form-urlencoded`** for slash commands per [`.docs/slack/implementing-slash-commands.md`](../../../.docs/slack/implementing-slash-commands.md). For `view_submission` (2D), it's `application/x-www-form-urlencoded` with a `payload=<json>` field — see 2D.
- **Await `persistRawSlackEvent(...)`; never use `void`.** Phase 2's helper is a no-op logger, and Phase 3 replaces it with a real write/enqueue. If audit latency threatens the 3-second Slack budget, change the helper internals to `await ctx.scheduler.runAfter(0, ...)`; call sites must still await the enqueue so the audit path is durable.
- **`views.open` returns Slack-side errors in the JSON body** — `expired_trigger_id`, `not_in_channel`, etc. We log and return 200 because Slack does not retry slash commands and showing the user a generic "didn't work" is worse than an ephemeral message.
- **No `response_url` use here.** `response_url` is a 30-min late-acknowledge mechanism; we don't need it because we ack synchronously. Phase 6 may revisit if we add response-URL-based notifications.
- **Verify `process.env.SLACK_SIGNING_SECRET`** is set on the active Convex deployment before deploying — otherwise the handler will reject every request as bad signature. This was set in Phase 1 1H Step 2/7, but a follow-up env-var rotation could surface as 100% bad-signature rejection. Watch the warn logs.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/slack/commands.ts` | Create | The hot-path slash command handler |
| `convex/http.ts` | Modify | Swap `slackCommandStub` → `slashCommand`; preserve `slackEventsStub` |
| `package.json` + `pnpm-lock.yaml` | Modify | Add `@slack/types` dependency |

---

### 2D — Interactivity Ack (`convex/slack/interactivity.ts`)

**Type:** Backend
**Parallelizable:** Yes — runs in parallel with 2C.

**What:** The real `/slack/interactivity` POST handler. Verifies HMAC, parses the `payload` form field (Slack sends the JSON payload base64-or-form-encoded), and returns the appropriate `response_action`. **In Phase 2 this handler does no DB writes** — it parses, validates, and returns either:
- `{}` (clear modal) on a valid `view_submission` (Phase 3 inserts this branch).
- `{ response_action: "errors", errors: { handle: "Required" } }` on validation failure.

Phase 3 replaces the `// TODO Phase 3` block with the actual lead/opportunity write.

**Why:** Same 3-second ack budget as 2C, but easier — no `trigger_id` involved on submit. The reason we land it now (rather than waiting until Phase 3) is twofold:
1. The route URL must respond from the moment the manifest is published (1H), and stub-only-forever is dangerous (production traffic could submit before Phase 3 ships).
2. We can validate the inline-error UX (Slack `response_action: "errors"`) end-to-end before the lead-write path is wired — much easier to debug in isolation.

**Where:**
- `convex/slack/interactivity.ts` (new)
- `convex/http.ts` (modify — swap stub)

**How:**

**Step 1: Implement the ack-only handler**

```typescript
// Path: convex/slack/interactivity.ts
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { verifySlackSignature } from "../lib/slackSignature";
import {
  parseQualifyLeadSubmission,
  type ParsedQualifyLeadSubmission,
} from "../lib/slackBlockKit";
import { persistRawSlackEvent } from "./rawEventsAudit";

const SIG_HEADER = "x-slack-signature";
const TS_HEADER = "x-slack-request-timestamp";

/**
 * `/slack/interactivity` POST handler.
 *
 * Phase 2 contract (this file):
 *   - Verify HMAC, parse, validate fields.
 *   - On success: log + return {} (clears modal). NO DB WRITE.
 *   - On validation error: return response_action=errors.
 *
 * Phase 3 contract: replace the "// PHASE 3 INSERT" block with
 * `await ctx.runMutation(internal.slack.createQualifiedLead.create, {...})`,
 * branch on duplicate / out-of-window / etc., and surface inline errors per §7.3.
 */
export const interactivity = httpAction(async (ctx, req) => {
  const rawBody = await req.text();

  // ── 1. Verify HMAC ────────────────────────────────────────────────────────
  const ok = verifySlackSignature({
    rawBody,
    timestamp: req.headers.get(TS_HEADER) ?? "",
    signature: req.headers.get(SIG_HEADER) ?? "",
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
    previousSigningSecret: process.env.SLACK_SIGNING_SECRET_PREVIOUS,
  });
  if (!ok) {
    console.warn("[Slack:Int] bad signature");
    return new Response("Bad signature", { status: 401 });
  }

  // ── 2. Decode the payload field ───────────────────────────────────────────
  // Per .docs/slack/handling-user-interaction.md, Slack POSTs application/x-www-form-urlencoded
  // with a single "payload" field whose value is JSON. Other fields exist but are not the truth source.
  const form = new URLSearchParams(rawBody);
  const payloadRaw = form.get("payload");
  if (!payloadRaw) {
    console.warn("[Slack:Int] missing payload field");
    return new Response("Bad request", { status: 400 });
  }

  let payload: any;
  try {
    payload = JSON.parse(payloadRaw);
  } catch {
    console.warn("[Slack:Int] payload not JSON");
    return new Response("Bad request", { status: 400 });
  }

  const teamId = payload?.team?.id ?? payload?.user?.team_id ?? "";
  const apiAppId = payload?.api_app_id ?? "";

  // Audit (await helper enqueue/write; Phase 3 makes this durable).
  await persistRawSlackEvent(ctx, {
    teamId,
    apiAppId,
    eventType: payload?.type ?? "unknown",
    rawBody,
    parsedPayload: payload,
  });

  // ── 3. Branch on payload.type ─────────────────────────────────────────────
  // v1 only handles view_submission for the qualify-lead modal.
  if (payload?.type !== "view_submission") {
    console.log("[Slack:Int] ignored type", { type: payload?.type });
    return new Response("", { status: 200 });
  }
  if (payload?.view?.callback_id !== "qualify_lead_submit") {
    console.log("[Slack:Int] ignored callback_id", { callback_id: payload?.view?.callback_id });
    return new Response("", { status: 200 });
  }

  // ── 4. Re-verify the metadata ─────────────────────────────────────────────
  const parsed = parseQualifyLeadSubmission(payload.view);
  if (!parsed) {
    console.error("[Slack:Int] view payload malformed");
    return jsonResponse({ response_action: "errors", errors: { handle: "Couldn't parse — please try again." } });
  }

  // CRITICAL: re-verify private_metadata's tenantId against the team_id +
  // api_app_id on the submission payload. The metadata was verified at
  // modal-open time, but a malicious extension cannot be trusted to retain
  // integrity.
  if (apiAppId && apiAppId !== parsed.appId) {
    console.error("[Slack:Int] appId mismatch — possible tampering", {
      metadataAppId: parsed.appId,
      payloadAppId: apiAppId,
      teamId: parsed.teamId,
    });
    return jsonResponse({
      response_action: "errors",
      errors: { handle: "Submission verification failed — please retry." },
    });
  }
  const inst = await ctx.runQuery(internal.slack.installations.byTeamIdAndAppId, {
    teamId: parsed.teamId,
    appId: parsed.appId,
  });
  if (!inst || inst.tenantId !== parsed.tenantId) {
    console.error("[Slack:Int] tenantId mismatch — possible tampering", {
      metadataTenant: parsed.tenantId,
      installationTenant: inst?.tenantId,
      teamId: parsed.teamId,
      appId: parsed.appId,
    });
    return jsonResponse({
      response_action: "errors",
      errors: { handle: "Submission verification failed — please retry." },
    });
  }

  // ── 5. Field-level validation ─────────────────────────────────────────────
  const fieldErrors: Record<string, string> = {};
  if (parsed.fullName.length === 0) fieldErrors.full_name = "Required";
  if (parsed.handle.length === 0) fieldErrors.handle = "Required";

  if (Object.keys(fieldErrors).length > 0) {
    return jsonResponse({ response_action: "errors", errors: fieldErrors });
  }

  // ── 6. PHASE 3 INSERT POINT ───────────────────────────────────────────────
  // In Phase 3 this becomes:
  //   const result = await ctx.runMutation(internal.slack.createQualifiedLead.create, {
  //     tenantId: parsed.tenantId,
  //     fullName: parsed.fullName,
  //     platform: parsed.platform,
  //     handle: parsed.handle,
  //     qualifiedBy: { slackUserId: parsed.slackUserId, slackTeamId: parsed.teamId, submittedAt: Date.now() },
  //   });
  //   if (result.duplicate) {
  //     return jsonResponse({ response_action: "errors", errors: { handle: `Already qualified by <@${...}>` } });
  //   }
  console.log("[Slack:Int] view_submission ok (Phase 2 — no write)", {
    tenantId: parsed.tenantId,
    slackUserId: parsed.slackUserId,
    platform: parsed.platform,
    handle: parsed.handle,
  });

  // Empty body clears the modal.
  return new Response("", { status: 200 });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
```

**Step 2: Swap the route registration**

```typescript
// Path: convex/http.ts (modify import + handler)

// BEFORE:
import { slashCommand } from "./slack/commands";
import { slackInteractivityStub, slackEventsStub } from "./slack/inboundStubs";
//
http.route({ path: "/slack/interactivity", method: "POST", handler: slackInteractivityStub });

// AFTER:
import { slashCommand } from "./slack/commands";
import { interactivity } from "./slack/interactivity";
import { slackEventsStub } from "./slack/inboundStubs";
//
http.route({ path: "/slack/commands",      method: "POST", handler: slashCommand });
http.route({ path: "/slack/interactivity", method: "POST", handler: interactivity });
http.route({ path: "/slack/events",        method: "POST", handler: slackEventsStub });
//
http.route({ path: "/slack/interactivity", method: "POST", handler: interactivity });
```

**Step 3: Verify**

In the dev workspace:

1. Run `/qualify-lead` again.
2. Submit with all fields blank. Modal should stay open with "Required" labels under `full_name` and `handle`.
3. Submit with all required fields filled. Modal should close. Convex logs should print:
   ```
   [Slack:Int] view_submission ok (Phase 2 — no write) { tenantId: '…', slackUserId: 'U…', platform: 'instagram', handle: '@janedoe' }
   ```
4. (No DB row was written — that's Phase 3.)

**Key implementation notes:**
- **The `payload` field is JSON-stringified, then form-encoded.** This double encoding is per Slack convention; `URLSearchParams.get("payload")` handles the unwrap correctly, then we `JSON.parse`.
- **Re-verifying `private_metadata.tenantId` against `(team_id, api_app_id)` is non-negotiable.** [§13.2](../slackbot-design.md) treats `(team_id, api_app_id)` as the Slack-side tenant trust boundary. Phase 2 enforces this even before Phase 3 has a write to gate.
- **The "Phase 3 insert point" comment is intentional.** Reviewers reading 2D should see exactly where Phase 3 plugs in. Keep the comment block in 2D's PR description so the next reviewer knows what's intentionally absent.
- **`payload.type` can be many things:** `view_submission`, `view_closed`, `block_actions`, `shortcut`, etc. v1 only handles the first; the rest log-and-200 so Slack doesn't retry.
- **`Content-Type: application/x-www-form-urlencoded`** confirmed — same as 2C.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/slack/interactivity.ts` | Create | The interactivity handler — Phase 2 contract is parse + ack |
| `convex/http.ts` | Modify | Swap `slackInteractivityStub` → `interactivity`; preserve `slackEventsStub` |

---

### 2E — End-to-End Verification

**Type:** Manual
**Parallelizable:** No — runs after 2C + 2D are deployed to dev. Pre-Phase 3 gate.

**What:** Manual QA against the dev Slack workspace + dev Convex deployment to confirm Phase 2's contract holds. **No code in this subphase.** Findings inform the Phase 3 design — if the modal is too sluggish or the error UX is poor, fix here before adding write semantics.

**Why:** Per [`AGENTS.md` § Testing](../../../AGENTS.md), this codebase does not run automated tests; manual QA is the gate. Phase 2's exit gate doubles as Phase 3's prerequisite. Specifically the latency budget is too sensitive to verify by reading code alone.

**Where:** No project files. Verification target: dev Slack workspace + `https://<convex-dev>.convex.site/slack/commands`.

**How:**

> **You must do this in a real Slack workspace.** A unit test cannot reproduce the cold-start + trigger_id + Slack-side latency interaction.

**Step 1: Happy path latency**

Run `/qualify-lead` 5× spaced ~30 seconds apart (so Convex isolates have a chance to evict). Record each `latencyMs` log line. Expected: most under 800ms; cold-start outliers up to ~1500ms; nothing over 2500ms (the trigger_id will start failing above ~2700ms).

If you see consistent > 2000ms even on warm calls:
- Inspect `getValidSlackBotToken` log lines — is the token refreshing every call? If so, `tokenExpiresAt` is being mis-set somewhere; cross-check Phase 1 1F.
- Check Slack-side latency for the `views.open` HTTP request alone (instrument the local fetch wrapper if needed). If Slack itself is taking > 1s, file with Slack support.

**Step 2: Inline error UX**

Submit the modal with handle empty. Verify "Required" appears under the handle field within 1 second of clicking Submit. Verify the rest of the form is preserved.

**Step 3: Disconnected-installation path**

In Convex dashboard, manually patch the dev installation row:

```bash
# Path: terminal
npx convex data slackInstallations
# Find the dev row's _id, then in the dashboard or via a one-off mutation:
# (write a temporary internalMutation if no dashboard write — or use the patch action below)
```

```typescript
// Path: convex/slack/_temp_setStatus.ts (REMOVE after verification)
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

export const setStatus = internalMutation({
  args: {
    id: v.id("slackInstallations"),
    status: v.union(
      v.literal("active"),
      v.literal("token_expired"),
      v.literal("revoked"),
      v.literal("uninstalled"),
    ),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { status: args.status });
  },
});
```

```bash
# Path: terminal
npx convex run slack/_temp_setStatus:setStatus '{"id":"<id>","status":"token_expired"}'
```

Run `/qualify-lead` — expect the ephemeral message:

> *Slack integration disconnected — ask an admin to reconnect in the CRM.*

Restore status:

```bash
npx convex run slack/_temp_setStatus:setStatus '{"id":"<id>","status":"active"}'
```

**Delete `_temp_setStatus.ts`** when done.

**Step 4: Tampered-body rejection**

```bash
# Path: terminal
curl -i -X POST "https://<convex-dev>.convex.site/slack/commands" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "X-Slack-Request-Timestamp: $(date +%s)" \
  -H "X-Slack-Signature: v0=00000000000000000000000000000000" \
  --data "team_id=T1&api_app_id=A1&trigger_id=fake"
# Expect: 401 "Bad signature"
```

**Step 5: Stale-timestamp rejection**

```bash
# Path: terminal — timestamp 10 minutes in the past
TS=$(($(date +%s) - 600))
curl -i -X POST "https://<convex-dev>.convex.site/slack/commands" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "X-Slack-Request-Timestamp: $TS" \
  -H "X-Slack-Signature: v0=00000000000000000000000000000000" \
  --data "team_id=T1&api_app_id=A1&trigger_id=fake"
# Expect: 401 "Bad signature" (timestamp skew rejected before signature comparison)
```

**Step 6: `expired_trigger_id` simulation**

This is hard to provoke deliberately — it requires intentional latency. The simplest reproducer:

1. Add a temporary `await new Promise(r => setTimeout(r, 4000))` before the `views.open` HTTP request in `commands.ts`. **Do not commit.**
2. Run `/qualify-lead`. Slack will return `expired_trigger_id` because 4s > 3s.
3. Verify the warn log fires and the user sees the ephemeral retry message.
4. **Remove the `setTimeout` line.**

> If your team is uncomfortable with the temporary modification approach, skip this step. The handler's branch is small and reviewable in code; manual reproduction is bonus assurance.

**Step 7: Document findings**

Append to the team's QA log with a one-line entry per check (✅ / ❌). If anything fails, fix in 2C or 2D before claiming Phase 2 done. Phase 3 does not start without Phase 2's gate passing.

**Key implementation notes:**
- **The 5× cold-warm latency check is the most important.** If even one call > 3s, real users will see `dispatch_failed`. Better to find this here than in production.
- **The `_temp_setStatus.ts` action is a development-only escape hatch** for forcing installation states. Phase 6 will offer the same affordance via the Integrations card UI. Always delete this file before merging.
- **Slack rate limits do not bite at this volume** — `views.open` is Tier 4 (~100/min) and we're testing with single-digit calls.

**Files touched:** None (pure verification subphase). Temporary `_temp_setStatus.ts` is created and deleted within Step 3.

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/lib/socialPlatform.ts` | Create | 2A |
| `convex/lib/slackBlockKit.ts` | Create | 2A |
| `convex/schema.ts` | Modify (recommended) | 2A |
| `convex/http.ts` | Modify | 2B, 2C, 2D |
| `convex/slack/inboundStubs.ts` | Verify existing | 2B |
| `convex/slack/rawEventsAudit.ts` | Create | 2B |
| `convex/slack/commands.ts` | Create | 2C |
| `convex/slack/interactivity.ts` | Create | 2D |
| `package.json` + `pnpm-lock.yaml` | Modify | 2C (add `@slack/types`) |
| (manual QA) | Verify | 2E |
