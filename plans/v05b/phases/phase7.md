# Phase 7 — Frontend Updates

**Goal:** UI reflects the new data model. Payment displays use minor-unit cents. Soft-deleted users show visual indicators. Lead status fallbacks removed. Dashboard stats read from reactive summary doc. Pipeline views paginate.

**Prerequisite:** Phase 4 complete (query shapes finalized, backend reads `amountMinor`/`totalPaidMinor`, `users.isActive` populated, `leads.status` required).

**Runs in PARALLEL with:** Phase 6 (schema narrowing). Frontend does not depend on narrowing — it reads the new fields added in earlier phases.

**Skills to invoke:**
- `expect` — Browser verification (accessibility audit, performance metrics, console errors, 4 viewports)
- `shadcn` — Component patterns and styling
- `frontend-design` — UI quality

**Acceptance Criteria:**
1. Payment form dialogs (meeting + customer) convert user-entered dollar amounts to integer cents via `Math.round(parseFloat(amount) * 100)` before calling the mutation with `amountMinor`.
2. All payment display surfaces (payment-history-table, deal-won-card, customer-detail, customers-table, stats-row) render amounts from `amountMinor` using `formatAmountMinor()`.
3. Deactivated users appear with a dimmed row and "Deactivated" badge in the team table; action menus are hidden for deactivated rows.
4. The team table includes a "Show inactive" toggle; default view hides deactivated users.
5. The remove-user dialog is renamed "Deactivate User" with updated copy and pre-flight check for active assignments.
6. All `?? "active"` fallbacks for `leads.status` are removed from leads-table, lead-detail-page-client, and `convex/customers/conversion.ts`.
7. Dashboard stats read `totalRevenueMinor / 100` from the reactive summary doc; the 60-second polling interval is removed.
8. Admin and closer pipeline views use `usePaginatedQuery` with a "Load more" button; initial page size is 25.
9. Deactivated user names display with a "(Deactivated)" suffix on historical records across closer/customer views.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
7A (format-currency utility) ────────────────────────────────┐
                                                              │
     ┌── 7B (payment display updates) ── depends on 7A ─────┤
     │                                                        │
     ├── 7C (user soft-delete UI) ── parallel with 7B ───────┤
     │                                                        ├── 7F (browser verification)
     ├── 7D (lead status + dashboard cleanup) ── parallel ───┤
     │                                                        │
     └── 7E (pipeline pagination) ── parallel ───────────────┘
```

**Optimal execution:**
1. Start 7A (foundation utility — fast, no dependencies).
2. Once 7A is done, start 7B, 7C, 7D, 7E all in parallel (they touch different files).
3. Once 7B-7E are all done, run 7F (browser verification via `expect`).

**Estimated time:** 3-4 hours

---

## Subphases

### 7A — Currency Formatting Utility

**Type:** Frontend (utility)
**Parallelizable:** Yes — creates one new file with no dependencies.

**What:** Create `lib/format-currency.ts` exporting `formatAmountMinor()` that converts an integer minor-unit amount (cents) to a locale-formatted currency string using `Intl.NumberFormat`.

**Why:** Multiple components currently have inline `formatCurrency(amount, currency)` helpers that accept float dollar amounts. After the backend migration to `amountMinor` (integer cents), every display surface needs the same cents-to-dollars conversion. A single shared utility eliminates duplication and ensures consistent formatting across payment-history-table, deal-won-card, customer-detail, customers-table, and stats-row.

**Where:** `lib/format-currency.ts` (new file)

**How:**

```typescript
// Path: lib/format-currency.ts

/**
 * Format a minor-unit amount (integer cents) as a locale-formatted currency string.
 *
 * @example formatAmountMinor(29999, "USD") => "$299.99"
 * @example formatAmountMinor(0, "EUR") => "€0.00"
 */
