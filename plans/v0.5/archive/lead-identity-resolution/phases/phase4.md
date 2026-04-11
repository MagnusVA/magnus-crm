# Phase 4 — Duplicate Banner on Meeting Detail

**Goal:** Surface potential duplicate lead information on the meeting detail page. When the pipeline (Phase 3) flags an opportunity with `potentialDuplicateLeadId`, the meeting detail page displays a non-blocking informational banner alerting the user. After this phase, closers and admins see duplicate suggestions inline, enabling future merge workflows (Feature C).

**Prerequisite:** Phase 3 (Pipeline Identity Resolution) complete — `potentialDuplicateLeadId` is set on opportunities when fuzzy matches are detected. Phase 1 schema deployed (the `potentialDuplicateLeadId` field exists on the `opportunities` table).

**Runs in PARALLEL with:** Nothing — this is the final phase and depends on Phase 3 for data flow.

**Skills to invoke:**
- `shadcn` — verify that `Alert`, `AlertTitle`, `AlertDescription` components are available and properly styled
- `web-design-guidelines` — review the duplicate banner for accessibility (WCAG), color contrast, screen reader compatibility
- `expect` — browser-based verification of the banner rendering, responsive layout, and accessibility audit
- `frontend-design` — ensure the banner integrates cleanly with the meeting detail page layout and color scheme

**Acceptance Criteria:**

1. When an opportunity has `potentialDuplicateLeadId` set, the meeting detail page displays an amber "Potential Duplicate Lead" banner between the status badge row and the main content grid.
2. The banner shows the suspected duplicate lead's name (or email if name is not available) and a descriptive message.
3. When `potentialDuplicateLeadId` is not set (or the referenced lead no longer exists), no banner is shown.
4. The banner is informational only — no action buttons (merge/dismiss actions are deferred to Feature C).
5. The banner is accessible: appropriate ARIA roles, sufficient color contrast in both light and dark themes.
6. The `getMeetingDetail` query returns `potentialDuplicate` data (lead name + email + ID) alongside existing fields without breaking the existing return type contract.
7. All existing meeting detail page functionality (notes, outcome, payments, attribution) continues to work unchanged.
8. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
4A (Backend: Extend getMeetingDetail Query) ─────────────┐
                                                          ├── 4C (Integration: Wire Banner into Page)
4B (Frontend: PotentialDuplicateBanner Component) ───────┘
```

**Optimal execution:**

1. Start 4A (backend query extension) and 4B (banner component) in parallel — they touch different files.
2. Once 4A and 4B are complete → start 4C (wire the banner into the meeting detail page client).

**Estimated time:** 1-2 hours

---

## Subphases

### 4A — Extend `getMeetingDetail` Query

**Type:** Backend
**Parallelizable:** Yes — independent of 4B (frontend component). Both can be implemented simultaneously.

**What:** Modify the `getMeetingDetail` query in `convex/closer/meetingDetail.ts` to load the potential duplicate lead's basic info (ID, name, email) when the opportunity has `potentialDuplicateLeadId` set.

**Why:** The frontend needs the duplicate lead's name and email to display in the banner. Loading it in the existing query avoids an additional round-trip and keeps the data in the same reactive subscription.

**Where:**
- `convex/closer/meetingDetail.ts` (modify)

**How:**

**Step 1: Add the potential duplicate lookup**

Insert this block after the `assignedCloserSummary` resolution (around current line 158) and before the return statement:

```typescript
// Path: convex/closer/meetingDetail.ts
// Insert AFTER the assignedCloserSummary resolution block and BEFORE the return statement:

    // === Feature E: Load potential duplicate lead info ===
    let potentialDuplicate: {
      _id: typeof opportunity.leadId;
      fullName?: string;
      email: string;
    } | null = null;

    if (opportunity.potentialDuplicateLeadId) {
      const dupLead = await ctx.db.get(opportunity.potentialDuplicateLeadId);
      if (dupLead && dupLead.tenantId === tenantId) {
        potentialDuplicate = {
          _id: dupLead._id,
          fullName: dupLead.fullName,
          email: dupLead.email,
        };
      }
    }
    // === End Feature E ===
