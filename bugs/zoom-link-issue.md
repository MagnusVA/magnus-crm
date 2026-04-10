# Bug Report: Meeting Links Missing For Most Production Meetings

## Summary

Most production meetings are missing a stored join URL, causing the closer UI to show "No Zoom link available" even when Calendly provided a valid meeting location.

This is not an intermittent data issue. It is a deterministic parsing bug in the `invitee.created` webhook pipeline.

## Date Investigated

- 2026-04-09

## Environment

- Convex production deployment: `prod:usable-guineapig-697`
- Inspection method: read-only Convex CLI against production data

## Impact

- Closers cannot reliably launch meetings from the CRM.
- Meeting detail pages incorrectly show the missing-link state for most meetings.
- `startMeeting` returns `null` for many meetings even when Calendly sent a usable custom meeting URL.

## Production Evidence

Observed in production on 2026-04-09:

- `130` meetings total
- `14` meetings with `zoomJoinUrl`
- `116` meetings without `zoomJoinUrl`

Correlation with raw Calendly webhook payloads was exact:

- `14/14` meetings with a stored URL came from `scheduled_event.location.type = "zoom"` payloads that included `location.join_url`
- `116/116` meetings without a stored URL came from `scheduled_event.location.type = "custom"` payloads where the usable link was in `location.location`

Examples found in raw production payloads:

- `http://go.ptdomtakeover.com/tyler`
- `http://go.ptdomtakeover.com/luke`
- `https://us02web.zoom.us/j/9741738633`
- `https://us02web.zoom.us/j/4243605804?...`

Notable nuance:

- Some Calendly `custom` locations are still direct Zoom URLs
- Others are branded redirect URLs
- A small number are malformed or incomplete and need manual review

## Root Cause

The webhook ingestion logic only reads `scheduledEvent.location.join_url`.

Current code:

- [convex/pipeline/inviteeCreated.ts](/Users/nimbus/dev/ptdom-crm/convex/pipeline/inviteeCreated.ts#L302)

Relevant logic:

```ts
const zoomJoinUrl =
  isRecord(scheduledEvent.location)
    ? getString(scheduledEvent.location, "join_url")
    : undefined;
```

This works only for Calendly locations shaped like:

```json
{
  "type": "zoom",
  "join_url": "https://..."
}
```

But production payloads often use:

```json
{
  "type": "custom",
  "location": "https://..."
}
```

Calendly's webhook docs already show `location.type` plus `location.location` as a normal location shape:

- [.docs/calendly/api-refrerence/webhooks/webhook-events-samples/webhook-payload.md](/Users/nimbus/dev/ptdom-crm/.docs/calendly/api-refrerence/webhooks/webhook-events-samples/webhook-payload.md#L114)

## Affected Code

- Write path: [convex/pipeline/inviteeCreated.ts](/Users/nimbus/dev/ptdom-crm/convex/pipeline/inviteeCreated.ts#L302)
- Stored field: [convex/schema.ts](/Users/nimbus/dev/ptdom-crm/convex/schema.ts#L163)
- Mutation returning link: [convex/closer/meetingActions.ts](/Users/nimbus/dev/ptdom-crm/convex/closer/meetingActions.ts#L68)
- UI showing missing state: [app/workspace/closer/meetings/_components/meeting-info-panel.tsx](/Users/nimbus/dev/ptdom-crm/app/workspace/closer/meetings/_components/meeting-info-panel.tsx#L129)

## Why The Bug Presents As "Missing Zoom Links"

The system models the field as `zoomJoinUrl`, but production data shows the real concept is broader: it is a meeting join URL or meeting location URL, not always a Zoom-native Calendly location.

Because of that naming mismatch:

- the parser only looks for Zoom-specific payloads
- the UI copy says "No Zoom link available"
- valid non-Zoom or custom-hosted meeting URLs are dropped at ingest

## Proposed Fix

### Correctness Fix

Normalize meeting links from Calendly locations during webhook ingestion:

- if `location.type === "zoom"`, use `join_url`
- if `location.type === "custom"`, use `location`
- trim whitespace before storing
- optionally normalize obvious bare host/path values to `https://...` only if safe

### Data Model Fix

Prefer introducing a generic field such as:

- `meetingJoinUrl`
- optional companion field `meetingLocationType`

Then dual-read:

- `meetingJoinUrl ?? zoomJoinUrl`

This avoids baking the Zoom assumption deeper into the product.

### Backfill Fix

Backfill from stored `rawWebhookEvents`, not from the live Calendly API.

Based on the production sample inspected:

- about `107` missing meetings can be repaired directly from valid `http(s)` custom URLs
- `7` additional records likely need simple normalization for bare `go.ptdomtakeover.com/...` values
- `2` records need manual review because the payload is malformed or null

Because this is production data repair, use a safe widen-migrate-narrow rollout:

1. Add the new optional field(s)
2. Update write path to populate them for new meetings
3. Update reads/UI to use the new field with fallback
4. Run a dry-run audit query/mutation
5. Backfill existing meetings in bounded batches from `rawWebhookEvents`
6. Verify results
7. Deprecate `zoomJoinUrl` later

## Suggested Follow-Up

- Add an audit query to report meetings whose raw webhook payload contains a usable location but the meeting row does not
- Update UI copy from "Zoom link" to "Meeting link"
- Rename return values from `startMeeting` to avoid the Zoom-specific assumption

## Severity

- High

Reason:

- The bug affects the primary workflow for closers starting scheduled meetings
- It impacts most production meetings, not a small edge case