export function formatAmountMinor(
  amountMinor: number,
  currency: string,
): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amountMinor / 100);
}
```

**Key implementation notes:**
- `amountMinor / 100` converts integer cents to the major-unit value that `Intl.NumberFormat` expects.
- `Intl.NumberFormat` handles decimal precision, thousands separators, and currency symbols automatically.
- `"en-US"` locale is hardcoded for now (consistent with existing `formatCurrency` helpers). Future i18n work can accept locale as a parameter.
- No try/catch needed here — callers already pass validated currency codes from the schema's enum. The existing `deal-won-card.tsx` `formatCurrency` has a try/catch, but the new utility is only called with values from the database, which are always valid.
- The function is pure and stateless — no side effects, safe to call in any context.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `lib/format-currency.ts` | Create | Shared minor-unit currency formatter |

---

### 7B — Payment Display Updates

**Type:** Frontend
**Parallelizable:** Yes (after 7A). Touches only payment-related display files. No overlap with 7C, 7D, 7E.

**What:** Update all payment form dialogs to submit `amountMinor` (integer cents) instead of `amount` (float dollars), and update all payment display surfaces to read `amountMinor` from the backend and format via `formatAmountMinor()`.

**Why:** Phase 3 migrated the backend mutations to accept `amountMinor`. Phase 4 updated queries to return `amountMinor` and `totalPaidMinor`. The frontend must now: (1) convert user-entered dollar amounts to cents before submission, and (2) read the new field names for display. Until this subphase completes, payment amounts will display incorrectly (showing raw cents as if they were dollars).

**Where:**
- `app/workspace/closer/meetings/_components/payment-form-dialog.tsx` (modify)
- `app/workspace/customers/[customerId]/_components/record-payment-dialog.tsx` (modify)
- `app/workspace/customers/[customerId]/_components/payment-history-table.tsx` (modify)
- `app/workspace/closer/meetings/_components/deal-won-card.tsx` (modify)
- `app/workspace/customers/[customerId]/_components/customer-detail-page-client.tsx` (modify)
- `app/workspace/customers/_components/customers-table.tsx` (modify)

**How:**

**Step 1: Update payment-form-dialog.tsx submission**

The form continues to accept a dollar amount string from the user (e.g., "299.99"). At the submission boundary, convert to integer cents before calling the mutation.

```typescript
// Path: app/workspace/closer/meetings/_components/payment-form-dialog.tsx

// BEFORE (line 197-199):
const parsedAmount = parseFloat(values.amount);
await logPayment({
  opportunityId,
  meetingId,
  amount: parsedAmount,
  currency: values.currency,
  // ...
});

// AFTER:
const parsedAmount = parseFloat(values.amount);
const amountMinor = Math.round(parsedAmount * 100);
await logPayment({
  opportunityId,
  meetingId,
  amountMinor,
  currency: values.currency,
  // ...
});
```

Also update the PostHog event to log cents:

```typescript
// Path: app/workspace/closer/meetings/_components/payment-form-dialog.tsx

posthog.capture("payment_logged", {
  opportunity_id: opportunityId,
  meeting_id: meetingId,
  amount_minor: amountMinor,
  currency: values.currency,
  provider: values.provider,
  has_reference_code: Boolean(values.referenceCode),
  has_proof_file: Boolean(proofFileId),
});
```

**Step 2: Update record-payment-dialog.tsx submission**

Same conversion at the submission boundary.

```typescript
// Path: app/workspace/customers/[customerId]/_components/record-payment-dialog.tsx

// BEFORE (line 159-160):
await recordPayment({
  customerId,
  amount: parseFloat(values.amount),
  // ...
});

// AFTER:
const amountMinor = Math.round(parseFloat(values.amount) * 100);
await recordPayment({
  customerId,
  amountMinor,
  // ...
});
```

**Step 3: Update payment-history-table.tsx display**

Replace inline formatting with `formatAmountMinor`. Update the `Payment` interface to use `amountMinor`.

```typescript
// Path: app/workspace/customers/[customerId]/_components/payment-history-table.tsx

import { formatAmountMinor } from "@/lib/format-currency";

interface Payment {
  _id: Id<"paymentRecords">;
  amountMinor: number;    // was: amount: number
  currency: string;
  provider: string;
  status: "recorded" | "verified" | "disputed";
  recordedAt: number;
  referenceCode?: string;
}

// BEFORE (line 74):
// {payment.currency} {payment.amount.toFixed(2)}

// AFTER:
// {formatAmountMinor(payment.amountMinor, payment.currency)}
```

**Step 4: Update deal-won-card.tsx display**

Replace the local `formatCurrency` helper with `formatAmountMinor`. Update the `EnrichedPayment` type.

```typescript
// Path: app/workspace/closer/meetings/_components/deal-won-card.tsx

import { formatAmountMinor } from "@/lib/format-currency";

type EnrichedPayment = {
  _id: string;
  amountMinor: number;   // was: amount: number
  currency: string;
  // ... rest unchanged
};

// BEFORE (line 114):
// {formatCurrency(payment.amount, payment.currency)}

// AFTER:
// {formatAmountMinor(payment.amountMinor, payment.currency)}
```

Remove the local `formatCurrency` helper function (lines 292-302) since it is replaced by the shared utility.

**Step 5: Update customer-detail-page-client.tsx**

Replace `totalPaid` with `totalPaidMinor / 100` and use `formatAmountMinor` for the display.

```typescript
// Path: app/workspace/customers/[customerId]/_components/customer-detail-page-client.tsx

import { formatAmountMinor } from "@/lib/format-currency";

// BEFORE (destructuring at line 78):
const { customer, lead, ..., totalPaid, currency, payments } = detail;

// AFTER:
const { customer, lead, ..., totalPaidMinor, currency, payments } = detail;

// BEFORE (display at line 229):
// {formatCurrency(totalPaid, currency)}

