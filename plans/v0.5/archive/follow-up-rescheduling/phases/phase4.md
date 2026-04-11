# Phase 4 — Reminders Dashboard Section

**Goal:** Add a "Reminders" section to the closer dashboard between the Featured Meeting Card and the Pipeline Strip. The section displays cards for each active manual reminder, sorted by scheduled time (soonest first). Visual escalation is driven by client-side time comparison (normal → amber → red). After this phase, closers can see and manage their pending reminders directly from the dashboard.

**Prerequisite:** Phase 1 complete (`getActiveReminders` query and `markReminderComplete` mutation available).

**Runs in PARALLEL with:** Phase 2 (Pipeline UTM Intelligence), Phase 3 (Follow-Up Dialog), Phase 5 (Personal Event Type) — zero shared files.

**Skills to invoke:**
- `frontend-design` — Production-grade reminder cards with visual escalation styling, responsive grid layout.
- `shadcn` — Card, Badge, Button components for reminder cards.
- `web-design-guidelines` — WCAG compliance for color-based urgency indicators (must not rely on color alone), accessible button labels.
- `vercel-react-best-practices` — Optimized interval-based re-renders (30s tick for urgency recalculation).
- `vercel-composition-patterns` — Component composition for the reminder card (data + presentation separation).

**Acceptance Criteria:**
1. A "Reminders" section appears on the closer dashboard between the Featured Meeting Card and the Pipeline Strip when the closer has active reminders.
2. The section does not render when there are no active reminders (returns `null`).
3. Each reminder card shows: lead name, phone number (prominent, clickable `tel:` link), contact method badge (Call/Text with icon), scheduled time, and optional note.
4. Visual escalation works in real time: normal (default border) when future, amber (amber border + background tint) when time arrives, red (red border + background tint) when overdue.
5. Urgency recalculates every 30 seconds via client-side interval without server interaction.
6. "Mark Complete" button on each card calls `markReminderComplete` and shows a success toast.
7. The section header shows a count badge with the number of active reminders.
8. Cards are responsive: 1 column on mobile, 2 on tablet, 3 on desktop.
9. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
4A (Urgency utility) ─────────────────────────────────────────┐
                                                               ├── 4C (Dashboard integration — depends on 4A, 4B)
4B (RemindersSection + ReminderCard) ────────────────────────┘

4C complete ──→ 4D (Verify & polish)
```

**Optimal execution:**
1. Start 4A (urgency utility) and 4B (section component) in parallel — 4A is a small utility, 4B is the main component.
2. Once 4A and 4B are done → 4C (import and place in dashboard).
3. Once 4C is done → 4D (visual verification).

**Estimated time:** 1 day

---

## Subphases

### 4A — Urgency Calculation Utility

**Type:** Frontend
**Parallelizable:** Yes — standalone utility file with no dependencies.

**What:** Create `app/workspace/closer/_components/reminder-urgency.ts` with `getReminderUrgency()` and `getUrgencyStyles()` pure functions.

**Why:** Separating urgency logic into a pure utility makes it testable, reusable, and keeps the component clean. The urgency calculation is a pure function of `reminderScheduledAt` vs `Date.now()` — no side effects.

**Where:**
- `app/workspace/closer/_components/reminder-urgency.ts` (new)

**How:**

**Step 1: Create the utility file**

```typescript
// Path: app/workspace/closer/_components/reminder-urgency.ts

export type ReminderUrgency = "normal" | "amber" | "red";

/**
 * Determine the visual urgency level of a reminder based on current time.
 *
 * - normal: reminderScheduledAt is more than 0ms in the future
 * - amber:  reminderScheduledAt has been reached (within the first 60 seconds)
 * - red:    reminderScheduledAt is more than 60 seconds in the past (overdue)
 *
 * The caller runs this on a client-side interval (e.g., every 30 seconds)
 * so the UI escalates in real time without any server-side scheduling.
 */
export function getReminderUrgency(
  reminderScheduledAt: number,
  now: number,
): ReminderUrgency {
  if (now < reminderScheduledAt) return "normal";
  if (now >= reminderScheduledAt && now < reminderScheduledAt + 60_000) return "amber";
  return "red";
}

/**
 * Returns Tailwind classes for the urgency level.
 * Uses border + subtle background tint for visual escalation.
 * Does NOT rely on color alone — the urgency Badge label also changes.
 */
export function getUrgencyStyles(urgency: ReminderUrgency): string {
  switch (urgency) {
    case "normal":
      return "border-border";
    case "amber":
      return "border-amber-500 bg-amber-50 dark:bg-amber-950/20";
    case "red":
      return "border-red-500 bg-red-50 dark:bg-red-950/20";
  }
}
```

**Key implementation notes:**
- `getReminderUrgency` is a pure function — easy to test with different `now` values.
- The 60-second amber window provides a brief "it's time" state before transitioning to "overdue" red.
- Both functions are exported separately for flexibility. Components use `getUrgencyStyles` for CSS and `getReminderUrgency` for badge variant selection.
- Accessibility: color is supplemented by badge text ("Due", "Now", "Overdue") — see 4B.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/_components/reminder-urgency.ts` | Create | Pure urgency calculation + styling utility |

