# Phase 4 — Page Integration & Testing

**Goal:** Wire all new components (DealWonCard, AttributionCard, MeetingOutcomeSelect/MeetingNotes) into the meeting detail page client component, update the `MeetingDetailData` type to reflect the enriched backend, update the skeleton, and run comprehensive QA (responsive, accessibility, performance, console errors).

**Prerequisite:** Phase 1 (backend), Phase 2 (card components), and Phase 3 (notes enhancement) all complete.

**Runs in PARALLEL with:** Nothing — this is the final integration phase. All prior phases feed into it.

> **Critical path:** This phase is the final gate before Feature I is declared complete and Quality Gate 1 can run. Avoid unnecessary delays — the integration work is mechanical (imports + layout), and the QA work uses the `expect` skill.

**Skills to invoke:**
- `expect` — Browser QA: responsive testing (4 viewports), image lightbox verification, accessibility audit (WCAG AA), console error check, performance metrics (LCP, CLS, INP).
- `frontend-design` — Final layout polish, verify spacing consistency and visual hierarchy.
- `shadcn` — Confirm all components use correct shadcn/ui primitives and match the design system.

**Acceptance Criteria:**
1. The meeting detail page renders all new cards in the correct order: MeetingInfoPanel → BookingAnswersCard → DealWonCard (conditional) → AttributionCard → MeetingNotes (with outcome select) → PaymentLinksPanel (conditional).
2. The `DealWonCard` is only rendered when `opportunity.status === "payment_received"` AND `payments.length > 0`.
3. The `AttributionCard` is always rendered (shows "No data" gracefully when no UTMs).
4. The `MeetingNotes` component receives the `meetingOutcome` prop from the meeting data.
5. The `MeetingDetailData` type correctly reflects enriched payments (with `proofFileUrl`, `proofFileContentType`, `proofFileSize`, `closerName`).
6. The skeleton includes placeholders for the new cards.
7. Responsive layout verified at 4 viewports: 375px (mobile), 768px (tablet), 1280px (desktop), 1440px+ (wide).
8. Accessibility audit passes WCAG AA — all badges have contrast, lightbox is keyboard navigable, select has aria-label.
9. No console errors or warnings on the meeting detail page.
10. Performance metrics (LCP, CLS, INP) within acceptable ranges.
11. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
4A (Update MeetingDetailData type + page client imports) ──────────┐
                                                                    ├── 4C (QA: Expect — responsive + a11y + perf)
4B (Update skeleton) ──────────────────────────────────────────────┘
```

**Optimal execution:**
1. Start 4A and 4B **in parallel** — 4A modifies the main render section of the page client, 4B modifies the skeleton function at the bottom. Both are in the same file but different sections.
2. After 4A and 4B → 4C (QA testing with `expect` — delegated to a subagent).

**Estimated time:** ~30 minutes (4A: ~15min, 4B: ~5min parallel, 4C: ~15min)

---

## Subphases

### 4A — Update Page Client: Types, Imports, and Layout Integration

**Type:** Frontend
**Parallelizable:** Partially — can run alongside 4B (different code sections within the same file), but both target the same file. Safest to run sequentially or carefully.

**What:** Modify `meeting-detail-page-client.tsx` to:
1. Update the `MeetingDetailData` type to include enriched payment fields.
2. Import the new card components.
3. Add the new cards to the layout JSX.
4. Pass `meetingOutcome` to `MeetingNotes`.

**Why:** This is the wiring step — connecting the backend data (Phase 1) and frontend components (Phases 2-3) into the existing page layout. Without this, the components exist but aren't rendered.

**Where:**
- `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` (modify)

**How:**

**Step 1: Add new imports**

Add the new component imports below the existing ones:

```tsx
// Path: app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx

// EXISTING imports:
import { LeadInfoPanel } from "../../_components/lead-info-panel";
import { MeetingInfoPanel } from "../../_components/meeting-info-panel";
import { MeetingNotes } from "../../_components/meeting-notes";
import { PaymentLinksPanel } from "../../_components/payment-links-panel";
import { OutcomeActionBar } from "../../_components/outcome-action-bar";
import { BookingAnswersCard } from "../../_components/booking-answers-card";