// AFTER:
// {formatAmountMinor(totalPaidMinor, currency)}
```

Remove the local `formatCurrency` helper function (lines 23-25).

**Step 6: Update customers-table.tsx**

Replace `totalPaid` with `totalPaidMinor` in the interface and use `formatAmountMinor` for display.

```typescript
// Path: app/workspace/customers/_components/customers-table.tsx

import { formatAmountMinor } from "@/lib/format-currency";

interface Customer {
  _id: Id<"customers">;
  fullName: string;
  email: string;
  convertedAt: number;
  totalPaidMinor: number;  // was: totalPaid: number
  currency: string;
  status: "active" | "churned" | "paused";
  convertedByName: string;
}

// BEFORE (line 103):
// {customer.currency} {customer.totalPaid.toFixed(2)}

// AFTER:
// {formatAmountMinor(customer.totalPaidMinor, customer.currency)}
```

**Key implementation notes:**
- `Math.round(parseFloat(amount) * 100)` handles floating-point precision (e.g., `2.99 * 100 = 298.99999...` rounds to `299`). This is the standard pattern for minor-unit conversion.
- The form UI is unchanged — users still enter dollar amounts like "299.99". The conversion happens at the submission boundary only.
- The `amountMinor` field name matches what Phase 3 mutations expect. The old `amount` argument key is no longer accepted after Phase 6 narrows the schema.
- Payment interfaces are updated to match the query return shapes from Phase 4.
- Two local `formatCurrency` helpers are removed (deal-won-card.tsx and customer-detail-page-client.tsx) in favor of the shared `formatAmountMinor`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/payment-form-dialog.tsx` | Modify | `amount` -> `amountMinor` at submission boundary |
| `app/workspace/customers/[customerId]/_components/record-payment-dialog.tsx` | Modify | `amount` -> `amountMinor` at submission boundary |
| `app/workspace/customers/[customerId]/_components/payment-history-table.tsx` | Modify | Interface + display use `amountMinor` |
| `app/workspace/closer/meetings/_components/deal-won-card.tsx` | Modify | Interface + display use `amountMinor`; remove local helper |
| `app/workspace/customers/[customerId]/_components/customer-detail-page-client.tsx` | Modify | `totalPaid` -> `totalPaidMinor`; remove local helper |
| `app/workspace/customers/_components/customers-table.tsx` | Modify | `totalPaid` -> `totalPaidMinor`; use `formatAmountMinor` |

---

### 7C — User Soft-Delete UI

**Type:** Frontend
**Parallelizable:** Yes — touches team management files only. No overlap with 7B, 7D, 7E.

**What:** Update the team management UI to handle deactivated users: visual indicators (dimmed rows, "Deactivated" badge), hidden action menus, a show/hide inactive toggle, renamed remove dialog ("Deactivate User"), and "(Deactivated)" suffix on historical user name displays.

**Why:** Phase 3 implemented user soft-delete on the backend (`users.isActive = false`, `users.deletedAt` set). The frontend must reflect this: admins need to see who is deactivated, the "remove" action should communicate deactivation (not deletion), and deactivated users should not receive new actions. Historical records (payments, meetings) must still show the user's name but indicate they are no longer active.

**Where:**
- `app/workspace/team/_components/team-members-table.tsx` (modify)
- `app/workspace/team/_components/remove-user-dialog.tsx` (modify)
- `app/workspace/team/_components/team-page-client.tsx` (modify)

**How:**

**Step 1: Update TeamMember interface and table rendering**

Add `isActive` to the `TeamMember` interface. Add a state toggle for showing/hiding inactive users. Render deactivated rows with visual differentiation.

```typescript
// Path: app/workspace/team/_components/team-members-table.tsx

interface TeamMember {
  _id: Id<"users">;
  _creationTime: number;
  email: string;
  fullName?: string;
  role: "closer" | "tenant_admin" | "tenant_master";
  isActive: boolean;                    // NEW
  calendlyMemberName?: string;
  calendlyUserUri?: string;
  personalEventTypeUri?: string;
}

interface TeamMembersTableProps {
  members: TeamMember[];
  currentUserId?: Id<"users">;
  showInactive: boolean;                // NEW
  onToggleShowInactive: () => void;     // NEW
  onEditRole?: (memberId: Id<"users">, currentRole: string) => void;
  onRemoveUser?: (memberId: Id<"users">) => void;
  onRelinkCalendly?: (memberId: Id<"users">) => void;
  onAssignEventType?: (memberId: Id<"users">) => void;
  onMarkUnavailable?: (memberId: Id<"users">) => void;
}
```

Add a toggle button above the table:

