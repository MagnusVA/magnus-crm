# Deferred — DM Link Portal and Alias Retirement

**Status:** Deferred  
**Related phase:** Phase 2 — UTM Attribution Model  
**Goal:** Make attribution aliases a temporary compatibility layer by generating canonical Calendly booking links inside the CRM, then later removing alias management from normal operator workflows.

---

## Context

Phase 2 introduced:

- `attributionTeams` with canonical `utmSource`
- `dmClosers` with canonical `utmMedium`
- `attributionAliases` to map raw Calendly UTM values to canonical team/closer records
- `eventTypeConfigs.bookingBaseUrl` and `bookingProgramId` so booked program can be inferred from the event type

Aliases are useful during migration because links have historically been built outside the app. Raw values can differ by capitalization, spacing, spelling, or manual typos.

The intended future model is different: DM closers should not manually assemble URLs. They should retrieve the correct booking links from an interactive CRM-controlled surface that uses canonical records directly.

---

## Target Product Model

Build an interactive link portal for external DM closers and/or operators.

The portal generates booking URLs from:

| Source | Field | URL param |
| --- | --- | --- |
| Event type config | `bookingBaseUrl` | URL base |
| Event type config | `bookingProgramId` | internal booked-program mapping, not necessarily a query param |
| Attribution team | `utmSource` | `utm_source` |
| DM closer | `utmMedium` | `utm_medium` |
| Campaign preset | configured value | `utm_campaign` |

Example generated URL:

```txt
{bookingBaseUrl}?utm_source={team.utmSource}&utm_medium={dmCloser.utmMedium}&utm_campaign={campaign}
```

Example:

```txt
https://calendly.com/acme/sales-call?utm_source=nimbus&utm_medium=hana_mejia&utm_campaign=organic
```

---

## Why Aliases Become Optional

If all new booking links are generated from canonical CRM records:

- `utm_source` always equals `attributionTeams.utmSource`
- `utm_medium` always equals `dmClosers.utmMedium`
- `bookingProgramId` comes from the selected event type config
- no alias is needed to resolve a normal new booking

Aliases remain useful only for:

- historical links
- manually built links
- typo repair
- alternate spellings already circulating outside the CRM
- one-off partner links that should map to a canonical record

---

## Required Resolver Change

Before aliases can be hidden or retired, update attribution resolution fallback order:

1. Active pair alias on normalized `utm_source + utm_medium`
2. Active source alias on normalized `utm_source`
3. Active medium alias on normalized `utm_medium`
4. Canonical team + DM closer match:
   - `attributionTeams.normalizedUtmSource === normalized utm_source`
   - `dmClosers.normalizedUtmMedium === normalized utm_medium`
   - closer belongs to matched team
5. Canonical source-only team match
6. Canonical medium-only DM closer match, only if unique enough within tenant
7. `utm_source=ptdom` → `internal`
8. no match → `unmapped`

This preserves alias behavior for legacy links while making canonical generated links work without alias rows.

---

## Portal Requirements

### Admin Settings

- Configure each active event type:
  - display name
  - `bookingBaseUrl`
  - `bookingProgramId`
  - mapping status
- Configure campaign presets:
  - `organic`
  - `paid`
  - `story`
  - `dm`
  - other tenant-defined values

### DM Closer Link Surface

The app should provide a dense link matrix:

| Column | Purpose |
| --- | --- |
| Program / event type | Which call this link books |
| Campaign | Which campaign value is embedded |
| URL | Generated canonical booking URL |
| Copy action | Fast copy to clipboard |
| Last copied / used | Optional audit signal |

Potential routes:

- Admin/operator surface: `/workspace/settings?tab=attribution`
- Future external DM closer surface: `/links` or `/dm-links`

The external surface should not grant CRM account access unless product requirements change. If exposed outside authenticated workspace, use signed tokens or invite links scoped to a DM closer/team.

---

## Data Model Options

### Minimal

No new table. Generate links at read time from:

- `eventTypeConfigs`
- `attributionTeams`
- `dmClosers`
- campaign presets stored in code or tenant config

### Audited

Add a `generatedBookingLinks` table:

```txt
tenantId
eventTypeConfigId
bookingProgramId
attributionTeamId
dmCloserId
campaign
url
isActive
createdAt
updatedAt
lastCopiedAt
```

Use this only if operators need stable link records, auditing, disabled links, or analytics around link copy/use.

---

## Alias Retirement Plan

### Step 1 — Canonical Fallback

Implement canonical resolver fallback after alias matching.

Acceptance:

- Generated links resolve to mapped attribution without creating alias rows.
- Existing alias behavior remains unchanged.
- Backfills can remap old rows after canonical fallback is deployed.

### Step 2 — Link Portal

Build the generated link surface.

Acceptance:

- Admin can generate/copy event type × DM closer URLs.
- URL uses canonical `utm_source` and `utm_medium`.
- Booked program comes from event type config.
- No raw UTM values are sent to PostHog.

### Step 3 — De-emphasize Aliases

Move aliases out of the primary Settings → Attribution workflow.

Acceptance:

- Teams and DM closers remain primary.
- Aliases move to an “Advanced legacy mappings” section.
- Unmapped UTM panel can create aliases for legacy repair, but normal generated-link flows do not require aliases.

### Step 4 — Optional Alias Removal

Only remove alias UI/table after historical rows and live links no longer depend on it.

Do not delete raw UTM data. If removing alias tables, use the `convex-migration-helper` skill and follow widen-migrate-narrow:

1. verify no active rows require aliases
2. deploy resolver without alias dependency
3. backfill resolved attribution caches
4. hide alias UI
5. later remove alias tables/indexes in a separate migration window

---

## Non-Goals

- Replacing Calendly as the booking host
- Creating CRM accounts for external DM closers
- Treating booked program as sold program
- Rewriting historical raw UTM values

---

## Open Questions

1. Should the DM closer portal require WorkOS auth, signed magic links, or a tenant-issued access token?
2. Should campaigns be tenant-configurable or a fixed enum?
3. Should generated links be persisted for audit, or generated on demand?
4. Should DM closers see all programs/event types or only assigned ones?
5. Should link copy/use events be tracked in Convex only, PostHog only, or both with normalized non-PII properties?