```

**Step 2: Add `potentialDuplicate` to the return object**

Modify the existing return statement to include the new field:

```typescript
// Path: convex/closer/meetingDetail.ts
// BEFORE:
    return {
      meeting,
      opportunity,
      lead,
      assignedCloser: assignedCloserSummary,
      meetingHistory,
      eventTypeName,
      paymentLinks,
      payments,
    };

// AFTER:
    return {
      meeting,
      opportunity,
      lead,
      assignedCloser: assignedCloserSummary,
      meetingHistory,
      eventTypeName,
      paymentLinks,
      payments,
      potentialDuplicate,
    };
```

**Step 3: Update the log statement to include the new field**

Update the console log before the return statement:

```typescript
// Path: convex/closer/meetingDetail.ts
// BEFORE:
    console.log("[Closer:MeetingDetail] getMeetingDetail completed", {
      meetingId,
      meetingHistoryCount: meetingHistory.length,
      paymentCount: payments.length,
      hasEventType: !!eventTypeName,
      hasPaymentLinks: !!paymentLinks,
      hasUtmParams: !!(meeting.utmParams || opportunity.utmParams),
    });

// AFTER:
    console.log("[Closer:MeetingDetail] getMeetingDetail completed", {
      meetingId,
      meetingHistoryCount: meetingHistory.length,
      paymentCount: payments.length,
      hasEventType: !!eventTypeName,
      hasPaymentLinks: !!paymentLinks,
      hasUtmParams: !!(meeting.utmParams || opportunity.utmParams),
      hasPotentialDuplicate: !!potentialDuplicate,
    });
```

**Key implementation notes:**
- The `potentialDuplicate` is `null` (not `undefined`) when there is no duplicate. This is consistent with how `assignedCloserSummary` handles missing data.
- The `dupLead.tenantId === tenantId` check ensures we never leak data across tenants, even if `potentialDuplicateLeadId` points to a lead in another tenant (which should be architecturally impossible but is a defense-in-depth measure).
- If the potential duplicate lead has been deleted (e.g., via a future admin action), `ctx.db.get()` returns `null` and no banner is shown. This is graceful degradation.
- The return type is inferred by Convex/TypeScript from the return statement. Adding `potentialDuplicate` automatically extends the inferred type for `usePreloadedQuery` consumers.
- No new permissions are needed — `requireTenantUser(ctx, ["closer", "tenant_master", "tenant_admin"])` already gates the query.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/meetingDetail.ts` | Modify | Add potential duplicate lead lookup + include in return |

---

### 4B — `PotentialDuplicateBanner` Component

**Type:** Frontend
**Parallelizable:** Yes — independent of 4A. This component can be built and styled before the backend returns the data.

**What:** Create a new `PotentialDuplicateBanner` React component that renders an amber informational banner using shadcn's `Alert` primitives. The banner shows the suspected duplicate lead's name and a descriptive message.

**Why:** This component provides the visual feedback for potential duplicates detected by the pipeline. It uses existing shadcn `Alert` components for consistency with the design system and accessibility built-ins.

**Where:**
- `app/workspace/closer/meetings/_components/potential-duplicate-banner.tsx` (new)

**How:**

**Step 1: Create the component file**

```tsx
// Path: app/workspace/closer/meetings/_components/potential-duplicate-banner.tsx
"use client";

import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { UsersIcon } from "lucide-react";

type PotentialDuplicateBannerProps = {
  duplicateLead: {
    _id: string;
    fullName?: string;
    email: string;
  };
  currentLeadName?: string;
};

/**
 * Non-blocking informational banner shown on the meeting detail page
 * when the pipeline detected a potential duplicate lead during identity resolution.
 *
 * Displays the suspected duplicate's name and email. In Feature C (Lead Manager),
 * this banner will gain a "Review & Merge" action button.
 */
export function PotentialDuplicateBanner({
  duplicateLead,
  currentLeadName,
}: PotentialDuplicateBannerProps) {
  const displayName = duplicateLead.fullName ?? duplicateLead.email;

  return (
    <Alert
      variant="default"
      className="border-amber-500/50 bg-amber-50 dark:bg-amber-950/20"
    >
      <UsersIcon className="size-4 text-amber-600 dark:text-amber-400" />
      <AlertTitle className="text-amber-800 dark:text-amber-200">
        Potential Duplicate Lead
      </AlertTitle>
      <AlertDescription className="text-amber-700 dark:text-amber-300">
        {currentLeadName ? (
          <>
            <span className="font-medium">{currentLeadName}</span> might be the
            same person as{" "}
            <span className="font-medium">{displayName}</span>.
          </>
        ) : (
          <>
            This lead might be the same as{" "}
            <span className="font-medium">{displayName}</span>.
          </>
        )}{" "}
        Review their profiles to determine if they should be merged.
      </AlertDescription>
    </Alert>
  );
}
```