```tsx
// Path: app/workspace/team/_components/team-members-table.tsx

import { EyeIcon, EyeOffIcon } from "lucide-react";

// Before the table, add:
<div className="flex items-center justify-end pb-2">
  <Button
    variant="ghost"
    size="sm"
    onClick={onToggleShowInactive}
    className="text-xs text-muted-foreground"
  >
    {showInactive ? (
      <EyeOffIcon data-icon="inline-start" />
    ) : (
      <EyeIcon data-icon="inline-start" />
    )}
    {showInactive ? "Hide inactive" : "Show inactive"}
  </Button>
</div>
```

Filter and style rows:

```tsx
// Path: app/workspace/team/_components/team-members-table.tsx

// Filter members based on toggle
const visibleMembers = showInactive
  ? members
  : members.filter((m) => m.isActive);

// In the sorted/render loop, use visibleMembers instead of members.
// For deactivated rows:
<TableRow
  key={member._id}
  className={cn(!member.isActive && "opacity-50")}
>
  <TableCell className="font-medium">
    <div className="flex items-center gap-2">
      {member.fullName || member.email}
      {!member.isActive && (
        <Badge variant="outline" className="text-xs text-muted-foreground">
          Deactivated
        </Badge>
      )}
    </div>
  </TableCell>
  {/* ... other cells ... */}
  <TableCell className="text-right">
    {/* Only show actions for active, non-self, non-owner members */}
    {member.isActive && hasAnyAction ? (
      <DropdownMenu>{/* ... existing menu ... */}</DropdownMenu>
    ) : null}
  </TableCell>
</TableRow>
```

**Step 2: Rename remove-user-dialog.tsx to deactivation semantics**

Update dialog title, description, button text, and PostHog event. Add a pre-flight check warning about active assignments.

```typescript
// Path: app/workspace/team/_components/remove-user-dialog.tsx

export function RemoveUserDialog({
  open,
  onOpenChange,
  userId,
  userName,
  hasActiveAssignments,  // NEW — parent passes this after pre-flight check
  onSuccess,
}: RemoveUserDialogProps) {
  // ...

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Deactivate team member?</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to deactivate <strong>{userName}</strong>?
            They will lose access to the workspace. Their historical data
            (meetings, payments, opportunities) will be preserved.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {hasActiveAssignments && (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertDescription>
              This user has active opportunity assignments. Reassign them
              before deactivating.
            </AlertDescription>
          </Alert>
        )}

        <div className="flex justify-end gap-2">
          <AlertDialogCancel disabled={isRemoving}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleRemove}
            disabled={isRemoving || hasActiveAssignments}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isRemoving && <Spinner data-icon="inline-start" />}
            {isRemoving ? "Deactivating..." : "Deactivate"}
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

Update PostHog event:

```typescript
// Path: app/workspace/team/_components/remove-user-dialog.tsx

posthog.capture("team_member_deactivated", {
  deactivated_user_id: userId,
});
toast.success(`${userName} has been deactivated`);
```

**Step 3: Update team-page-client.tsx**

Add `showInactive` toggle state. Add pre-flight check for active assignments. Update CSV export to include deactivation status.

```typescript
// Path: app/workspace/team/_components/team-page-client.tsx

const [showInactive, setShowInactive] = useState(false);

// In dialog state union, add hasActiveAssignments:
type DialogState =
  | { type: null }
  | { type: "remove"; userId: Id<"users">; userName: string; hasActiveAssignments: boolean }
  // ... rest unchanged

// Update handleRemoveUser to check for active assignments:
const handleRemoveUser = (memberId: Id<"users">) => {
  const member = members?.find((m) => m._id === memberId);
  if (member && currentUser?._id !== memberId && member.role !== "tenant_master") {
    // Pre-flight: check if member has active opportunities
    // (Phase 4 query returns this flag, or count from client data)
    const hasActiveAssignments = false; // TODO: wire to query result
    setDialog({
      type: "remove",
      userId: memberId,
      userName: member.fullName || member.email,
      hasActiveAssignments,
    });
  }
};

// Pass showInactive to table:
<TeamMembersTable
  members={members}
  currentUserId={currentUser._id}
  showInactive={showInactive}
  onToggleShowInactive={() => setShowInactive((prev) => !prev)}
  // ... other handlers
/>

