# Phase 5 — Settings UI and Admin Operations

**Goal:** Surface event type sync status and synced event type metadata in Settings, add a manual sync control, update field mapping copy/counts, and centralize portal bookability rules so inactive/deleted event types are never exposed publicly.

**Prerequisite:** Phase 1 schema fields are generated. Phase 3 exposes `api.calendly.eventTypes.syncMyTenantEventTypes` and latest sync status through `api.calendly.oauthQueries.getConnectionStatus`. Phase 2 supplies metadata on `eventTypeConfigs`.

**Runs in PARALLEL with:** Phase 4 webhook reconciliation can run independently. Phase 6 verification should wait for this phase because rollout includes UI and portal checks.

**Skills to invoke:**
- `next-best-practices` — Settings stays a thin RSC plus client boundary with Convex hooks inside client components.
- `frontend-design` — Settings is an operational workspace surface; keep dense, scannable controls and restrained status styling.
- `shadcn` — Reuse existing Button, Badge, Card, Table, Alert, Tabs, Empty, Spinner, and Switch primitives.
- `vercel-react-best-practices` — Avoid unnecessary bundle growth and keep dynamic dialog imports.

**Acceptance Criteria:**
1. Settings > Calendly shows last event type sync status, last sync time, synced count, and error text when present.
2. Settings > Calendly has a "Sync Event Types" button that calls `api.calendly.eventTypes.syncMyTenantEventTypes`.
3. The sync button is disabled while disconnected, while locally submitting, or while server status says a sync lock is active.
4. Settings > Event Types shows synced zero-booking event types.
5. Event type rows show CRM display name, Calendly name when different, sync status, booking URL source, and last synced time.
6. Field Mappings copy says event types and questions sync from Calendly and booking responses can add observed fields.
7. Portal bootstrap, copy tracking, publish mutation, and Settings readiness all use one shared helper for bookability/readiness.
8. Deleted, inactive, and not-returned event types remain visible in Settings but cannot be published or returned in public portal bootstrap.
9. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
5A (Bookability helper + query shape) ──────┬── 5B (Calendly connection card)
                                            ├── 5C (Event Types tab)
                                            ├── 5D (Field Mappings tab)
                                            └── 5E (Portal safety surfaces)

5B + 5C + 5D + 5E complete ───────────────── 5F (Responsive/manual UI verification)
```

**Optimal execution:**
1. Start 5A first because all UI and portal surfaces should share the same readiness semantics.
2. Run 5B, 5C, 5D, and 5E in parallel after 5A because they touch distinct components/modules.
3. Finish with 5F in browser across desktop and mobile widths.

**Estimated time:** 1-1.5 days

---

## Subphases

### 5A — Shared Bookability Helper and Query Shape

**Type:** Backend
**Parallelizable:** No — downstream UI and portal code depend on this helper.

**What:** Add a shared `isCalendlyBookable`, `isPortalBookable`, and `portalReadiness` helper, then update event type config queries to include sync metadata and a safer bounded result size or pagination.

**Why:** Portal bootstrap, copy tracking, publish validation, and Settings badges currently duplicate readiness logic and would drift as sync statuses are introduced.

**Where:**
- `convex/lib/eventTypeBookability.ts` (new)
- `convex/eventTypeConfigs/queries.ts` (modify)

**How:**

**Step 1: Create the helper module.**

```typescript
// Path: convex/lib/eventTypeBookability.ts

export type CalendlySyncStatus =
  | "active"
  | "inactive"
  | "deleted"
  | "not_returned";

export type PortalReadiness =
  | "ready"
  | "missing_url"
  | "unmapped_program"
  | "calendly_unavailable"
  | "hidden";

export function isCalendlyBookable(config: {
  calendlySyncStatus?: CalendlySyncStatus;
}) {
  return (
    config.calendlySyncStatus === undefined ||
    config.calendlySyncStatus === "active"
  );
}

export function isPortalBookable(config: {
  bookingBaseUrl?: string;
  bookingProgramId?: unknown;
  bookingProgramMappingStatus?: "mapped" | "unmapped";
  calendlySyncStatus?: CalendlySyncStatus;
  linkPortalEnabled?: boolean;
}) {
  return (
    config.linkPortalEnabled === true &&
    isCalendlyBookable(config) &&
    Boolean(config.bookingBaseUrl) &&
    config.bookingProgramId !== undefined &&
    config.bookingProgramMappingStatus === "mapped"
  );
}