// NEW imports:
import { DealWonCard } from "../../_components/deal-won-card";
import { AttributionCard } from "../../_components/attribution-card";
```

**Step 2: Update the `MeetingDetailData` type**

Replace the `payments` field type to include the enriched fields:

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
  payments: Doc<"paymentRecords">[];
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
} | null;
```

**Step 3: Update the JSX layout**

Replace the right column content section with the new card ordering:

```tsx
// Path: app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx

// BEFORE (right column):
        <div className="flex flex-col gap-6 md:col-span-2 lg:col-span-3">
          <MeetingInfoPanel
            meeting={meeting}
            eventTypeName={eventTypeName}
            assignedCloser={assignedCloser}
          />
          <BookingAnswersCard customFields={lead.customFields} />
          <MeetingNotes
            meetingId={meeting._id}
            initialNotes={meeting.notes ?? ""}
          />
          {paymentLinks && paymentLinks.length > 0 && (
            <PaymentLinksPanel paymentLinks={paymentLinks} />
          )}
        </div>

// AFTER (right column — new cards added):
        <div className="flex flex-col gap-6 md:col-span-2 lg:col-span-3">
          <MeetingInfoPanel
            meeting={meeting}
            eventTypeName={eventTypeName}
            assignedCloser={assignedCloser}
          />
          <BookingAnswersCard customFields={lead.customFields} />

          {/* Deal Won Card — only when opportunity is won with payments */}
          {opportunity.status === "payment_received" && payments.length > 0 && (
            <DealWonCard payments={payments} />
          )}

          {/* Attribution Card — always shown */}
          <AttributionCard
            opportunity={opportunity}
            meeting={meeting}
            meetingHistory={meetingHistory}
          />

          {/* Notes with outcome select */}
          <MeetingNotes
            meetingId={meeting._id}
            initialNotes={meeting.notes ?? ""}
            meetingOutcome={meeting.meetingOutcome}
          />

          {paymentLinks && paymentLinks.length > 0 && (
            <PaymentLinksPanel paymentLinks={paymentLinks} />
          )}
        </div>
```

**Key implementation notes:**
- The `DealWonCard` guard is `opportunity.status === "payment_received" && payments.length > 0` — both conditions must be true. Status alone is insufficient because a data integrity issue could leave `payments` empty.
- `meeting.meetingOutcome` is now a valid field on `Doc<"meetings">` after Phase 1A schema deployment. TypeScript will verify this at compile time.
- The `AttributionCard` receives `meetingHistory` which it uses to infer booking type. This array is already destructured from `detail`.
- Card ordering rationale: MeetingInfo (context) → BookingAnswers (context) → DealWon (outcome — conditional) → Attribution (background) → Notes (interactive) → PaymentLinks (utility).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` | Modify | Add imports, update type, add cards to layout |

---

### 4B — Update Skeleton

**Type:** Frontend
**Parallelizable:** Partially — targets the same file as 4A but a different function (`MeetingDetailSkeleton`).

**What:** Update the `MeetingDetailSkeleton` function in `meeting-detail-page-client.tsx` to include skeleton placeholders for the new cards.

**Why:** The skeleton must match the shape of the loaded page to prevent CLS (Cumulative Layout Shift). Without updated skeletons, the page jumps when new cards render.

**Where:**
- `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` (modify — same file as 4A, different section)

**How:**

**Step 1: Update the skeleton right column**

```tsx
// Path: app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx

// BEFORE (MeetingDetailSkeleton right column):
        <div className="flex flex-col gap-4 md:col-span-2 lg:col-span-3">
          <Skeleton className="h-56 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </div>