// Update CSV export to include status column:
downloadCSV(
  `team-${format(new Date(), "yyyy-MM-dd")}`,
  ["Name", "Email", "Role", "Status", "Calendly Status"],
  members.map((m) => [
    m.fullName ?? "",
    m.email,
    m.role.replace(/_/g, " "),
    m.isActive ? "Active" : "Deactivated",
    m.calendlyMemberName ?? "Not linked",
  ]),
);
```

**Key implementation notes:**
- The `isActive` field is populated by Phase 2 backfill and Phase 3 mutations. Phase 4 queries return it.
- The `showInactive` toggle defaults to `false` — deactivated users are hidden by default to keep the table clean.
- The `opacity-50` class dims the entire row for deactivated users, providing a clear visual distinction without being distracting.
- The pre-flight check for active assignments prevents admins from deactivating a closer who still has assigned opportunities. The backend enforces this too (Phase 3), but the frontend check gives immediate feedback.
- Action menus are completely hidden for deactivated users — there are no actions that make sense for an inactive user.
- The dialog rename from "Remove" to "Deactivate" is critical for user understanding — soft-delete is not permanent deletion.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/team/_components/team-members-table.tsx` | Modify | `isActive` in interface; dimmed rows; badge; toggle; hide actions |
| `app/workspace/team/_components/remove-user-dialog.tsx` | Modify | Rename to deactivation; pre-flight check; updated copy |
| `app/workspace/team/_components/team-page-client.tsx` | Modify | `showInactive` state; pre-flight check; CSV status column |

---

### 7D — Lead Status + Dashboard Cleanup

**Type:** Frontend + Backend
**Parallelizable:** Yes — touches lead and dashboard files only. No overlap with 7B, 7C, 7E.

**What:** Remove all `?? "active"` fallbacks for `leads.status` (now a required field), update dashboard stats to read revenue from the reactive summary doc (`totalRevenueMinor / 100`), and remove the 60-second polling interval.

**Why:** Phase 6 narrows `leads.status` to a required field — the `?? "active"` fallbacks are dead code that obscures the real type. The dashboard currently uses `usePollingQuery` with a 60-second interval to approximate real-time stats. Phase 3 introduced the `tenantStats` summary document that auto-updates reactively on every mutation — `useQuery` alone provides real-time data without polling overhead.

**Where:**
- `app/workspace/leads/_components/leads-table.tsx` (modify)
- `app/workspace/leads/[leadId]/_components/lead-detail-page-client.tsx` (modify)
- `convex/customers/conversion.ts` (modify)
- `app/workspace/_components/stats-row.tsx` (modify)
- `app/workspace/_components/dashboard-page-client.tsx` (modify)

**How:**

**Step 1: Remove fallbacks in leads-table.tsx**

```typescript
// Path: app/workspace/leads/_components/leads-table.tsx

// BEFORE — LeadRow type (line 28):
type LeadRow = {
  // ...
  status?: "active" | "converted" | "merged";
  // ...
};

// AFTER — status is now required:
type LeadRow = {
  // ...
  status: "active" | "converted" | "merged";
  // ...
};

// BEFORE — comparator (line 64):
status: (a: LeadRow, b: LeadRow) =>
  (a.status ?? "active").localeCompare(b.status ?? "active"),

// AFTER:
status: (a: LeadRow, b: LeadRow) =>
  a.status.localeCompare(b.status),

// BEFORE — badge (line 166):
<LeadStatusBadge status={lead.status ?? "active"} />

// AFTER:
<LeadStatusBadge status={lead.status} />
```

**Step 2: Remove fallbacks in lead-detail-page-client.tsx**

```typescript
// Path: app/workspace/leads/[leadId]/_components/lead-detail-page-client.tsx

// BEFORE (line 85):
<LeadStatusBadge status={lead.status ?? "active"} />

// AFTER:
<LeadStatusBadge status={lead.status} />

// BEFORE (line 133):
leadStatus={lead.status ?? "active"}

// AFTER:
leadStatus={lead.status}
```

**Step 3: Remove cast in conversion.ts**

```typescript
// Path: convex/customers/conversion.ts

// BEFORE (line 59):
const currentStatus = (lead.status ?? "active") as any;
if (!validateLeadTransition(currentStatus, "converted")) {

// AFTER:
if (!validateLeadTransition(lead.status, "converted")) {
```

**Step 4: Update stats-row.tsx for revenue from summary doc**

The `tenantStats` summary document provides `totalRevenueMinor`. Add a revenue stat card.

```typescript
// Path: app/workspace/_components/stats-row.tsx

import { formatAmountMinor } from "@/lib/format-currency";
import { DollarSignIcon } from "lucide-react";

interface Stats {
  totalClosers: number;
  unmatchedClosers: number;
  totalTeamMembers: number;
  activeOpportunities: number;
  meetingsToday: number;
  wonDeals: number;
  totalOpportunities: number;
  totalRevenueMinor?: number;       // NEW — from tenantStats summary doc
  paymentCurrency?: string;          // NEW — from tenantStats summary doc
  paymentRecordsLogged?: number;
}

// Add a revenue card (replace the existing StatsCard for "Won Deals" or add as fifth):
{stats.totalRevenueMinor != null && stats.totalRevenueMinor > 0 && (
  <StatsCard
    icon={DollarSignIcon}
    label="Revenue"
    value={formatAmountMinor(stats.totalRevenueMinor, stats.paymentCurrency ?? "USD")}
    subtext={`${stats.paymentRecordsLogged ?? 0} payments`}
    variant="success"
  />
)}
```

