# Phase 5 — Settings UI and Admin Operations

**Goal:** Surface event type sync status and synced event type metadata in Settings, add the manual sync button, update field mapping copy/counts, and centralize portal bookability rules so inactive/deleted/not-returned event types are never exposed publicly.

**Prerequisite:** Phase 1 schema fields are generated. Phase 3 exposes `api.calendly.eventTypes.syncMyTenantEventTypes` and latest sync status through `api.calendly.oauthQueries.getConnectionStatus`. Phase 2 supplies Calendly metadata on `eventTypeConfigs`.

**Runs in PARALLEL with:** Phase 4 boundary audit can run independently. Phase 6 verification should wait for this phase because rollout includes UI and portal checks.

**Skills to invoke:**
- `next-best-practices` — Settings stays a thin RSC plus client boundary with Convex hooks inside client components.
- `frontend-design` — Settings is an operational workspace surface; keep dense, scannable controls and restrained status styling.
- `shadcn` — Reuse Button, Badge, Card, Alert, Tabs, Empty, Spinner, and Switch primitives.
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
5A (Bookability helper + queries) ──────┬── 5B (Calendly connection card)
                                        ├── 5C (Event Types tab)
                                        ├── 5D (Field Mappings tab)
                                        └── 5E (Portal safety surfaces)

5B + 5C + 5D + 5E complete ─────────────── 5F (Responsive/manual UI verification)
```

**Optimal execution:**
1. Start 5A first because all UI and portal surfaces should share readiness semantics.
2. Run 5B, 5C, 5D, and 5E in parallel after 5A because they touch distinct components/modules.
3. Finish with 5F in the browser across desktop and mobile widths.

**Estimated time:** 1-1.5 days

---

## Subphases

### 5A — Shared Bookability Helper and Query Shape

**Type:** Backend  
**Parallelizable:** No — downstream UI and portal code depend on this helper.

**What:** Add `isCalendlyBookable`, `isPortalBookable`, and `portalReadiness`, then update event type config queries to include sync metadata and a deliberate bounded result size.

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
  | "missing_current_calendly_url"
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
  bookingUrlSource?: "admin_entered" | "imported_sheet" | "calendly_synced";
  bookingProgramId?: unknown;
  bookingProgramMappingStatus?: "mapped" | "unmapped";
  calendlySchedulingUrl?: string;
  calendlySyncStatus?: CalendlySyncStatus;
  linkPortalEnabled?: boolean;
}) {
  const hasTrustedBaseUrl =
    config.bookingUrlSource !== "calendly_synced" ||
    Boolean(config.calendlySchedulingUrl);

  return (
    config.linkPortalEnabled === true &&
    isCalendlyBookable(config) &&
    hasTrustedBaseUrl &&
    Boolean(config.bookingBaseUrl) &&
    config.bookingProgramId !== undefined &&
    config.bookingProgramMappingStatus === "mapped"
  );
}
```

**Step 2: Add a readiness reason for Settings.**

```typescript
// Path: convex/lib/eventTypeBookability.ts

export function portalReadiness(config: Parameters<typeof isPortalBookable>[0]): PortalReadiness {
  if (config.linkPortalEnabled === true && !isCalendlyBookable(config)) {
    return "calendly_unavailable";
  }
  if (
    config.bookingUrlSource === "calendly_synced" &&
    !config.calendlySchedulingUrl
  ) {
    return "missing_current_calendly_url";
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

**Step 3: Use helper in event type queries.**

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

**Key implementation notes:**
- Pagination is the long-term preferred shape, but `.take(500)` is acceptable for the single production tenant MVP.
- Keep sync statuses undefined-compatible during rollout.
- `bookingUrlSource = "calendly_synced"` requires a current `calendlySchedulingUrl` to be portal-bookable.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/eventTypeBookability.ts` | Create | Shared bookability/readiness rules |
| `convex/eventTypeConfigs/queries.ts` | Modify | Include sync metadata and readiness |

---

### 5B — Calendly Connection Card

**Type:** Frontend  
**Parallelizable:** Yes — depends on 3A action and 3B query shape.

**What:** Add latest event type sync status and the Sync Event Types button to the existing Calendly connection card.

**Why:** Admins need a clear, explicit operation for importing Calendly event types and seeing freshness.

**Where:**
- `app/workspace/settings/_components/calendly-connection.tsx` (modify)

**How:**

**Step 1: Extend the prop type and action hook.**

```tsx
// Path: app/workspace/settings/_components/calendly-connection.tsx

import { CalendarSyncIcon } from "lucide-react";

interface ConnectionStatus {
  // existing fields...
  eventTypeSyncInProgress: boolean;
  lastEventTypeSyncCompletedAt: number | null;
  lastEventTypeSyncStatus: "success" | "failed" | "skipped" | null;
  lastEventTypeSyncError: string | null;
  lastEventTypeSyncCount: number | null;
  lastEventTypeSyncSummary: {
    totalSeen: number;
    created: number;
    updated: number;
    unchanged: number;
    inactive: number;
    deleted: number;
    notReturned: number;
    questionsMerged: number;
  } | null;
}

const syncEventTypes = useAction(
  api.calendly.eventTypes.syncMyTenantEventTypes,
);
const [isSyncingEventTypes, setIsSyncingEventTypes] = useState(false);
```

