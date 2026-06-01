# Phase 3 — Notes Enhancement & Meeting Outcome Tags

**Goal:** Build the `MeetingOutcomeSelect` component and enhance the existing `MeetingNotes` component with outcome tag integration and "Last saved at" timestamps. After this phase, closers can classify meetings with structured outcome tags and see when their notes were last saved.

**Prerequisite:** Phase 1 complete. `updateMeetingOutcome` mutation deployed. `Doc<"meetings">` type includes `meetingOutcome` field.

**Runs in PARALLEL with:** Phase 2 (Frontend Card Components). Phase 3 modifies `meeting-notes.tsx` and creates `meeting-outcome-select.tsx`. Phase 2 creates `deal-won-card.tsx` and `attribution-card.tsx`. Zero file overlap. Both phases can execute simultaneously.

**Skills to invoke:**
- `shadcn` — Select, Badge, Spinner components for the outcome dropdown.
- `frontend-design` — Inline form interaction pattern (select + auto-save, not dialog-based).

**Acceptance Criteria:**
1. `MeetingOutcomeSelect` renders a dropdown with 5 options: "Interested", "Needs more info", "Price objection", "Not qualified", "Ready to buy" — each with a color-coded badge.
2. Selecting an outcome calls `updateMeetingOutcome` mutation and shows a success toast.
3. If the mutation fails, a toast error appears and the select reverts to the previous value (Convex reactivity handles this).
4. The select shows "Select outcome" placeholder when `meetingOutcome` is undefined.
5. The select shows a spinner while the mutation is in flight.
6. `MeetingNotes` shows "Last saved at {time}" after a successful auto-save (instead of just "Saved").
7. The `MeetingOutcomeSelect` is rendered above the notes textarea within the MeetingNotes card.
8. `MeetingNotes` accepts a new `meetingOutcome` prop and passes it to `MeetingOutcomeSelect`.
9. PostHog events fire: `meeting_outcome_set` with `meeting_id` and `outcome` properties.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
3A (MeetingOutcomeSelect component) ────────────────────────────────┐
                                                                     ├── 3C (Verify + test)
3B (MeetingNotes enhancement) ──────────────────────────────────────┘
```

**Optimal execution:**
1. Start 3A and 3B **in parallel**: 3A creates a new file, 3B modifies an existing file — no overlap.
2. However, 3B imports from 3A, so practically: start 3A first (~15 min), then 3B can start immediately after the file exists (even if 3A is still being refined — the import path and export name are stable).
3. 3C verifies both together.

**Estimated time:** ~30 minutes

---

## Subphases

### 3A — Meeting Outcome Select Component

**Type:** Frontend
**Parallelizable:** Yes — creates a new file. 3B imports from it but can start as soon as the file exists.

**What:** Create `meeting-outcome-select.tsx` — a controlled Select component that calls `updateMeetingOutcome` on value change. Includes color-coded badges per outcome, saving spinner, and PostHog tracking.

**Why:** Fulfills I6 (Richer Notes — structured outcome dropdown). The closer needs a quick way to classify a meeting's outcome without navigating to a separate form. The select is a single-interaction element — select a value → it saves automatically.

**Where:**
- `app/workspace/closer/meetings/_components/meeting-outcome-select.tsx` (new)

**How:**

**Step 1: Create the component file**

```tsx
// Path: app/workspace/closer/meetings/_components/meeting-outcome-select.tsx

"use client";

import { useState, useCallback } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import posthog from "posthog-js";

// ─── Config ─────────────────────────────────────────────────────────────────