export function portalReadiness(config: {
  bookingBaseUrl?: string;
  bookingProgramId?: unknown;
  bookingProgramMappingStatus?: "mapped" | "unmapped";
  calendlySyncStatus?: CalendlySyncStatus;
  linkPortalEnabled?: boolean;
}): PortalReadiness {
  if (config.linkPortalEnabled === true && !isCalendlyBookable(config)) {
    return "calendly_unavailable";
  }
  if (isPortalBookable(config)) {
    return "ready";
  }
  const hasMappedProgram =
    config.bookingProgramId !== undefined &&
    config.bookingProgramMappingStatus === "mapped";
  if (!config.bookingBaseUrl && hasMappedProgram) {
    return "missing_url";
  }
  if (config.bookingBaseUrl && !hasMappedProgram) {
    return "unmapped_program";
  }
  return "hidden";
}
```

**Step 2: Use helper in `listEventTypeConfigs`.**

```typescript
// Path: convex/eventTypeConfigs/queries.ts

import { portalReadiness } from "../lib/eventTypeBookability";

export const listEventTypeConfigs = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const configs = await ctx.db
      .query("eventTypeConfigs")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(500);

    if (configs.length >= 500) {
      console.warn("[EventTypeConfig] listEventTypeConfigs reached MVP bound", {
        tenantId,
        count: configs.length,
      });
    }

    return configs.map((config) => ({
      ...config,
      portalReadiness: portalReadiness(config),
    }));
  },
});
```

**Step 3: Keep `fieldCount` based on merged known keys.**

```typescript
// Path: convex/eventTypeConfigs/queries.ts

return {
  ...config,
  portalReadiness: portalReadiness(config),
  bookingCount,
  lastBookingAt,
  fieldCount: config.knownCustomFieldKeys?.length ?? 0,
};
```

**Key implementation notes:**
- Full pagination is preferred long-term, but `.take(500)` is acceptable for MVP and current single-tenant production state.
- `calendlySyncStatus === undefined` remains bookable for legacy rows during rollout.
- Add `calendly_unavailable` to readiness labels in UI components.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/eventTypeBookability.ts` | Create | Shared readiness/bookability helpers |
| `convex/eventTypeConfigs/queries.ts` | Modify | Use helper and raise bounded list limit |

---

### 5B — Calendly Connection Card Sync Controls

**Type:** Frontend
**Parallelizable:** Yes — depends on Phase 3 public action/status fields.

**What:** Add sync event type status and button to the existing `CalendlyConnection` card.

**Why:** Admins need a visible repair/backfill operation and feedback when sync succeeds, is skipped, or fails.

**Where:**
- `app/workspace/settings/_components/calendly-connection.tsx` (modify)

**How:**

**Step 1: Extend the local `ConnectionStatus` type.**

```tsx
// Path: app/workspace/settings/_components/calendly-connection.tsx

interface ConnectionStatus {
  tenantId: string;
  status: string;
  needsReconnect: boolean;
  lastTokenRefresh: number | null;
  tokenExpiresAt: number | null;
  calendlyWebhookUri: string | null;
  hasWebhookSigningKey: boolean;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  lastEventTypeSyncStartedAt: number | null;
  lastEventTypeSyncCompletedAt: number | null;
  lastEventTypeSyncStatus: "success" | "failed" | "skipped" | null;
  lastEventTypeSyncError: string | null;
  lastEventTypeSyncCount: number | null;
  eventTypeSyncInProgress: boolean;
}
```

**Step 2: Add action hook and pending state.**

```tsx
// Path: app/workspace/settings/_components/calendly-connection.tsx

import { CalendarSyncIcon } from "lucide-react";

const syncEventTypes = useAction(
  api.calendly.eventTypes.syncMyTenantEventTypes,
);
const [isSyncingEventTypes, setIsSyncingEventTypes] = useState(false);

const handleSyncEventTypes = async () => {
  setIsSyncingEventTypes(true);
  try {
    const result = await syncEventTypes();
    if (result.status === "success") {
      toast.success(
        `Synced ${result.created + result.updated + result.unchanged} event type${result.created + result.updated + result.unchanged === 1 ? "" : "s"}`,
      );
    } else {
      toast.info(`Event type sync skipped: ${result.reason.replace(/_/g, " ")}`);
    }
    posthog.capture("calendly_event_types_synced", result);
  } catch (error) {
    toast.error(
      error instanceof Error ? error.message : "Failed to sync event types",
    );
  } finally {
    setIsSyncingEventTypes(false);
  }
};
```

**Step 3: Render status and button.**