**Step 5: Remove polling in dashboard-page-client.tsx**

Switch from `usePollingQuery` with 60-second interval to a standard `useQuery`, which reactively updates when the `tenantStats` summary document changes.

```typescript
// Path: app/workspace/_components/dashboard-page-client.tsx

// BEFORE (lines 10, 72-76):
import { usePollingQuery } from "@/hooks/use-polling-query";

const stats = usePollingQuery(
  api.dashboard.adminStats.getAdminDashboardStats,
  isAdmin ? {} : "skip",
  { intervalMs: 60_000 },
);

// AFTER:
import { useQuery } from "convex/react";

const stats = useQuery(
  api.dashboard.adminStats.getAdminDashboardStats,
  isAdmin ? {} : "skip",
);
```

Remove the `usePollingQuery` import since it is no longer used in this file.

**Key implementation notes:**
- Removing `?? "active"` is safe because Phase 2 backfilled all null `status` fields and Phase 6 makes it required. TypeScript will catch any remaining optional access.
- The `(lead.status ?? "active") as any` cast in `conversion.ts` was a type workaround for the optional field. With `status` required, `validateLeadTransition(lead.status, "converted")` types correctly.
- Switching from `usePollingQuery` to `useQuery` reduces network traffic (no 60-second re-fetches) and provides genuinely real-time updates. Convex's reactive query system pushes changes to the client whenever the underlying data changes.
- The `totalRevenueMinor` field comes from the `tenantStats` summary document that Phase 3 mutations update on every payment. The dashboard query reads this pre-computed value instead of aggregating at query time.
- The `usePollingQuery` import can be removed from this file but should not be deleted from `hooks/` — other components may still use it.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/leads/_components/leads-table.tsx` | Modify | Remove `?? "active"` (2 locations); make `status` required in type |
| `app/workspace/leads/[leadId]/_components/lead-detail-page-client.tsx` | Modify | Remove `?? "active"` (2 locations) |
| `convex/customers/conversion.ts` | Modify | Remove `(lead.status ?? "active") as any` cast |
| `app/workspace/_components/stats-row.tsx` | Modify | Add revenue display from `totalRevenueMinor` |
| `app/workspace/_components/dashboard-page-client.tsx` | Modify | `usePollingQuery` -> `useQuery`; remove polling import |

---

### 7E — Pipeline Pagination

**Type:** Frontend
**Parallelizable:** Yes — touches pipeline files only. No overlap with 7B, 7C, 7D.

**What:** Switch admin and closer pipeline views from `useQuery` (which fetches all records at once) to `usePaginatedQuery` (which fetches in pages of 25 with a "Load more" button). Update table components to handle the paginated data shape.

**Why:** Pipeline tables currently load all opportunities in a single query. For tenants with hundreds of opportunities, this causes slow initial loads and high byte-read costs. `usePaginatedQuery` loads 25 records at a time and lets the user load more on demand — improving Time to Interactive and reducing Convex read costs. Phase 4 updated the backend queries to support `.paginate()`.

**Where:**
- `app/workspace/pipeline/_components/pipeline-page-client.tsx` (modify)
- `app/workspace/pipeline/_components/opportunities-table.tsx` (modify)
- `app/workspace/closer/pipeline/_components/closer-pipeline-page-client.tsx` (modify)
- `app/workspace/closer/pipeline/_components/opportunity-table.tsx` (modify)

**How:**

**Step 1: Update admin pipeline-page-client.tsx**

Switch from `useQuery` to `usePaginatedQuery` for the opportunities list.

```typescript
// Path: app/workspace/pipeline/_components/pipeline-page-client.tsx

import { usePaginatedQuery } from "convex/react";

// BEFORE (lines 104-107):
const opportunities = useQuery(
  api.opportunities.queries.listOpportunitiesForAdmin,
  isAdmin ? queryArgs : "skip",
);

// AFTER:
const {
  results: opportunities,
  status: paginationStatus,
  loadMore,
} = usePaginatedQuery(
  api.opportunities.queries.listOpportunitiesForAdmin,
  isAdmin ? queryArgs : "skip",
  { initialNumItems: 25 },
);

// Pass pagination props to the table:
<OpportunitiesTable
  opportunities={opportunities}
  canLoadMore={paginationStatus === "CanLoadMore"}
  isLoadingMore={paginationStatus === "LoadingMore"}
  onLoadMore={() => loadMore(25)}
/>
```

Update the CSV export to note it exports the currently loaded page:

```typescript
// Path: app/workspace/pipeline/_components/pipeline-page-client.tsx