const OUTCOME_OPTIONS = [
  {
    value: "interested",
    label: "Interested",
    badgeClass:
      "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
  {
    value: "needs_more_info",
    label: "Needs more info",
    badgeClass:
      "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  },
  {
    value: "price_objection",
    label: "Price objection",
    badgeClass:
      "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  {
    value: "not_qualified",
    label: "Not qualified",
    badgeClass:
      "bg-red-500/10 text-red-700 dark:text-red-400",
  },
  {
    value: "ready_to_buy",
    label: "Ready to buy",
    badgeClass:
      "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
] as const;

export type MeetingOutcome = (typeof OUTCOME_OPTIONS)[number]["value"];

// ─── Component ──────────────────────────────────────────────────────────────

type MeetingOutcomeSelectProps = {
  meetingId: Id<"meetings">;
  currentOutcome: MeetingOutcome | undefined;
};

/**
 * Meeting Outcome Select — structured dropdown for classifying meetings.
 *
 * Auto-saves on selection change via updateMeetingOutcome mutation.
 * Shows a spinner while saving. Reverts on failure (Convex reactivity).
 */
export function MeetingOutcomeSelect({
  meetingId,
  currentOutcome,
}: MeetingOutcomeSelectProps) {
  const [isSaving, setIsSaving] = useState(false);
  const updateOutcome = useMutation(
    api.closer.meetingActions.updateMeetingOutcome,
  );

  const handleChange = useCallback(
    async (value: string) => {
      setIsSaving(true);
      try {
        await updateOutcome({
          meetingId,
          meetingOutcome: value as MeetingOutcome,
        });
        posthog.capture("meeting_outcome_set", {
          meeting_id: meetingId,
          outcome: value,
        });
        toast.success("Meeting outcome updated");
      } catch (error) {
        posthog.captureException(error);
        toast.error(
          error instanceof Error
            ? error.message
            : "Failed to update outcome",
        );
      } finally {
        setIsSaving(false);
      }
    },
    [meetingId, updateOutcome],
  );

  return (
    <div className="flex items-center gap-3">
      <p className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Outcome
      </p>
      <Select
        value={currentOutcome ?? ""}
        onValueChange={handleChange}
        disabled={isSaving}
      >
        <SelectTrigger className="w-[180px]" aria-label="Meeting outcome">
          {isSaving ? (
            <div className="flex items-center gap-2">
              <Spinner className="size-3" />
              <span className="text-xs">Saving...</span>
            </div>
          ) : (
            <SelectValue placeholder="Select outcome" />
          )}
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {OUTCOME_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                <Badge
                  variant="secondary"
                  className={cn("text-xs", option.badgeClass)}
                >
                  {option.label}
                </Badge>
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}
```

**Key implementation notes:**
- The `MeetingOutcome` type is exported so `meeting-notes.tsx` can import it for prop typing.
- The component does NOT use React Hook Form — it's a single-field controlled select with direct mutation call. RHF is overkill for a single select that auto-saves.
- `value={currentOutcome ?? ""}` — Radix Select requires a string value. Empty string maps to the placeholder state.
- On mutation failure, the select appears to "revert" automatically because Convex's reactive `usePreloadedQuery` in the parent component will re-render with the unchanged server state.
- The `SelectTrigger` has `aria-label="Meeting outcome"` for screen reader accessibility since the label is a sibling `<p>`, not a `<label>` element.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/meeting-outcome-select.tsx` | Create | Structured outcome dropdown with auto-save |

---

### 3B — Enhance MeetingNotes with Outcome & Save Timestamps

**Type:** Frontend
**Parallelizable:** Partially — depends on 3A existing (imports `MeetingOutcomeSelect`). Can start once 3A's file is created.

**What:** Modify the existing `MeetingNotes` component to:
1. Accept a `meetingOutcome` prop.
2. Render `MeetingOutcomeSelect` above the textarea.
3. Show "Last saved at {time}" instead of just "Saved" in the save indicator.

**Why:** Fulfills I6 (Richer Notes). The outcome tag is co-located with notes because they're both captured in the same workflow — the closer classifies the meeting while writing notes. The save timestamp gives confidence that data was persisted.

**Where:**
- `app/workspace/closer/meetings/_components/meeting-notes.tsx` (modify)

**How:**

**Step 1: Add the `meetingOutcome` prop and import**

```tsx
// Path: app/workspace/closer/meetings/_components/meeting-notes.tsx

// Add at the top (new imports):
import { format } from "date-fns";
import {
  MeetingOutcomeSelect,
  type MeetingOutcome,
} from "./meeting-outcome-select";

// Update the props type:
type MeetingNotesProps = {
  meetingId: Id<"meetings">;
  initialNotes: string;
  meetingOutcome: MeetingOutcome | undefined; // NEW
};
```

**Step 2: Add `lastSavedAt` state**

Inside the `MeetingNotes` component, add a state variable to track the last successful save timestamp:

```tsx
// Path: app/workspace/closer/meetings/_components/meeting-notes.tsx

// BEFORE (existing state):
const [saveStatus, setSaveStatus] = useState<
  "idle" | "saving" | "saved" | "error"
>("idle");

// ADD:
const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
```

**Step 3: Update the save callback to record timestamp**

In the debounced save handler, after a successful save, set the timestamp:

```tsx
// Path: app/workspace/closer/meetings/_components/meeting-notes.tsx

// BEFORE (inside the setTimeout async callback):
        await updateNotes({ meetingId, notes: value });
        lastSavedRef.current = value;
        setSaveStatus("saved");

// AFTER:
        await updateNotes({ meetingId, notes: value });
        lastSavedRef.current = value;
        setLastSavedAt(Date.now()); // NEW
        setSaveStatus("saved");
```

**Step 4: Render `MeetingOutcomeSelect` and update `SaveIndicator`**

```tsx
// Path: app/workspace/closer/meetings/_components/meeting-notes.tsx

// In the JSX, add MeetingOutcomeSelect above the Textarea:
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Meeting Notes</CardTitle>
          <SaveIndicator status={saveStatus} lastSavedAt={lastSavedAt} />
        </div>
        {errorMessage && (
          <p className="mt-1 text-xs text-destructive">{errorMessage}</p>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* NEW: Meeting Outcome Select */}
        <MeetingOutcomeSelect
          meetingId={meetingId}
          currentOutcome={meetingOutcome}
        />

        <Textarea
          value={notes}
          onChange={(e) => handleChange(e.target.value)}
          placeholder="Add notes about this meeting. Changes auto-save as you type..."
          className="min-h-[150px] resize-y"
          aria-label="Meeting notes"
        />
      </CardContent>
    </Card>
  );
```

**Step 5: Update `SaveIndicator` to show timestamp**

```tsx
// Path: app/workspace/closer/meetings/_components/meeting-notes.tsx

// BEFORE:
function SaveIndicator({
  status,
}: {
  status: "idle" | "saving" | "saved" | "error";
}) {
  if (status === "idle") return null;

  return (
    <div className="flex items-center gap-1.5">
      {status === "saving" && (
        <>
          <Spinner className="size-3" />
          <span className="text-xs font-medium text-muted-foreground">
            Saving...
          </span>
        </>
      )}
      {status === "saved" && (
        <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
          ✓ Saved
        </span>
      )}
    </div>
  );
}

// AFTER:
function SaveIndicator({
  status,
  lastSavedAt,
}: {
  status: "idle" | "saving" | "saved" | "error";
  lastSavedAt: number | null;
}) {
  if (status === "idle") return null;

  return (
    <div className="flex items-center gap-1.5" aria-live="polite">
      {status === "saving" && (
        <>
          <Spinner className="size-3" />
          <span className="text-xs font-medium text-muted-foreground">
            Saving...
          </span>
        </>
      )}
      {status === "saved" && (
        <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
          ✓ Saved{lastSavedAt ? ` at ${format(lastSavedAt, "h:mm a")}` : ""}
        </span>
      )}
    </div>
  );
}
```

**Step 6: Update the component signature**

```tsx
// Path: app/workspace/closer/meetings/_components/meeting-notes.tsx

// BEFORE:
export function MeetingNotes({ meetingId, initialNotes }: MeetingNotesProps) {

// AFTER:
export function MeetingNotes({ meetingId, initialNotes, meetingOutcome }: MeetingNotesProps) {
```

**Key implementation notes:**
- `date-fns` is already installed and used by other components in this directory. Import `format` for the save timestamp.
- The `aria-live="polite"` on the `SaveIndicator` div ensures screen readers announce save status changes without interrupting the user.
- The `MeetingOutcomeSelect` is visually separated from the textarea by a `gap-4` flex container — it sits above the notes as a quick-capture element.
- `lastSavedAt` is local state (`useState`) — it resets on page navigation/remount. This is intentional: the "last saved at" timestamp is per-session information, not persisted to the database.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/meeting-notes.tsx` | Modify | Add outcome prop, render MeetingOutcomeSelect, add save timestamp |

---

### 3C — Verify & Test

**Type:** Manual
**Parallelizable:** No — runs after 3A and 3B.

**What:** Verify that the outcome select and enhanced notes work correctly.

**Why:** Ensures the mutation integration works, the select UI renders properly, and the save timestamp displays.

**Where:**
- No file changes.

**How:**

**Step 1: TypeScript check**

```bash
pnpm tsc --noEmit
```

**Step 2: Test in browser (local dev)**

1. Navigate to a meeting detail page.
2. The MeetingNotes card should now show an "Outcome" label with a "Select outcome" dropdown above the textarea.
3. Select "Interested" → toast success → badge shows "Interested" in emerald.
4. Type in the notes textarea → wait 800ms → "Saving..." appears → "✓ Saved at 3:45 PM" appears.
5. Select "Price objection" → toast success → badge changes to amber.
6. Refresh the page → the selected outcome persists (served from the backend).

**Key implementation notes:**
- If the mutation is not yet deployed (`npx convex dev` pending), the select will show an error toast on change. Deploy first.
- The PostHog event `meeting_outcome_set` should appear in PostHog's event log.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| (none) | — | Verification-only subphase |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/closer/meetings/_components/meeting-outcome-select.tsx` | Create | 3A |
| `app/workspace/closer/meetings/_components/meeting-notes.tsx` | Modify | 3B |