```tsx
// Path: app/workspace/settings/_components/calendly-connection.tsx

<div className="border-t pt-4">
  <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
    <div>
      <p className="text-xs text-muted-foreground">Event Type Sync</p>
      <p className="mt-1 text-sm font-medium">
        {connectionStatus.lastEventTypeSyncStatus ?? "Not synced"}
      </p>
    </div>
    <div>
      <p className="text-xs text-muted-foreground">Last Event Type Sync</p>
      <p className="mt-1 text-sm font-medium">
        {connectionStatus.lastEventTypeSyncCompletedAt
          ? formatCalendlyLastRefresh(connectionStatus.lastEventTypeSyncCompletedAt, now)
          : "Never"}
      </p>
    </div>
    <div>
      <p className="text-xs text-muted-foreground">Event Types</p>
      <p className="mt-1 text-sm font-medium">
        {connectionStatus.lastEventTypeSyncCount ?? "-"}
      </p>
    </div>
  </div>
  {connectionStatus.lastEventTypeSyncError ? (
    <p className="mt-3 text-sm text-destructive">
      {connectionStatus.lastEventTypeSyncError}
    </p>
  ) : null}
</div>

<Button
  variant="outline"
  size="sm"
  onClick={handleSyncEventTypes}
  disabled={
    isSyncingEventTypes ||
    connectionStatus.eventTypeSyncInProgress ||
    !isConnected
  }
>
  {isSyncingEventTypes || connectionStatus.eventTypeSyncInProgress ? (
    <Spinner data-icon="inline-start" />
  ) : (
    <CalendarSyncIcon data-icon="inline-start" />
  )}
  {isSyncingEventTypes || connectionStatus.eventTypeSyncInProgress
    ? "Syncing Event Types..."
    : "Sync Event Types"}
</Button>
```

**Key implementation notes:**
- Keep the card dense; avoid adding explanatory marketing copy.
- Use the existing `formatCalendlyLastRefresh` helper for relative times.
- Capture PostHog events without sending tokens or raw error bodies.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/settings/_components/calendly-connection.tsx` | Modify | Event type sync status and manual button |

---

### 5C — Event Types Tab Metadata

**Type:** Frontend
**Parallelizable:** Yes — depends on 5A query shape.

**What:** Update event type cards to show Calendly metadata, status badges, booking URL source, and last sync time while preserving edit behavior.

**Why:** Synced rows include zero-booking, inactive, deleted, and not-returned event types. Admins need to understand why a row is visible and whether it is portal-safe.

**Where:**
- `app/workspace/settings/_components/event-type-config-list.tsx` (modify)

**How:**

**Step 1: Extend local config type and labels.**

```tsx
// Path: app/workspace/settings/_components/event-type-config-list.tsx

type CalendlySyncStatus = "active" | "inactive" | "deleted" | "not_returned";
type BookingUrlSource = "admin_entered" | "imported_sheet" | "calendly_synced";

interface EventTypeConfig {
  _id: string;
  calendlyEventTypeUri: string;
  displayName: string;
  calendlyName?: string;
  calendlySchedulingUrl?: string;
  calendlySyncStatus?: CalendlySyncStatus;
  lastCalendlySyncedAt?: number;
  bookingUrlSource?: BookingUrlSource;
  paymentLinks?: PaymentLink[];
  bookingProgramName?: string;
  bookingProgramMappingStatus?: "mapped" | "unmapped";
  bookingBaseUrl?: string;
  linkPortalEnabled?: boolean;
  portalReadiness?: PortalReadiness;
}

const SYNC_STATUS_LABEL: Record<CalendlySyncStatus, string> = {
  active: "Active",
  inactive: "Inactive",
  deleted: "Deleted",
  not_returned: "Not returned",
};

const BOOKING_URL_SOURCE_LABEL: Record<BookingUrlSource, string> = {
  admin_entered: "Admin URL",
  imported_sheet: "Imported URL",
  calendly_synced: "Calendly URL",
};
```

**Step 2: Show Calendly name divergence and sync status.**

```tsx
// Path: app/workspace/settings/_components/event-type-config-list.tsx

<CardTitle className="min-w-0 text-base">
  <span className="block truncate">{config.displayName}</span>
  {config.calendlyName && config.calendlyName !== config.displayName ? (
    <span className="mt-1 block truncate text-xs font-normal text-muted-foreground">
      Calendly: {config.calendlyName}
    </span>
  ) : null}
</CardTitle>

{config.calendlySyncStatus ? (
  <Badge
    variant={
      config.calendlySyncStatus === "active" ? "secondary" : "outline"
    }
  >
    {SYNC_STATUS_LABEL[config.calendlySyncStatus]}
  </Badge>
) : null}
```

**Step 3: Show booking URL source and sync timestamp.**

```tsx
// Path: app/workspace/settings/_components/event-type-config-list.tsx