// CSV export button — export currently loaded records
{opportunities && opportunities.length > 0 ? (
  <Button
    variant="outline"
    size="sm"
    onClick={() => {
      downloadCSV(
        `pipeline-${format(new Date(), "yyyy-MM-dd")}`,
        ["Lead", "Email", "Closer", "Status", "Created"],
        opportunities.map((opportunity) => [
          opportunity.leadName ?? "",
          opportunity.leadEmail ?? "",
          opportunity.closerName === "Unassigned"
            ? opportunity.hostCalendlyEmail
              ? `Unassigned (${opportunity.hostCalendlyEmail})`
              : "Unassigned"
            : opportunity.closerName ?? "Unassigned",
          opportunity.status,
          format(opportunity.createdAt, "yyyy-MM-dd HH:mm"),
        ]),
      );
    }}
  >
    <DownloadIcon data-icon="inline-start" />
    Export CSV
  </Button>
) : null}
```

**Step 2: Update admin opportunities-table.tsx**

Accept pagination props and render a "Load more" button below the table.

```typescript
// Path: app/workspace/pipeline/_components/opportunities-table.tsx

import { Spinner } from "@/components/ui/spinner";

interface OpportunitiesTableProps {
  opportunities: Opportunity[];
  canLoadMore: boolean;         // NEW
  isLoadingMore: boolean;       // NEW
  onLoadMore: () => void;       // NEW
}