**Key implementation notes:**
- The component uses shadcn's `Alert` with `variant="default"` and custom amber color classes. The amber color scheme distinguishes it from error alerts (red/destructive) and success states (green).
- Dark mode support: `dark:bg-amber-950/20`, `dark:text-amber-200`, `dark:text-amber-300`, `dark:text-amber-400` provide appropriate contrast in dark theme.
- The `UsersIcon` from `lucide-react` is a semantic choice — it visually represents "multiple people" which matches the duplicate concept.
- `displayName` falls back to email when `fullName` is not available. This ensures the banner always has something meaningful to display.
- The component is purely presentational — no state, no hooks, no side effects. It receives data as props and renders.
- The banner is informational only — no dismiss or merge buttons. Feature C (Lead Manager) will add a "Review & Merge" action that navigates to the lead merge dialog.
- The `_id` field is included in props for future use (Feature C will link to the lead detail page).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/potential-duplicate-banner.tsx` | Create | Amber informational banner component |

---

### 4C — Wire Banner into Meeting Detail Page

**Type:** Frontend
**Parallelizable:** No — depends on 4A (query returns `potentialDuplicate`) and 4B (component exists).

**What:** Import `PotentialDuplicateBanner` into the meeting detail page client component, update the `MeetingDetailData` type to include `potentialDuplicate`, and conditionally render the banner between the status badge row and the main content grid.

**Why:** This wires together the backend data (4A) and the frontend component (4B) into the existing page. Without this step, the query returns the data and the component exists, but nothing is rendered.

**Where:**
- `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` (modify)

**How:**

**Step 1: Add import for `PotentialDuplicateBanner`**

```tsx
// Path: app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx
// Add to existing imports:
import { PotentialDuplicateBanner } from "../../_components/potential-duplicate-banner";
```

**Step 2: Update the `MeetingDetailData` type**

Add the `potentialDuplicate` field to the type definition:

```tsx
// Path: app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx
// BEFORE:
type MeetingDetailData = {
  meeting: Doc<"meetings">;
  opportunity: Doc<"opportunities">;
  lead: Doc<"leads">;
  assignedCloser: { fullName?: string; email: string } | null;
  meetingHistory: Array<
    Doc<"meetings"> & {
      opportunityStatus: Doc<"opportunities">["status"];
      isCurrentMeeting: boolean;
    }
  >;
  eventTypeName: string | null;
  paymentLinks: Array<{
    provider: string;
    label: string;
    url: string;
  }> | null;
  payments: Array<
    Doc<"paymentRecords"> & {
      proofFileUrl: string | null;
      proofFileContentType: string | null;
      proofFileSize: number | null;
      closerName: string | null;
    }
  >;
} | null;

// AFTER:
type MeetingDetailData = {
  meeting: Doc<"meetings">;
  opportunity: Doc<"opportunities">;
  lead: Doc<"leads">;
  assignedCloser: { fullName?: string; email: string } | null;
  meetingHistory: Array<
    Doc<"meetings"> & {
      opportunityStatus: Doc<"opportunities">["status"];
      isCurrentMeeting: boolean;
    }
  >;
  eventTypeName: string | null;
  paymentLinks: Array<{
    provider: string;
    label: string;
    url: string;
  }> | null;
  payments: Array<
    Doc<"paymentRecords"> & {
      proofFileUrl: string | null;
      proofFileContentType: string | null;
      proofFileSize: number | null;
      closerName: string | null;
    }
  >;
  potentialDuplicate: {
    _id: string;
    fullName?: string;
    email: string;
  } | null;
} | null;
```

**Step 3: Destructure `potentialDuplicate` from the detail object**

Update the destructuring assignment inside the component:

```tsx
// Path: app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx
// BEFORE:
  const {
    meeting,
    opportunity,
    lead,
    assignedCloser,
    meetingHistory,
    eventTypeName,
    paymentLinks,
    payments,
  } = detail;