**Step 2: Add the click handler.**

```tsx
// Path: app/workspace/settings/_components/calendly-connection.tsx

const handleSyncEventTypes = async () => {
  setIsSyncingEventTypes(true);
  try {
    const result = await syncEventTypes();
    if (result.status === "skipped") {
      toast.info("An event type sync is already running.");
      return;
    }

    toast.success(
      `Synced ${result.totalSeen} event types: ${result.created} new, ${result.updated} updated.`,
    );
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

**Step 3: Add compact status and button UI.**

```tsx
// Path: app/workspace/settings/_components/calendly-connection.tsx

<div>
  <p className="text-xs text-muted-foreground">Last Event Type Sync</p>
  <p className="mt-1 text-sm font-medium">
    {connectionStatus.lastEventTypeSyncCompletedAt
      ? formatCalendlyLastRefresh(
          connectionStatus.lastEventTypeSyncCompletedAt,
          Date.now(),
        )
      : "Never synced"}
  </p>
  {connectionStatus.lastEventTypeSyncError && (
    <p className="mt-1 text-xs text-destructive">
      {connectionStatus.lastEventTypeSyncError}
    </p>
  )}
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
- Keep the button grouped with existing token/member operations.
- Disable from both local state and server lock state.
- Avoid large explanatory text; the card should remain an operational control surface.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/settings/_components/calendly-connection.tsx` | Modify | Add event type sync status and button |

---

### 5C — Event Types Tab Metadata

**Type:** Frontend  
**Parallelizable:** Yes — depends on 5A query shape.

**What:** Update event type rows to show Calendly metadata, sync status, URL source, and last synced time while keeping existing edit behavior.

**Why:** Synced zero-booking, inactive, deleted, and not-returned event types need to be visible to admins without affecting public portal availability.

**Where:**
- `app/workspace/settings/_components/event-type-config-list.tsx` (modify)

**How:**

**Step 1: Extend the client row type.**

```tsx
// Path: app/workspace/settings/_components/event-type-config-list.tsx

interface EventTypeConfig {
  _id: string;
  calendlyEventTypeUri: string;
  displayName: string;
  calendlyName?: string;
  calendlySchedulingUrl?: string;
  calendlySyncStatus?: "active" | "inactive" | "deleted" | "not_returned";
  lastCalendlySyncedAt?: number;
  paymentLinks?: PaymentLink[];
  bookingProgramName?: string;
  bookingProgramMappingStatus?: "mapped" | "unmapped";
  bookingBaseUrl?: string;
  bookingUrlSource?: "admin_entered" | "imported_sheet" | "calendly_synced";
  linkPortalEnabled?: boolean;
  portalReadiness?: PortalReadiness;
}
```

**Step 2: Add status badge labels.**

```tsx
// Path: app/workspace/settings/_components/event-type-config-list.tsx

const SYNC_STATUS_LABEL: Record<
  NonNullable<EventTypeConfig["calendlySyncStatus"]>,
  string
> = {
  active: "Active",
  inactive: "Inactive",
  deleted: "Deleted",
  not_returned: "Not returned",
};
```

**Step 3: Render Calendly metadata and URLs.**

```tsx
// Path: app/workspace/settings/_components/event-type-config-list.tsx

<div className="flex flex-wrap items-center gap-2">
  <Badge variant="outline">
    {config.calendlySyncStatus
      ? SYNC_STATUS_LABEL[config.calendlySyncStatus]
      : "Legacy"}
  </Badge>
  {config.bookingUrlSource && (
    <Badge variant="secondary">{config.bookingUrlSource.replace(/_/g, " ")}</Badge>
  )}
</div>

{config.calendlyName && config.calendlyName !== config.displayName && (
  <p className="text-xs text-muted-foreground">
    Calendly: {config.calendlyName}
  </p>
)}

{config.calendlySchedulingUrl && (
  <span className="max-w-full truncate font-mono text-xs text-muted-foreground">
    {config.calendlySchedulingUrl}
  </span>
)}
```

**Key implementation notes:**
- Deleted/not-returned rows remain visible in Settings.
- Keep cards compact and avoid nested cards.
- Use truncation for URLs so cards do not overflow on mobile.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/settings/_components/event-type-config-list.tsx` | Modify | Show Calendly metadata and sync state |

---

### 5D — Field Mappings Tab Copy and Counts

**Type:** Frontend / Backend  
**Parallelizable:** Yes — depends on Phase 2 merged `knownCustomFieldKeys`.

**What:** Update field mapping copy and ensure `fieldCount` counts merged known field labels, including Calendly custom questions before first booking.

**Why:** Admins can now map fields before the first booking, so existing "after first booking" copy is inaccurate.

