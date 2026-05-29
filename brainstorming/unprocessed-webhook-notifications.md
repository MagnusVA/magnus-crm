# Unprocessed Webhook Notifications Brainstorm

> Date: 2026-05-28
> Status: Brainstorm / pre-plan
> Context: The Operations Health banner keeps flagging "N recent invitee.created webhooks are unprocessed" and there is no way for an operator to clear, acknowledge, or replay them. This document outlines the problem and candidate fixes. It is intentionally not an implementation plan yet.

## One-Line Recommendation

Give operators a way to **resolve** flagged webhooks (replay, dismiss/acknowledge, or auto-resolve via attribution mapping), and stop conflating two different failure modes — events that genuinely failed (`processed: false`) versus events that were intentionally skipped (`processed: true`, no record created).

## Problem

The banner in `app/workspace/operations/_components/operations-health-banner.tsx` shows a persistent count that never goes down on its own. It is driven by `api.operations.bookingHealth.listRecentBookingHealthIssues`, which surfaces every `invitee.created` event from the last 7 days where `processed === false`:

```ts
// convex/operations/bookingHealth.ts
return events
  .filter((event) => event.eventType === "invitee.created" && !event.processed)
  .slice(0, 25)
  .map((event) => ({ rawEventId, receivedAt, calendlyEventUri, issue: "unprocessed_invitee_created" }));
```

There is **no UI affordance to act on these**. The banner only links to `/workspace/settings?tab=attribution` (for the unmapped-UTM half of the message). A stuck event sits in `rawWebhookEvents` with `processed: false` indefinitely, so the count only "clears" when the event ages past the 7-day window — not when the underlying issue is resolved.

## How Processing Actually Works

1. Webhook ingested → raw row stored in `rawWebhookEvents` (`processed: false`).
2. `ctx.scheduler.runAfter(0, internal.pipeline.processor.processRawEvent, { rawEventId })`.
3. `processRawEvent` dispatches by `eventType` to a handler (`inviteeCreated.process`, etc.).
4. On success the handler patches `processed: true`. On a thrown error the processor **re-throws and does NOT mark processed**:

```ts
// convex/pipeline/processor.ts
} catch (error) {
  console.error(`[Pipeline] Error processing event ${rawEventId} ...`, error);
  // Do NOT mark as processed — the event will be retried on next run
  throw error;
}
```

There is no automatic retry wired up for this action, so a thrown event stays `processed: false` **permanently** and keeps showing in the banner.

## Two Distinct Failure Modes

These behave very differently and should not be lumped together.

### A. Genuinely unprocessed (`processed: false`) — drives the banner

The handler threw before reaching a `markProcessed`. Causes include:

- `"Unable to resolve assigned closer for invitee.created"` (host resolves to no closer **and** is not a known non-closer host).
- Invalid state transition (`validateTransition` throws).
- Identity-resolution / OCC / duplicate-identifier conflicts mid-flow.

**Production snapshot (2026-05-28, PT DOM tenant, last 7 days):** 3 stuck events.

| Invitee | Host | Host classification | Likely cause |
| --- | --- | --- | --- |
| `mauro@pt-domination.com` | `anselmo@pt-domination.com` | org member → matched **closer** | threw mid-create flow (closer resolved, so not a skip) |
| `yelitza.palacio@gmail.com` | `momentum@pt-domination.com` | org member, **unmatched**, no CRM user | threw before the non-closer skip path |
| `cjisaac0604@gmail.com` | `reece@pt-domination.com` | org member → matched **closer** | threw mid-create flow |

(Exact throw reasons need a per-event log dive — that is the follow-up fix, not this brainstorm.)

### B. Intentionally skipped (`processed: true`, no meeting created) — silent, NOT in banner

When the host is a known non-closer and the invitee is not already a lead, the handler deliberately drops the booking and marks it processed:

```ts
// convex/pipeline/inviteeCreated.ts (~1176)
if (!assignedCloserId && assignedCloserResolution.isKnownNonCloserHost) {
  const existingLeadResolution = await resolveExistingLeadIdentity(ctx, { ... });
  if (!existingLeadResolution) {
    console.warn(`[Pipeline:invitee.created] Skipping booking for known non-closer host ...`);
    await ctx.db.patch(rawEventId, { processed: true });
    return;
  }
}
```

Example: `contact@advancesoccertraining.com` / "MDM CHECK IN CALL" hosted by Janelle Wheale (`oystraining@gmail.com`, unmatched org member). Processed successfully, but **no lead/opportunity/meeting** and **no audit trail** beyond a log line. There is no `skippedReason` on `rawWebhookEvents`, so these drops are effectively invisible.

## Why This Matters

- The banner cries wolf: it never clears, so operators learn to ignore it (alert fatigue).
- Genuinely failed bookings (mode A) may be **real sales calls that never entered the pipeline** — lost revenue/attribution.
- Silent skips (mode B) are invisible — no way to audit what we dropped or notice misconfiguration (e.g., a closer's Calendly account not mapped).

## Existing Building Blocks

- `convex/admin/rawWebhookReplay.ts` — already has replay/fresh-start machinery (`rebuildFreshStartFromRawWebhooks`, `setRawWebhookProcessedState`, `previewFreshStartFromRawWebhooks`). Internal/admin-only today.
- `convex/webhooks/cleanup.ts` — 30-day retention; **never deletes unprocessed events** and already logs a warning for stale unprocessed (`countStaleUnprocessed`). Good precedent: unprocessed = "needs human attention."
- `rawWebhookEvents` indexes: `by_processed`, `by_processed_and_receivedAt`, `by_tenantId_and_eventType_and_calendlyEventUri`.

## Candidate Solutions (to evaluate later)

1. **Replay from the UI.** Surface flagged events in an operations view with a "Retry" button that re-runs `processRawEvent`. Fixes the common case where the throw was transient or the underlying data (closer mapping) has since been corrected. Reuse `rawWebhookReplay` plumbing.
2. **Acknowledge / dismiss.** Add an `acknowledgedAt` / `acknowledgedBy` (or `healthState`) field so an operator can intentionally clear a notification without faking `processed`. Banner filters out acknowledged events. Keeps the raw row honest.
3. **Classify skips explicitly.** Add a `processedOutcome` enum to `rawWebhookEvents` (`ingested` / `skipped_non_closer_host` / `skipped_no_context` / `failed`) + optional `skipReason`. Makes mode B auditable and lets the banner/report distinguish "dropped on purpose" from "broke."
4. **Auto-resolve via mapping.** Many mode-A/B cases are really "host Calendly account not mapped to a CRM closer." A settings surface to map unmatched `calendlyOrgMembers` → closers, with a one-click replay of affected stuck events, would clear root cause + symptom together.
5. **Distinguish failed vs pending in the banner.** Only count events older than a grace period (e.g. > 5 min) as "failed," so freshly-arrived in-flight events do not flicker into the banner.
6. **Dead-letter view + bounded auto-retry.** Add a few scheduled retries with backoff before parking an event in a "dead-letter" state that the banner draws from. Avoids permanent silence on truly transient failures.

These are not mutually exclusive — the likely MVP is **(3) classify + (1) replay + (2) acknowledge**, with **(4) mapping** as the highest-leverage root-cause fix.

## Open Questions

- Should mode-B skips ever produce a lead/opportunity (for tracking) even when no closer is assigned, or stay fully dropped?
- Is a stuck `processed: false` event ever safe to auto-delete, or must every one be human-resolved? (Cleanup currently refuses to delete them.)
- Should "MDM check-in" style internal event types be excluded at ingestion (by event type) rather than dropped downstream?
- Do we need per-tenant configuration of which Calendly hosts/event types are "in scope" for the pipeline?
- Where should the resolution UI live — Operations health page, Settings → Attribution, or a dedicated "Webhook health" admin view?

## Out of Scope (for the eventual fix)

- Replacing Calendly (see `brainstorming/replace-calendly.md`).
- Changing the attribution/UTM mapping flow itself (separate banner half).