export function OpportunitiesTable({
  opportunities,
  canLoadMore,
  isLoadingMore,
  onLoadMore,
}: OpportunitiesTableProps) {
  // ... existing table rendering ...

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-hidden rounded-lg border">
        <Table>
          {/* ... existing table content ... */}
        </Table>
      </div>

      {canLoadMore && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={onLoadMore}
            disabled={isLoadingMore}
          >
            {isLoadingMore ? (
              <>
                <Spinner data-icon="inline-start" />
                Loading...
              </>
            ) : (
              "Load more"
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
```

**Step 3: Update closer pipeline**

The closer pipeline currently has an inline `OpportunitiesTable` component inside `closer-pipeline-page-client.tsx`. Switch its `useQuery` to `usePaginatedQuery`.

```typescript
// Path: app/workspace/closer/pipeline/_components/closer-pipeline-page-client.tsx

import { usePaginatedQuery } from "convex/react";

// BEFORE (inside OpportunitiesTable component, line 131):
const opportunities = useQuery(api.closer.pipeline.listMyOpportunities, {
  statusFilter,
});

// AFTER:
const {
  results: opportunities,
  status: paginationStatus,
  loadMore,
} = usePaginatedQuery(
  api.closer.pipeline.listMyOpportunities,
  { statusFilter },
  { initialNumItems: 25 },
);

// Pass pagination to the table:
<OpportunityTable
  opportunities={opportunities}
  canLoadMore={paginationStatus === "CanLoadMore"}
  onLoadMore={() => loadMore(25)}
/>
```

**Step 4: Update closer opportunity-table.tsx**

Accept pagination props and render "Load more".

```typescript
// Path: app/workspace/closer/pipeline/_components/opportunity-table.tsx

type OpportunityTableProps = {
  opportunities: Opportunity[];
  canLoadMore: boolean;       // NEW
  onLoadMore: () => void;     // NEW
};

export function OpportunityTable({
  opportunities,
  canLoadMore,
  onLoadMore,
}: OpportunityTableProps) {
  // ... existing table rendering ...

  return (
    <div className="flex flex-col gap-4">
      <Table>
        {/* ... existing table content ... */}
      </Table>

      {canLoadMore && (
        <div className="flex justify-center py-4">
          <Button variant="outline" size="sm" onClick={onLoadMore}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
```

**Key implementation notes:**
- `usePaginatedQuery` returns `{ results, status, loadMore, isLoading }`. The `status` field is one of `"LoadingFirstPage"`, `"CanLoadMore"`, `"LoadingMore"`, or `"Exhausted"`.
- `initialNumItems: 25` loads the first 25 records. Each `loadMore(25)` call appends 25 more.
- Client-side sorting (via `useTableSort`) still works on the currently loaded records. It does not sort across unpaged results — this is acceptable for the MVP. The sort indicator should indicate it's sorting the visible set only.
- When `queryArgs` change (filter change), `usePaginatedQuery` resets and loads a fresh first page — no stale pagination state.
- The `"skip"` sentinel works the same with `usePaginatedQuery` as with `useQuery` — it suppresses the query entirely.
- The loading state during "Load more" uses the `isLoadingMore` flag to show a spinner on the button, preventing double-clicks.
- The leads table already uses pagination (`canLoadMore` + `onLoadMore` props exist) — this subphase brings the pipeline tables to the same pattern.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/pipeline/_components/pipeline-page-client.tsx` | Modify | `useQuery` -> `usePaginatedQuery`; pass pagination props |
| `app/workspace/pipeline/_components/opportunities-table.tsx` | Modify | Accept pagination props; render "Load more" button |
| `app/workspace/closer/pipeline/_components/closer-pipeline-page-client.tsx` | Modify | `useQuery` -> `usePaginatedQuery`; pass pagination props |
| `app/workspace/closer/pipeline/_components/opportunity-table.tsx` | Modify | Accept pagination props; render "Load more" button |

---

### 7F — Browser Verification

**Type:** QA / Verification
**Parallelizable:** No — must run after 7B, 7C, 7D, 7E to verify the combined changes.

**What:** Use the `expect` skill to verify all Phase 7 changes in a real browser. Run accessibility audits, performance metrics, console error checks, and responsive viewport tests across all affected pages.

**Why:** Frontend changes require browser-based verification to catch visual regressions, accessibility violations, runtime errors, and responsive layout issues that TypeScript alone cannot detect. The `expect` skill runs Playwright in a headed browser with axe-core accessibility auditing.

**Where:** No source files touched — verification only.

**How:**

**Verification checklist:**

| Page | Checks |
|---|---|
| Meeting detail (with payment) | Payment amount displays correctly from `amountMinor`; deal-won-card shows formatted currency |
| Customer detail | `totalPaidMinor` displays as dollars; payment history table shows formatted amounts |
| Customers list | `totalPaidMinor` column displays correctly |
| Team management | Deactivated user row is dimmed with badge; toggle shows/hides inactive; action menu hidden for deactivated |
| Deactivate dialog | Renamed title, updated copy, pre-flight warning visible when applicable |
| Leads list | No `?? "active"` artifacts; status badge renders correctly for all statuses |
| Lead detail | Status badge without fallback; convert dialog uses direct status |
| Admin dashboard | Revenue stat card shows formatted amount; stats auto-update (no polling flicker) |
| Admin pipeline | Paginated with "Load more"; initial load shows 25 records; filters reset pagination |
| Closer pipeline | Paginated with "Load more"; status filter works with pagination |

**Verification steps:**

1. **Data seeding**: Ensure test tenant has minimum 3 records per entity (leads, opportunities, payments, customers, team members including at least 1 deactivated).
2. **Accessibility audit**: Run axe-core on each page — zero critical/serious violations.
3. **Performance metrics**: Capture LCP, CLS, INP on dashboard and pipeline pages — LCP < 2.5s, CLS < 0.1, INP < 200ms.
4. **Console errors**: Zero unexpected console errors across all pages.
5. **Responsive viewports**: Test at 4 viewports (375px, 768px, 1024px, 1440px) — all tables scroll horizontally on mobile; "Load more" button accessible.
6. **Payment form**: Submit a test payment — verify `amountMinor` value in Convex dashboard (e.g., entering "299.99" stores `29999`).
7. **Theme check**: Verify dimmed deactivated rows and badges render correctly in both light and dark modes.

**Key implementation notes:**
- The `expect` skill delegates verification to a subagent so the main thread stays free.
- Data seeding is critical — empty state screenshots are not valid tests.
- The accessibility audit must run after all dynamic content has loaded (wait for Convex queries to resolve).
- Performance metrics should be captured after initial load, not during skeleton display.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| (none) | Verification only | Browser-based QA via `expect` skill |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `lib/format-currency.ts` | Create | 7A |
| `app/workspace/closer/meetings/_components/payment-form-dialog.tsx` | Modify | 7B |
| `app/workspace/customers/[customerId]/_components/record-payment-dialog.tsx` | Modify | 7B |
| `app/workspace/customers/[customerId]/_components/payment-history-table.tsx` | Modify | 7B |
| `app/workspace/closer/meetings/_components/deal-won-card.tsx` | Modify | 7B |
| `app/workspace/customers/[customerId]/_components/customer-detail-page-client.tsx` | Modify | 7B |
| `app/workspace/customers/_components/customers-table.tsx` | Modify | 7B |
| `app/workspace/team/_components/team-members-table.tsx` | Modify | 7C |
| `app/workspace/team/_components/remove-user-dialog.tsx` | Modify | 7C |
| `app/workspace/team/_components/team-page-client.tsx` | Modify | 7C |
| `app/workspace/leads/_components/leads-table.tsx` | Modify | 7D |
| `app/workspace/leads/[leadId]/_components/lead-detail-page-client.tsx` | Modify | 7D |
| `convex/customers/conversion.ts` | Modify | 7D |
| `app/workspace/_components/stats-row.tsx` | Modify | 7D |
| `app/workspace/_components/dashboard-page-client.tsx` | Modify | 7D |
| `app/workspace/pipeline/_components/pipeline-page-client.tsx` | Modify | 7E |
| `app/workspace/pipeline/_components/opportunities-table.tsx` | Modify | 7E |
| `app/workspace/closer/pipeline/_components/closer-pipeline-page-client.tsx` | Modify | 7E |
| `app/workspace/closer/pipeline/_components/opportunity-table.tsx` | Modify | 7E |