**Where:**
- `convex/eventTypeConfigs/queries.ts` (verify / modify)
- `app/workspace/settings/_components/field-mappings-tab.tsx` (modify)

**How:**

**Step 1: Keep `fieldCount` based on merged known keys.**

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

**Step 2: Update empty-state copy.**

```tsx
// Path: app/workspace/settings/_components/field-mappings-tab.tsx

<EmptyDescription>
  Event types and form questions sync from Calendly. Booking responses can add
  additional observed fields.
</EmptyDescription>
```

**Step 3: Update alert copy.**

```tsx
// Path: app/workspace/settings/_components/field-mappings-tab.tsx

<AlertDescription>
  Configure how your CRM identifies leads from booking form data. Event types
  and form questions sync from Calendly; booking responses can add additional
  observed fields.
</AlertDescription>
```

**Key implementation notes:**
- Do not disable configuration just because `bookingCount` is zero; use `fieldCount`.
- Existing field mapping dialog validation should continue to use `knownCustomFieldKeys`.
- If Calendly omits `custom_questions`, zero-booking rows may still have `fieldCount = 0`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/eventTypeConfigs/queries.ts` | Verify / Modify | `fieldCount` counts known keys |
| `app/workspace/settings/_components/field-mappings-tab.tsx` | Modify | Update copy |

---

### 5E — Portal Safety Surfaces

**Type:** Backend  
**Parallelizable:** Yes — depends on 5A helper.

**What:** Use shared bookability rules in public portal bootstrap, copy tracking, publish validation, and Settings readiness.

**Why:** Public portal data must not expose deleted, inactive, not-returned, or Calendly-synced rows that lack a current Calendly invite link.

**Where:**
- `convex/linkPortal/portalQueries.ts` (modify)
- `convex/linkPortal/copyMutations.ts` (modify)
- `convex/eventTypeConfigs/mutations.ts` (modify)
- `app/workspace/settings/_components/portal-event-type-readiness-card.tsx` (verify / modify)

**How:**

**Step 1: Filter portal bootstrap with the helper.**

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

**Step 2: Reject stale copy attempts.**

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

**Step 3: Block publish for unsafe states.**

```typescript
// Path: convex/eventTypeConfigs/mutations.ts

import { isPortalBookable, isCalendlyBookable } from "../lib/eventTypeBookability";

if (linkPortalEnabled && !isCalendlyBookable(config)) {
  throw new Error("This Calendly event type is not currently bookable.");
}
if (
  linkPortalEnabled &&
  config.bookingUrlSource === "calendly_synced" &&
  !config.calendlySchedulingUrl
) {
  throw new Error("Sync a valid Calendly invite link before publishing.");
}
```

**Key implementation notes:**
- Existing undefined sync status stays bookable for rollout compatibility.
- Deleting in Calendly disables `linkPortalEnabled` during sync, but portal filters must still enforce safety for stale clients.
- Public portal responses should not include Calendly sync metadata beyond what is needed to build links.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/linkPortal/portalQueries.ts` | Modify | Filter with shared helper |
| `convex/linkPortal/copyMutations.ts` | Modify | Reject stale/unsafe copy events |
| `convex/eventTypeConfigs/mutations.ts` | Modify | Block unsafe publishing |
| `app/workspace/settings/_components/portal-event-type-readiness-card.tsx` | Verify / Modify | Use shared readiness semantics |

---

### 5F — Responsive and Manual UI Verification

**Type:** Manual  
**Parallelizable:** No — verifies full UI behavior.

**What:** Verify Settings and public portal behavior in browser with active, inactive, deleted, not-returned, and legacy event type states.

**Why:** The UI changes affect admin operations and public booking-link availability.

**Where:**
- `app/workspace/settings/_components/calendly-connection.tsx` (verify)
- `app/workspace/settings/_components/event-type-config-list.tsx` (verify)
- `app/workspace/settings/_components/field-mappings-tab.tsx` (verify)
- Public DM link portal route (verify)

**How:**

**Step 1: Run compile gates.**

```bash
# Path: terminal
pnpm tsc --noEmit
```

**Step 2: Run the app and inspect Settings.**

```bash
# Path: terminal
pnpm dev
```

**Step 3: Browser scenarios.**

```tsx
// Path: app/workspace/settings/_components/event-type-config-list.tsx

// Verify:
// - Long URLs truncate inside cards.
// - Deleted and not-returned rows show status badges.
// - The edit button remains reachable.
// - The sync button disables while the action is in flight.
// - Mobile width does not overflow buttons or URL text.
```

**Key implementation notes:**
- Use the in-app browser or Playwright for screenshots if layout is uncertain.
- Keep status badges compact; this is a repeated operational list.
- Confirm the public portal does not show inactive/deleted/not-returned event types.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| Settings UI files | Verify | Manual browser verification |
| Public portal route | Verify | Unsafe event types are hidden/rejected |

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
| `app/workspace/settings/_components/portal-event-type-readiness-card.tsx` | Verify / Modify | 5E |