---

### 4B — RemindersSection & ReminderCard Components

**Type:** Frontend
**Parallelizable:** Yes — can be built alongside 4A (imports the utility, but the API shape is known).

**What:** Create `app/workspace/closer/_components/reminders-section.tsx` with the `RemindersSection` component (subscribes to `getActiveReminders`, manages the 30s tick interval) and the `ReminderCard` sub-component.

**Why:** The Reminders section is the closer's primary view of pending manual follow-ups. It must be reactive (auto-updates from Convex subscription), visually escalating (urgency colors), and actionable ("Mark Complete" button).

**Where:**
- `app/workspace/closer/_components/reminders-section.tsx` (new)

**How:**

**Step 1: Create the section component**

```tsx
// Path: app/workspace/closer/_components/reminders-section.tsx
"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  BellIcon,
  PhoneIcon,
  MessageSquareIcon,
  CheckCircleIcon,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  getReminderUrgency,
  getUrgencyStyles,
  type ReminderUrgency,
} from "./reminder-urgency";

const TICK_INTERVAL_MS = 30_000; // Re-evaluate urgency every 30 seconds

export function RemindersSection() {
  const reminders = useQuery(api.closer.followUpQueries.getActiveReminders);
  const markComplete = useMutation(
    api.closer.followUpMutations.markReminderComplete,
  );
  const [now, setNow] = useState(() => Date.now());
  const [completingId, setCompletingId] = useState<Id<"followUps"> | null>(null);

  // Tick interval for urgency recalculation
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  const handleMarkComplete = async (followUpId: Id<"followUps">) => {
    setCompletingId(followUpId);
    try {
      await markComplete({ followUpId });
      toast.success("Reminder marked as complete");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to mark complete",
      );
    } finally {
      setCompletingId(null);
    }
  };

  // Don't render the section at all if there are no reminders
  if (!reminders || reminders.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <BellIcon className="size-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Reminders</h2>
        <Badge variant="secondary">{reminders.length}</Badge>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {reminders.map((reminder) => {
          const urgency = getReminderUrgency(
            reminder.reminderScheduledAt ?? 0,
            now,
          );
          return (
            <ReminderCard
              key={reminder._id}
              reminder={reminder}
              urgency={urgency}
              isCompleting={completingId === reminder._id}
              onMarkComplete={() => handleMarkComplete(reminder._id)}
            />
          );
        })}
      </div>
    </div>
  );
}
```

**Step 2: Create the ReminderCard sub-component**

```tsx
// Path: app/workspace/closer/_components/reminders-section.tsx (continued)

function ReminderCard({
  reminder,
  urgency,
  isCompleting,
  onMarkComplete,
}: {
  reminder: {
    _id: Id<"followUps">;
    contactMethod?: "call" | "text";
    reminderScheduledAt?: number;
    reminderNote?: string;
    leadName: string;
    leadPhone: string | null;
  };
  urgency: ReminderUrgency;
  isCompleting: boolean;
  onMarkComplete: () => void;
}) {
  const MethodIcon = reminder.contactMethod === "text" ? MessageSquareIcon : PhoneIcon;
  const urgencyLabel = urgency === "red" ? "Overdue" : urgency === "amber" ? "Now" : "Due";

  return (
    <Card className={cn("transition-colors", getUrgencyStyles(urgency))}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{reminder.leadName}</CardTitle>
          <Badge
            variant={
              urgency === "red"
                ? "destructive"
                : urgency === "amber"
                  ? "outline"
                  : "secondary"
            }
          >
            <MethodIcon className="mr-1 size-3" />
            {reminder.contactMethod === "text" ? "Text" : "Call"}
            {" · "}
            {urgencyLabel}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {/* Phone number — prominent, clickable */}
        {reminder.leadPhone && (
          <a
            href={`tel:${reminder.leadPhone}`}
            className="text-lg font-semibold text-primary hover:underline"
          >
            {reminder.leadPhone}
          </a>
        )}

        {/* Scheduled time */}
        {reminder.reminderScheduledAt && (
          <p className="text-sm text-muted-foreground">
            {new Date(reminder.reminderScheduledAt).toLocaleString([], {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </p>
        )}

        {/* Note */}
        {reminder.reminderNote && (
          <p className="text-sm text-muted-foreground line-clamp-2">
            {reminder.reminderNote}
          </p>
        )}

        <Button
          variant="outline"
          size="sm"
          onClick={onMarkComplete}
          disabled={isCompleting}
          className="mt-2 w-full"
        >
          <CheckCircleIcon data-icon="inline-start" />
          {isCompleting ? "Completing..." : "Mark Complete"}
        </Button>
      </CardContent>
    </Card>
  );
}
```