// AFTER:
  const {
    meeting,
    opportunity,
    lead,
    assignedCloser,
    meetingHistory,
    eventTypeName,
    paymentLinks,
    payments,
    potentialDuplicate,
  } = detail;
```

**Step 4: Render the banner in the JSX**

Insert the banner between the status badge row (the `<div>` with the back button and badge) and the main grid layout:

```tsx
// Path: app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx
// BEFORE:
      <div className="grid grid-cols-1 gap-6 md:grid-cols-3 lg:grid-cols-4">

// INSERT before the grid div:
      {/* Feature E: Potential duplicate banner */}
      {potentialDuplicate && (
        <PotentialDuplicateBanner
          duplicateLead={potentialDuplicate}
          currentLeadName={lead.fullName}
        />
      )}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3 lg:grid-cols-4">
```

The complete JSX structure after modification:

```tsx
// Path: app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx
// (showing the relevant section of the return statement)

    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => router.back()}>
          <ArrowLeftIcon data-icon="inline-start" />
          Back
        </Button>
        <Badge variant="secondary" className={cn(statusCfg?.badgeClass)}>
          {statusCfg?.label ?? opportunity.status}
        </Badge>
      </div>

      {/* Feature E: Potential duplicate banner */}
      {potentialDuplicate && (
        <PotentialDuplicateBanner
          duplicateLead={potentialDuplicate}
          currentLeadName={lead.fullName}
        />
      )}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3 lg:grid-cols-4">
        {/* ... existing layout unchanged ... */}
      </div>

      <OutcomeActionBar ... />
    </div>
```

**Key implementation notes:**
- The banner placement inside the `flex flex-col gap-6` container gives it consistent spacing (1.5rem / 24px) above and below, matching the gap between other sections.
- The banner spans the full width of the content area — it's not constrained to the sidebar or main column.
- Conditional rendering (`{potentialDuplicate && ...}`) ensures zero layout impact when there is no duplicate. No empty div, no hidden element, no CLS.
- The `MeetingDetailData` type is a local type definition (not imported from Convex). Adding `potentialDuplicate` matches the extended return type from the `getMeetingDetail` query (4A). TypeScript will flag a mismatch if the types diverge.
- The `_id` field in `potentialDuplicate` is typed as `string` (not `Id<"leads">`) because the client-side type doesn't have access to Convex's `Id` generic. The Convex runtime serializes IDs as strings anyway.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` | Modify | Import banner, update type, add conditional rendering |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/closer/meetingDetail.ts` | Modify | 4A |
| `app/workspace/closer/meetings/_components/potential-duplicate-banner.tsx` | Create | 4B |
| `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` | Modify | 4C |

---

## Notes for Implementer

- **No new permissions:** Feature E does not introduce new RBAC permissions. The `potentialDuplicate` data is served through the existing `getMeetingDetail` query which is already gated by `requireTenantUser(ctx, ["closer", "tenant_master", "tenant_admin"])`. Closers see it only on their own meetings; admins see it on all meetings.
- **Accessibility:** The `Alert` component from shadcn/ui includes `role="alert"` by default. The amber color scheme meets WCAG AA contrast requirements in both light and dark themes. Verify with the `web-design-guidelines` and `expect` skills after implementation.
- **Responsive behavior:** The `Alert` component is block-level and responsive by default. On mobile viewports, it stacks naturally within the `flex flex-col gap-6` container. No additional responsive styling needed.
- **Future extensibility (Feature C):** The banner component accepts `duplicateLead._id` which Feature C will use to link to the lead detail page or open a merge dialog. Feature C will add a "Review & Merge" button to the banner without changing the current layout structure.
- **Dark mode:** Test both light and dark themes. The amber color classes (`amber-50`, `amber-950/20`, `amber-200`, etc.) are designed to work across themes. Use the `expect` skill's screenshot tool at both theme settings.
- **Read the Convex AI guidelines** (`convex/_generated/ai/guidelines.md`) before modifying the backend query — ensure the additional `ctx.db.get()` call is properly guarded and the return type is consistent.
- **Use `expect` for browser verification:** After implementing all subphases, launch a browser session to verify: (1) banner renders correctly when `potentialDuplicateLeadId` is set, (2) no banner when field is absent, (3) responsive layout at 4 viewports, (4) accessibility audit passes, (5) console has no errors.