// AFTER:
        <div className="flex flex-col gap-4 md:col-span-2 lg:col-span-3">
          <Skeleton className="h-56 rounded-xl" />  {/* Meeting Info */}
          <Skeleton className="h-32 rounded-xl" />  {/* Booking Answers */}
          <Skeleton className="h-36 rounded-xl" />  {/* Attribution */}
          <Skeleton className="h-52 rounded-xl" />  {/* Notes + Outcome */}
        </div>
```

**Key implementation notes:**
- The Deal Won card is conditional (only for won deals) so it does NOT get a skeleton — skeletons represent the always-present layout.
- Skeleton heights approximate the actual card heights to minimize CLS.
- The `gap-4` matches the existing skeleton layout. The loaded page uses `gap-6` — this slight difference is acceptable for a loading state. If CLS is flagged during QA, adjust.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` | Modify | Update MeetingDetailSkeleton |

---

### 4C — QA: Responsive, Accessibility, Performance

**Type:** Manual / Testing
**Parallelizable:** No — must run after 4A and 4B (needs the full integrated page).

**What:** Run the `expect` skill to verify the meeting detail page at 4 viewports, run accessibility audit, check console errors, and measure performance metrics.

**Why:** Quality Gate 1 requirement. The page must be visually correct, accessible, and performant before Feature I is declared complete.

**Where:**
- No file changes. Uses `expect` MCP tools.

**How:**

**Step 1: Prepare test data**

Ensure the test tenant has at least:
- 1 meeting with `opportunity.status === "payment_received"` and a payment with a proof file (image) — tests DealWonCard + lightbox.
- 1 meeting with `opportunity.utmParams` set — tests AttributionCard with UTM data.
- 1 meeting that is a follow-up (has a predecessor meeting) — tests booking type "Follow-Up".
- 1 meeting with no UTM params and no payments — tests graceful degradation.

**Step 2: Open the meeting detail page in Expect**

Use the `expect` skill's `open` tool to navigate to a meeting detail page with full data:

```
mcp__expect__open: url="/workspace/closer/meetings/{meetingId}"
```

**Step 3: Screenshot at 4 viewports**

```
mcp__expect__screenshot at 375px (mobile)
mcp__expect__screenshot at 768px (tablet)
mcp__expect__screenshot at 1280px (desktop)
mcp__expect__screenshot at 1440px (wide)
```

Verify:
- All cards stack vertically on mobile.
- Grid layout activates on tablet (1+2 columns) and desktop (1+3 columns).
- No horizontal overflow or truncation issues.
- Deal Won card's emerald tint is visible in both light and dark mode.

**Step 4: Test image lightbox**

```
mcp__expect__playwright: click on the proof image thumbnail
mcp__expect__screenshot: verify lightbox dialog is open with full-size image
mcp__expect__playwright: press Escape
mcp__expect__screenshot: verify lightbox is closed
```

**Step 5: Test meeting outcome select**

```
mcp__expect__playwright: click the "Select outcome" dropdown
mcp__expect__screenshot: verify dropdown shows 5 options with colored badges
mcp__expect__playwright: select "Interested"
```

Verify toast success appears.

**Step 6: Accessibility audit**

```
mcp__expect__accessibility_audit
```

Verify:
- No critical or serious violations.
- All badges have sufficient color contrast (WCAG AA).
- Lightbox dialog has `role="dialog"` and keyboard trap.
- Select has `aria-label`.
- Save timestamp uses `aria-live="polite"`.

**Step 7: Console errors check**

```
mcp__expect__console_logs
```

Verify: No errors or React warnings.

**Step 8: Performance metrics**

```
mcp__expect__performance_metrics
```

Verify: LCP, CLS, INP within acceptable ranges. The additional cards should not significantly impact paint times.

**Step 9: Close**

```
mcp__expect__close
```

**Key implementation notes:**
- Delegate this entire subphase to a subagent using the `expect` skill to keep the main context free.
- If accessibility issues are found, fix them in 4A/4B before re-running the audit.
- Data seeding: pages must have real data (not empty states) for valid testing. Ensure the test meeting has payments with proof files.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| (none) | — | QA verification only |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` | Modify | 4A, 4B |
