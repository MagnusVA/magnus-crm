# Phase 1 — Display Booking Answers in LeadInfoPanel

**Goal:** Closers see every Calendly booking-form answer in a "Booking Answers" card on the meeting detail sidebar, with proper long-text handling and accessibility — without any backend changes.

**Prerequisite:** None — the webhook pipeline already stores `customFields` on leads and the `getMeetingDetail` query already returns the full lead document.

**Runs in PARALLEL with:** Nothing — Phase 2 (schema hardening) depends on this phase being complete so the UI is in place before the schema is tightened.

**Skills to invoke:**
- `shadcn` — verify Card, Collapsible, Separator component APIs match our usage
- `web-design-guidelines` — accessibility audit of the final component
- `frontend-design` — visual polish and alignment with existing sidebar cards
- `simplify` — post-implementation review for code quality

**Acceptance Criteria:**

1. When a lead has `customFields` with at least one string key-value pair, a "Booking Answers" card appears in the left sidebar between "Lead Information" and "Meeting History".
2. When a lead has no `customFields` (undefined, null, empty object, or malformed data), no "Booking Answers" card renders — the sidebar looks identical to the current state.
3. Each question-answer pair renders as a `<dt>` (question label) + `<dd>` (answer value) inside a `<dl>`.
4. Question labels use the same uppercase-muted style as existing labels ("NAME", "EMAIL", "DATE & TIME").
5. Answers longer than 120 characters collapse behind a "Show more" / "Show less" toggle that is keyboard-accessible (focusable via Tab, activable via Enter/Space).
6. The card renders correctly at all three breakpoints: mobile (`grid-cols-1`), tablet (`md:grid-cols-3`), and desktop (`lg:grid-cols-4`).
7. Long answers with special characters (emoji, CJK, long words) do not overflow the card horizontally.
8. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
1A (BookingAnswersCard component) ──→ 1B (LeadInfoPanel integration) ──→ 1C (Verification)
```

**Optimal execution:** Sequential — each step depends on the previous.

**Estimated time:** 1–2 hours

---

## Subphases

### 1A — Create BookingAnswersCard Component

**Type:** Frontend
**Parallelizable:** No — 1B depends on this component existing.

**What:** New file `booking-answers-card.tsx` containing the `BookingAnswersCard` component, the `CollapsibleAnswer` sub-component, and the `isStringRecord` type guard.

**Why:** This is the core deliverable — the card that renders booking-form answers. Without it, there's nothing to integrate into the panel.

**Where:**
- `app/workspace/closer/meetings/_components/booking-answers-card.tsx` (new)

**How:**

**Step 1: Create the component file**

```tsx
// Path: app/workspace/closer/meetings/_components/booking-answers-card.tsx
"use client";

import { useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Character threshold above which an answer gets a "Show more" toggle. */
const LONG_ANSWER_THRESHOLD = 120;

type BookingAnswersCardProps = {
  customFields: unknown;
};

/**
 * Displays Calendly booking-form answers as a definition list.
 *
 * - Uses <dl>/<dt>/<dd> for semantic correctness (question → answer pairs).
 * - Hides entirely when customFields is absent / empty / malformed.
 * - Long answers (>120 chars) collapse behind a Collapsible toggle.
 */
export function BookingAnswersCard({ customFields }: BookingAnswersCardProps) {
  if (!isStringRecord(customFields)) return null;

  const entries = Object.entries(customFields);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Booking Answers</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="flex flex-col gap-3">
          {entries.map(([question, answer], index) => (
            <div key={question}>
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {question}
              </dt>
              {answer.length > LONG_ANSWER_THRESHOLD ? (
                <CollapsibleAnswer answer={answer} />
              ) : (
                <dd className="mt-1 text-sm leading-relaxed break-words">
                  {answer}
                </dd>
              )}
              {index < entries.length - 1 && (
                <Separator className="mt-3" />
              )}
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

// ─── Internal ──────────────────────────────────────────────────────────

function CollapsibleAnswer({ answer }: { answer: string }) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <dd className="mt-1">
        {!open && (
          <p className="line-clamp-3 text-sm leading-relaxed break-words">
            {answer}
          </p>
        )}
        <CollapsibleContent>
          <p className="text-sm leading-relaxed break-words">{answer}</p>
        </CollapsibleContent>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded"
          >
            {open ? "Show less" : "Show more"}
            <ChevronDownIcon
              className={cn(
                "size-3 transition-transform",
                open && "rotate-180",
              )}
            />
          </button>
        </CollapsibleTrigger>
      </dd>
    </Collapsible>
  );
}

/**
 * Runtime guard: true when value is a non-empty Record<string, string>.
 *
 * Rejects: null, undefined, arrays, objects with non-string values,
 * empty objects.
 */
function isStringRecord(
  value: unknown,
): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return false;
  return entries.every(
    ([, v]) => typeof v === "string" && v.length > 0,
  );
}
```

**Key implementation notes:**
- The prop type is `unknown` (not `Record<string, string>`) because `Doc<"leads">["customFields"]` is typed as `any` due to `v.optional(v.any())`. The `isStringRecord` guard narrows it safely at runtime.
- `ClipboardListIcon` from the design doc is not imported — the card title alone is sufficient without an icon, matching "Meeting History" which also has no icon in its card header.
- The `CollapsibleAnswer` conditionally renders the clamped text **or** the full text — not both simultaneously — to avoid the full text being in the DOM while visually hidden (better for search-in-page and copy behavior).
- `Separator` only renders between items, not after the last one (`index < entries.length - 1`).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/booking-answers-card.tsx` | Create | New component with type guard and collapsible sub-component |

---

### 1B — Integrate into LeadInfoPanel

**Type:** Frontend
**Parallelizable:** No — depends on 1A (the component must exist to import it).

**What:** Import `BookingAnswersCard` into `lead-info-panel.tsx` and render it between the Lead Profile card and the Meeting History card.

**Why:** This is the wiring step that makes the new card visible in the product. Without it, the component file exists but is never rendered.

**Where:**
- `app/workspace/closer/meetings/_components/lead-info-panel.tsx` (modify)

**How:**

**Step 1: Add the import**

Add after the existing `MeetingHistoryTimeline` import:

```tsx
// Path: app/workspace/closer/meetings/_components/lead-info-panel.tsx

// BEFORE (existing):
import { MeetingHistoryTimeline } from "./meeting-history-timeline";
import type { Doc } from "@/convex/_generated/dataModel";

// AFTER (add one import):
import { MeetingHistoryTimeline } from "./meeting-history-timeline";
import { BookingAnswersCard } from "./booking-answers-card";
import type { Doc } from "@/convex/_generated/dataModel";
```

**Step 2: Render the card in the JSX**

Insert `<BookingAnswersCard>` between the closing `</Card>` of the Lead Profile card and the `{meetingHistory.length > 0 && (` conditional:

```tsx
// Path: app/workspace/closer/meetings/_components/lead-info-panel.tsx

// BEFORE (existing):
        </CardContent>
      </Card>

      {/* Meeting History */}
      {meetingHistory.length > 0 && (

// AFTER (add one line):
        </CardContent>
      </Card>

      {/* Booking Answers */}
      <BookingAnswersCard customFields={lead.customFields} />

      {/* Meeting History */}
      {meetingHistory.length > 0 && (
```

**Key implementation notes:**
- No changes to `LeadInfoPanelProps` — the `lead: Doc<"leads">` prop already includes `customFields`.
- No changes to the `MeetingDetailPageClient` component — it already passes the full `lead` object.
- No changes to the Convex query — `getMeetingDetail` already returns the full lead document.
- The `BookingAnswersCard` returns `null` when there are no valid custom fields, so the gap between Lead Profile and Meeting History remains 16px (the `gap-4` on the parent flex container) — identical to the current state.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/lead-info-panel.tsx` | Modify | Add import + render `BookingAnswersCard` |

---

### 1C — Verification

**Type:** Manual
**Parallelizable:** No — depends on 1A and 1B being complete.

**What:** Run type checking and verify the component works across all edge cases and breakpoints.

**Why:** Ensures the implementation meets acceptance criteria before moving to Phase 2.

**Where:**
- No file changes — verification only.

**How:**

**Step 1: Type check**

```bash
pnpm tsc --noEmit
```

Must pass with zero errors.

**Step 2: Visual verification in browser**

Navigate to a meeting detail page for a lead that has `customFields` populated. Verify:

- "Booking Answers" card appears between "Lead Information" and "Meeting History"
- Question labels render in uppercase muted style matching "NAME", "EMAIL" labels
- Short answers render inline
- Long answers (>120 chars) show collapsed with "Show more" button
- Clicking "Show more" expands the answer, button text changes to "Show less"
- Clicking "Show less" collapses back to 3-line clamp
- "Show more" button is focusable via Tab key and activable via Enter/Space

**Step 3: Verify edge cases**

Test by temporarily modifying the lead's `customFields` in the Convex dashboard or by checking leads with different data states:

| Test case                      | Expected behavior                            |
|---|---|
| `customFields` is `undefined`  | No "Booking Answers" card renders             |
| `customFields` is `{}`         | No "Booking Answers" card renders             |
| `customFields` has 1 pair      | Card renders with one Q&A, no separator       |
| `customFields` has 5+ pairs    | Card renders all pairs with separators        |
| Answer contains emoji          | Emoji renders correctly                       |
| Answer is 500+ characters      | Collapsed with "Show more" toggle             |

**Step 4: Responsive check**

Resize browser or use DevTools to verify at:
- Mobile (~375px): Card is full-width, single-column layout
- Tablet (~768px): Card is in the narrow left sidebar (~380px)
- Desktop (~1200px): Card is in the narrowest sidebar (~300px)

At all widths, verify no horizontal overflow occurs for long words (the `break-words` class should handle this).

**Step 5: Invoke skills**

- Invoke `web-design-guidelines` to audit the component for accessibility compliance
- Invoke `simplify` to review the component for code quality and potential improvements

**Key implementation notes:**
- If the development environment has no leads with `customFields`, use the Convex dashboard to patch a test lead: `db.patch(leadId, { customFields: { "Budget?": "$50k", "Company size": "50-200", "Tell us about your project": "We are looking to migrate our legacy platform to a modern cloud-based solution that can scale with our growing customer base and provide real-time analytics capabilities for our sales team across multiple regions." } })`
- The `simplify` skill should specifically check whether the `isStringRecord` guard could be simplified or if the `CollapsibleAnswer` component introduces unnecessary re-renders.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| (none) | — | Verification only |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/closer/meetings/_components/booking-answers-card.tsx` | Create | 1A |
| `app/workspace/closer/meetings/_components/lead-info-panel.tsx` | Modify | 1B |