<div>
  <p className="text-xs text-muted-foreground">Booking URL</p>
  <div className="mt-2 flex flex-wrap items-center gap-2">
    {config.bookingUrlSource ? (
      <Badge variant="outline">
        {BOOKING_URL_SOURCE_LABEL[config.bookingUrlSource]}
      </Badge>
    ) : null}
    {config.bookingBaseUrl ? (
      <span className="max-w-full truncate font-mono text-xs text-muted-foreground">
        {config.bookingBaseUrl}
      </span>
    ) : (
      <span className="text-sm text-muted-foreground">None configured</span>
    )}
  </div>
</div>

{config.lastCalendlySyncedAt ? (
  <p className="text-xs text-muted-foreground">
    Synced {formatDistanceToNow(config.lastCalendlySyncedAt, { addSuffix: true })}
  </p>
) : null}
```

**Key implementation notes:**
- Keep `EventTypeConfigDialog` props compatible; pass the full config but only the existing editable fields are used.
- Long URLs must truncate and not resize cards.
- Deleted/not-returned rows should not disappear from Settings.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/settings/_components/event-type-config-list.tsx` | Modify | Metadata/status display |

---

### 5D — Field Mappings Copy and Counts

**Type:** Frontend
**Parallelizable:** Yes — depends on 5A query field counts.

**What:** Update Field Mappings copy to reflect Calendly sync and ensure the field count includes synced custom questions.

**Why:** The current UI says event types appear after first booking, which becomes false after full sync.

**Where:**
- `app/workspace/settings/_components/field-mappings-tab.tsx` (modify)
- `convex/eventTypeConfigs/queries.ts` (verify from 5A)

**How:**

**Step 1: Update empty state copy.**

```tsx
// Path: app/workspace/settings/_components/field-mappings-tab.tsx

<EmptyDescription>
  Event types and form questions sync from Calendly. Booking responses can add
  additional observed fields after meetings are scheduled.
</EmptyDescription>
```

**Step 2: Update alert copy.**

```tsx
// Path: app/workspace/settings/_components/field-mappings-tab.tsx

<AlertDescription>
  Configure how your CRM identifies leads from booking form data. Event types
  and current form questions sync from Calendly; booking responses can add
  historical observed fields.
</AlertDescription>
```

**Step 3: Keep configure disabled only when no known fields exist.**

```tsx
// Path: app/workspace/settings/_components/field-mappings-tab.tsx

<Button
  variant="outline"
  size="sm"
  onClick={() => handleConfigure(config)}
  disabled={config.fieldCount === 0}
  aria-label={`Configure field mappings for ${config.displayName}`}
>
  <Settings2Icon className="mr-2 size-4" />
  Configure
</Button>
```

**Key implementation notes:**
- `fieldCount` already comes from `knownCustomFieldKeys`; Phase 2 sync merges custom question labels there.
- Keep booking count and last booking visible because they still matter for operational context.
- Do not add long instructional text to each card.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/settings/_components/field-mappings-tab.tsx` | Modify | Copy and synced-field framing |
| `convex/eventTypeConfigs/queries.ts` | Verify | Field count uses merged known keys |

---

### 5E — Portal Safety Surfaces

**Type:** Full-Stack
**Parallelizable:** Yes — depends on 5A helper.

**What:** Replace duplicated readiness checks in portal bootstrap, copy tracking, publish mutation, and readiness card with the shared helper.

**Why:** Public portal links must not expose deleted, inactive, or not-returned Calendly event types even if stale client state exists.

**Where:**
- `convex/linkPortal/portalQueries.ts` (modify)
- `convex/linkPortal/copyMutations.ts` (modify)
- `convex/eventTypeConfigs/mutations.ts` (modify)
- `app/workspace/settings/_components/portal-event-type-readiness-card.tsx` (modify)

**How:**

**Step 1: Filter public portal rows through `isPortalBookable`.**

```typescript
// Path: convex/linkPortal/portalQueries.ts

import { isPortalBookable } from "../lib/eventTypeBookability";

bookablePrograms: eventTypeConfigs
  .filter((config) => isPortalBookable(config))
  .map((config) => ({
    eventTypeConfigId: config._id,
    eventTypeDisplayName: config.displayName,
    bookingProgramId: config.bookingProgramId!,
    bookingProgramName: config.bookingProgramName ?? config.displayName,
    bookingBaseUrl: config.bookingBaseUrl!,
  })),