**Key implementation notes:**
- `useQuery(api.closer.followUpQueries.getActiveReminders)` auto-updates when reminders are created or completed — no manual refresh needed.
- The `now` state updates every 30 seconds via `setInterval`. This triggers re-renders that recalculate urgency for all cards. For ≤50 cards, this is negligible.
- `completingId` tracks which card is being completed to show a loading state on that specific button.
- The section returns `null` when there are no reminders — no skeleton or empty state needed.
- Accessibility: the Badge includes both the method icon AND a text label ("Call · Due", "Text · Overdue") so urgency is not conveyed by color alone.
- Phone number uses `tel:` link for one-tap calling on mobile.
- Note text is clamped to 2 lines (`line-clamp-2`) to keep card heights consistent.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/_components/reminders-section.tsx` | Create | `RemindersSection` + `ReminderCard` components |

---

### 4C — Dashboard Integration

**Type:** Frontend
**Parallelizable:** No — depends on 4A and 4B being complete.

**What:** Import `RemindersSection` into `closer-dashboard-page-client.tsx` and place it between the Featured Meeting Card and the Pipeline Strip.

**Why:** The dashboard is the closer's primary workspace. Reminders must appear prominently — after the hero meeting card but before pipeline stats.

**Where:**
- `app/workspace/closer/_components/closer-dashboard-page-client.tsx` (modify)

**How:**

**Step 1: Add the import**

```tsx
// Path: app/workspace/closer/_components/closer-dashboard-page-client.tsx (add import)
import { RemindersSection } from "./reminders-section";
```

**Step 2: Insert the component**

The current dashboard JSX (from the explore results) renders sections in this order:
1. Header section (title + greeting)
2. Unmatched banner
3. Featured meeting card or empty state
4. Pipeline strip
5. Separator
6. Calendar section

Insert `<RemindersSection />` between item 3 (featured meeting) and item 4 (pipeline strip):

```tsx
// Path: app/workspace/closer/_components/closer-dashboard-page-client.tsx — BEFORE (lines ~87-92)
      {/* Featured meeting or empty state */}
      {nextMeeting ? (
        <FeaturedMeetingCard meeting={...} lead={...} eventTypeName={...} />
      ) : (
        <CloserEmptyState title="No upcoming meetings" description="..." />
      )}

      <PipelineStrip counts={pipelineSummary.counts} total={pipelineSummary.total} />
```

```tsx
// Path: app/workspace/closer/_components/closer-dashboard-page-client.tsx — AFTER
      {/* Featured meeting or empty state */}
      {nextMeeting ? (
        <FeaturedMeetingCard meeting={...} lead={...} eventTypeName={...} />
      ) : (
        <CloserEmptyState title="No upcoming meetings" description="..." />
      )}

      {/* Reminders section — only renders when closer has active reminders */}
      <RemindersSection />

      <PipelineStrip counts={pipelineSummary.counts} total={pipelineSummary.total} />
```

**Key implementation notes:**
- `RemindersSection` calls `useQuery` internally and returns `null` when there are no reminders. No conditional rendering needed at the dashboard level.
- No additional loading state or skeleton is needed — the section simply doesn't render until data arrives. This avoids CLS for closers who have no reminders (the majority case).
- The section uses its own `useQuery` subscription — separate from the dashboard's existing queries. This is efficient because Convex deduplicates subscriptions.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/_components/closer-dashboard-page-client.tsx` | Modify | Import and insert `<RemindersSection />` |

---

### 4D — Verify & Polish

**Type:** Frontend
**Parallelizable:** No — final verification step.

**What:** Verify the reminders section renders correctly on all viewports and urgency states work.

**Why:** Visual escalation is a key UX feature. Must work correctly across light/dark mode and all responsive breakpoints.

**Where:**
- No file changes — verification only.

**How:**

**Step 1: Create test reminder data**

In the Convex dashboard, create 3+ `followUps` records with `type: "manual_reminder"`, `status: "pending"`, and varying `reminderScheduledAt` values:
- One in the future (normal state)
- One at current time (amber state)
- One in the past (red/overdue state)

**Step 2: Verify visual escalation**

Open the closer dashboard. Verify:
- Future reminder: default border, "Due" badge
- Current reminder: amber border + background, "Now" badge
- Overdue reminder: red border + background, "Overdue" badge

**Step 3: Verify "Mark Complete"**

Click "Mark Complete" on a reminder. Verify:
- Button shows "Completing..." loading state
- Success toast appears
- Card disappears from the section (Convex subscription auto-updates)
- If it was the last reminder, the section disappears entirely

**Step 4: Verify responsive layout**

- Mobile (<640px): 1 column
- Tablet (640-1024px): 2 columns
- Desktop (>1024px): 3 columns

**Step 5: TypeScript compilation**

```bash
pnpm tsc --noEmit
```

**Files touched:**

| File | Action | Notes |
|---|---|---|
| _(none)_ | — | Verification only |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/closer/_components/reminder-urgency.ts` | Create | 4A |
| `app/workspace/closer/_components/reminders-section.tsx` | Create | 4B |
| `app/workspace/closer/_components/closer-dashboard-page-client.tsx` | Modify | 4C |

---

**Next Phase:** Phase 4 is independent of Phases 2, 3, and 5. The reminder flow works end-to-end after Phase 1 + Phase 3 (dialog to create reminders) + Phase 4 (dashboard to view them).