```

**Step 2: Reject stale copied links for unavailable rows.**

```typescript
// Path: convex/linkPortal/copyMutations.ts

import { isPortalBookable } from "../lib/eventTypeBookability";

if (
  !eventTypeConfig ||
  eventTypeConfig.tenantId !== args.tenantId ||
  !isPortalBookable(eventTypeConfig)
) {
  throw new Error("Portal event type is not available.");
}
```

**Step 3: Block publishing unavailable Calendly rows.**

```typescript
// Path: convex/eventTypeConfigs/mutations.ts

import { isCalendlyBookable } from "../lib/eventTypeBookability";

if (linkPortalEnabled) {
  if (!isCalendlyBookable(config)) {
    throw new Error(
      "This Calendly event type is not currently bookable. Sync Calendly or choose an active event type before publishing.",
    );
  }
  // Keep existing URL and booked-program checks after this.
}
```

**Step 4: Update readiness labels in the Settings readiness card.**

```tsx
// Path: app/workspace/settings/_components/portal-event-type-readiness-card.tsx

type PortalReadiness =
  | "ready"
  | "missing_url"
  | "unmapped_program"
  | "calendly_unavailable"
  | "hidden";

const READINESS_LABEL: Record<PortalReadiness, string> = {
  ready: "Ready",
  missing_url: "Missing URL",
  unmapped_program: "Unmapped program",
  calendly_unavailable: "Calendly unavailable",
  hidden: "Hidden",
};
```

**Key implementation notes:**
- Public portal should hide inactive/deleted/not-returned rows even if `linkPortalEnabled` is still true.
- `setLinkPortalEnabled` should provide a clear error rather than silently toggling back.
- Legacy rows with undefined `calendlySyncStatus` remain eligible during rollout.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/linkPortal/portalQueries.ts` | Modify | Shared bookability filtering |
| `convex/linkPortal/copyMutations.ts` | Modify | Server-side stale copy protection |
| `convex/eventTypeConfigs/mutations.ts` | Modify | Block publishing unbookable Calendly rows |
| `app/workspace/settings/_components/portal-event-type-readiness-card.tsx` | Modify | New readiness status label |

---

### 5F — Responsive UI and Type Verification

**Type:** Manual
**Parallelizable:** No — runs after 5A-5E.

**What:** Verify TypeScript and inspect Settings/portal surfaces in a browser.

**Why:** This phase changes dense Settings UI. Text truncation, disabled states, and status badges must remain usable across viewport sizes.

**Where:**
- Local terminal verification
- Local Next.js dev server
- Browser at `/workspace/settings`

**How:**

**Step 1: Run codegen and TypeScript.**

```bash
// Path: terminal
npx convex dev --once
pnpm tsc --noEmit
```

**Step 2: Start the app and inspect Settings.**

```bash
// Path: terminal
pnpm dev
```

Inspect:
- `/workspace/settings?tab=calendly`
- `/workspace/settings?tab=event-types`
- `/workspace/settings?tab=field-mappings`
- `/workspace/settings?tab=programs`

**Step 3: Check status combinations.**

```tsx
// Path: app/workspace/settings/_components/event-type-config-list.tsx

// Verify rows render cleanly for:
// calendlySyncStatus: "active"
// calendlySyncStatus: "inactive"
// calendlySyncStatus: "deleted"
// calendlySyncStatus: "not_returned"
// calendlySyncStatus: undefined
```

**Key implementation notes:**
- Use a mobile-width viewport to ensure badges/buttons do not overlap or force horizontal scroll inside cards.
- Confirm long booking URLs truncate.
- Confirm manual sync button disabled state is understandable without adding explanatory paragraphs.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/_generated/*` | Generate | Query/action type references |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/lib/eventTypeBookability.ts` | Create | 5A |
| `convex/eventTypeConfigs/queries.ts` | Modify | 5A, 5D |
| `app/workspace/settings/_components/calendly-connection.tsx` | Modify | 5B |
| `app/workspace/settings/_components/event-type-config-list.tsx` | Modify | 5C |
| `app/workspace/settings/_components/field-mappings-tab.tsx` | Modify | 5D |
| `convex/linkPortal/portalQueries.ts` | Modify | 5E |
| `convex/linkPortal/copyMutations.ts` | Modify | 5E |
| `convex/eventTypeConfigs/mutations.ts` | Modify | 5E |
| `app/workspace/settings/_components/portal-event-type-readiness-card.tsx` | Modify | 5E |
| `convex/_generated/*` | Generate | 5F |
