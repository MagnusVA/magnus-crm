# Phase 6 — Dashboard Integration & Cleanup

**Goal:** Rewire the existing closer dashboard's `RemindersSection` so clicking a reminder navigates to the new detail page (instead of opening the inline `ReminderDetailDialog`), remove the now-dead dialog code, and run the full browser-based QA gate via the `expect` skill to confirm the end-to-end flow. After this phase, the feature is fully shipped: a closer can click a reminder on their dashboard → land on the new page → record any of three outcomes → return to an updated dashboard.

**Prerequisite:**
- Phase 4 deployed (`/workspace/closer/reminders/[followUpId]` route is live and renders).
- Phase 5 deployed (the three outcome dialogs are wired and mutations complete successfully).
- All prior phases deployed to the dev environment with real data for testing (minimum 3 manual_reminder follow-ups in varied states — overdue, due soon, upcoming — per the `expect` skill's data-seeding rule).

**Runs in PARALLEL with:** Nothing. Phase 6 is the finaliser — it modifies the dashboard card that Phase 4's route targets. Running it earlier would break the dashboard (clicks would navigate to a nonexistent route); running it alongside Phase 4/5 risks merge conflicts on `reminders-section.tsx`.

> **Critical path:** This phase closes the critical path. Everything upstream enables it, but the feature is not "shipped" until 6C's browser QA passes.

**Skills to invoke:**
- `expect` — Browser-based verification is the Phase 6 gate. The skill will: open the dashboard, click a reminder, assert the detail page renders, complete each of the three outcomes, assert the dashboard reflects the change. Must include accessibility audit (axe-core), performance metrics (LCP, INP), and console error check. Responsive testing across 4 viewports.
- `simplify` — Post-implementation review for unused props, dead code paths, orphaned state machines. Specifically target the old `ReminderDetailDialog` component and any `selectedReminder` state that may linger in `reminders-section.tsx`.
- `web-design-guidelines` — Final WCAG pass on both the dashboard card interaction (keyboard navigability of the click target) and the new detail page's tab order.

**Acceptance Criteria:**
1. Clicking any reminder list item in `RemindersSection` navigates to `/workspace/closer/reminders/<followUpId>` — no inline dialog opens.
2. The old `ReminderDetailDialog` component definition is removed from the codebase (or the file it lived in).
3. The `selectedReminder` state variable and its `useEffect`/setter chain are removed from `reminders-section.tsx`.
4. `markReminderComplete` mutation is **retained** (it is still a valid legacy path) but is no longer called from `reminders-section.tsx`.
5. The dashboard Reminders card still shows pending reminders correctly (real-time `getActiveReminders` query unchanged).
6. After completing a reminder on the detail page and returning to the dashboard, the completed reminder no longer appears in the list (Convex reactivity handles this automatically — verify).
7. Direct-URL navigation to `/workspace/closer/reminders/<random-invalid-id>` renders the "Reminder Not Found" empty state without crashing.
8. A reminder owned by another closer (same tenant) renders "Reminder Not Found" when opened directly via URL.
9. The `expect` skill's browser verification runs end-to-end with zero critical accessibility violations.
10. `pnpm tsc --noEmit` passes without errors.
11. No console errors during the full click-through flow (dashboard → detail → outcome → dashboard).
12. PostHog receives the four expected events per flow: `reminder_page_opened`, plus one of `reminder_outcome_payment` / `reminder_outcome_lost` / `reminder_outcome_no_response`.

---

## Subphase Dependency Graph

```
6A (dashboard route swap)  ────── 6B (dead code cleanup)  ────── 6C (browser QA gate)
```

**Optimal execution:**
1. **6A** first — swap the click handler to `router.push`. This is a surgical 5-line change.
2. **6B** next — remove the inline dialog, `selectedReminder` state, and orphaned imports. `pnpm tsc --noEmit` will flag anything that was depending on them.
3. **6C** last — the `expect` browser verification. This is the phase's gate; do not declare the feature shipped until it passes.

**Why sequential only:** The steps are ordered by dependency. 6B cannot safely delete `ReminderDetailDialog` until 6A has pointed users to the new route (otherwise production users mid-flow would see an empty dashboard). 6C needs the codebase in its final shape before running the browser gate.

**Estimated time:** 0.5–1 day.
- 6A: 15 minutes.
- 6B: 30–60 minutes (depending on how much dead code needs surgery).
- 6C: 2–4 hours (browser verification across 4 viewports, 3 outcome paths, + accessibility + performance audits).

---

## Subphases

### 6A — Dashboard route swap

**Type:** Frontend
**Parallelizable:** No — blocks 6B.

**What:** Change the reminder list item's `onClick` from "open inline dialog" to "push to the new detail page". Remove the prop flow that carried the `ReminderDetailDialog`'s open/selected state.

**Why:** The dashboard is the entry point for every reminder interaction. Without this change, the new detail page is unreachable from normal user flow (only craft-URL access works). Swapping the handler is the minimum change to connect the dots.

**Where:**
- `app/workspace/closer/_components/reminders-section.tsx` (modify)

**How:**

**Step 1: Locate the existing click handler pattern in `reminders-section.tsx`.** The design doc §9.2 shows the before/after shape:

```tsx
// Path: app/workspace/closer/_components/reminders-section.tsx

// BEFORE — opens inline dialog
const [selectedReminder, setSelectedReminder] = useState<Reminder | null>(null);
// ...
<ReminderListItem
  reminder={reminder}
  urgency={urgency}
  onClick={() => setSelectedReminder(reminder)}
/>
// ...
{selectedReminder && (
  <ReminderDetailDialog
    reminder={selectedReminder}
    onClose={() => setSelectedReminder(null)}
  />
)}
```

**Step 2: Replace with `router.push`.** Keep the same `onClick` contract on `ReminderListItem` (it's a pure presentational component).

```tsx
// Path: app/workspace/closer/_components/reminders-section.tsx

// AFTER — navigates to the new page
import { useRouter } from "next/navigation";
// ...
export function RemindersSection() {
  const router = useRouter();
  // (Remove: const [selectedReminder, setSelectedReminder] = useState<Reminder | null>(null))
  const reminders = useQuery(api.closer.followUpQueries.getActiveReminders);
  // ...
  return (
    <Card>
      {/* ... card header unchanged ... */}
      <CardContent>
        {reminders?.map((reminder) => {
          const urgency = getReminderUrgency(reminder.reminderScheduledAt);
          return (
            <ReminderListItem
              key={reminder._id}
              reminder={reminder}
              urgency={urgency}
              onClick={() => {
                // NEW — push to the dedicated reminder detail page.
                // No preloading needed; the RSC on the target route
                // handles its own preloadQuery.
                router.push(`/workspace/closer/reminders/${reminder._id}`);
              }}
            />
          );
        })}
      </CardContent>
    </Card>
  );
}
```

**Step 3: Remove the `{selectedReminder && <ReminderDetailDialog ... />}` block.** This is cosmetic (the component now returns null because state is null), but keeping it compiles dead code into the bundle. Full removal happens in 6B; 6A can leave the block until 6B cleans it.

**Step 4: Verify in the browser.** With `npm run dev` running, click a reminder. Confirm the URL changes to `/workspace/closer/reminders/<id>` and the detail page renders.

**Step 5: `pnpm tsc --noEmit`.** Any remaining references to `selectedReminder` in this file will typecheck-fail — expected; 6B addresses them.

**Key implementation notes:**
- **`router.push`, not `<Link>`.** The list item is a button-like card, not a semantic anchor. If you prefer anchor semantics for "open in new tab" support, wrap the whole item in `<Link>` — but matching the current click-handler pattern keeps the blast radius small.
- **No preloading from the dashboard.** The RSC at `page.tsx` handles its own `preloadQuery` on navigation. Pre-fetching from the dashboard is an optimisation not worth the bundle cost for MVP.
- **Keep `ReminderListItem` untouched.** It receives `onClick` and renders; changing its signature would churn unrelated code.
- **No feature flag here.** Phase 5's optional flag guard covers the whole feature; the dashboard just respects where the URL points. If the flag goes off, the URL 404s (acceptable — the feature is off).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/_components/reminders-section.tsx` | Modify | Replace inline-dialog click handler with `router.push`. Add `useRouter` import. Leave `ReminderDetailDialog` unmounted (6B deletes). |

---

### 6B — Dead code cleanup

**Type:** Frontend
**Parallelizable:** No (blocks 6C — QA needs the final code shape).

**What:** Delete the `ReminderDetailDialog` inner component definition, `selectedReminder` state, any remaining imports (`useMutation(api.closer.followUpMutations.markReminderComplete)` if called only from the old dialog), and any prop types that referenced the dialog. Run `simplify` skill afterward to confirm nothing else is orphaned.

**Why:** Dead code rots fastest. Leaving `ReminderDetailDialog` in the tree invites future maintainers to wonder "is this still used? who calls it?" The schema knows it isn't used; the file should reflect that. Retaining the mutation export in `followUpMutations.ts` is deliberate (see design doc §9.3) — tooling and admin flows may still need it.

**Where:**
- `app/workspace/closer/_components/reminders-section.tsx` (modify)

**How:**

**Step 1: Identify every symbol to delete.** Search the file for:
- `ReminderDetailDialog` (the inner component function and its import/definition).
- `selectedReminder` (state variable, setter, any type alias).
- `markReminderComplete` import (if it was imported inside this file, which it likely was for the dialog's completion action).
- Any `useMutation(api.closer.followUpMutations.markReminderComplete)` call.
- Any `DialogContent` / `DialogHeader` imports that were only used by the inner dialog.

```bash
# Inside the file — rough audit commands to run mentally:
# grep -n "ReminderDetailDialog" app/workspace/closer/_components/reminders-section.tsx
# grep -n "selectedReminder"    app/workspace/closer/_components/reminders-section.tsx
# grep -n "markReminderComplete" app/workspace/closer/_components/reminders-section.tsx
```

**Step 2: Delete everything. After deletion, the file should contain only the list section (query → map → `ReminderListItem`) and its skeleton / empty states.**

```tsx
// Path: app/workspace/closer/_components/reminders-section.tsx
// AFTER — post-cleanup shape (abridged skeleton)
"use client";

import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { BellIcon } from "lucide-react";
import { ReminderListItem } from "./reminder-list-item"; // extracted helper
import { getReminderUrgency } from "./reminder-urgency"; // 4D extraction, if done

// (Removed: ReminderDetailDialog definition)
// (Removed: const [selectedReminder, setSelectedReminder] = useState(null))
// (Removed: useMutation(api.closer.followUpMutations.markReminderComplete))

export function RemindersSection() {
  const router = useRouter();
  const reminders = useQuery(api.closer.followUpQueries.getActiveReminders);

  if (reminders === undefined) return <RemindersSectionSkeleton />;
  if (reminders.length === 0) return <RemindersEmpty />;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Active Reminders</CardTitle>
        <CardDescription>Click a reminder to place the call or text.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {reminders.map((reminder) => {
          const urgency = getReminderUrgency(reminder.reminderScheduledAt);
          return (
            <ReminderListItem
              key={reminder._id}
              reminder={reminder}
              urgency={urgency}
              onClick={() =>
                router.push(`/workspace/closer/reminders/${reminder._id}`)
              }
            />
          );
        })}
      </CardContent>
    </Card>
  );
}

// (Keep the local RemindersSectionSkeleton / RemindersEmpty helpers.)
```

> **Note:** The exact post-cleanup file shape depends on what was there before. Treat the above as the *target outline* — retain anything the dashboard needs (empty state, skeleton, card header) and remove only the dialog-related chunks.

**Step 3: Confirm `markReminderComplete` is still exported from `convex/closer/followUpMutations.ts` and is NOT deleted.** The design doc §9.3 is explicit: retain.

**Step 4: Invoke the `simplify` skill.** Let it crawl the file and flag any residual `selectedReminder`-adjacent code, unused imports, or unreachable branches.

**Step 5: `pnpm tsc --noEmit`.** Must be 0 errors. The previous step should have surfaced anything broken.

**Step 6: `pnpm lint`.** Unused-import rules (if configured) will catch orphaned imports that `simplify` didn't.

**Key implementation notes:**
- **Retain `markReminderComplete` export.** Even though the dashboard no longer calls it, it remains a valid "legacy close" path for future admin tooling or ad-hoc cleanup scripts. Deleting the export would be a tempting cleanup but is out of scope here.
- **`getReminderUrgency` stays.** Both the dashboard card and the Phase 4 metadata card depend on it.
- **If the file shrinks under 50 lines, that is fine.** Do not invent scope.
- **Don't forget to remove `Dialog`, `DialogContent`, `DialogHeader`, `DialogTrigger` imports** if they were only used by the inline dialog. Keep them if the card continues to use any (skeleton pattern sometimes reaches for Dialog for mobile — it should not, but verify).
- **Git-diff the file carefully.** Especially if the inline dialog pulled in 80+ lines; a bad merge could remove the whole section accidentally.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/_components/reminders-section.tsx` | Modify | Delete `ReminderDetailDialog`, `selectedReminder` state, orphaned imports. Target shape: ~60–80 lines. |

---

### 6C — Browser QA gate (`expect` skill)

**Type:** Manual / Verification
**Parallelizable:** No — the phase's gate. All prior subphases must be complete.

**What:** Run the `expect` MCP tool suite to verify the end-to-end flow in a real browser. Seed the tenant with at least three `manual_reminder` follow-ups across urgency states. Click through the full journey three times (one for each outcome). Capture accessibility + performance + network + console evidence.

**Why:** AGENTS.md §Testing with Expect is explicit: **no completion claims without browser evidence**. Delegate to a subagent so the main thread stays free for any follow-up fixes.

**Where:**
- No file changes. This is a verification step using the `expect` MCP tooling.

**How:**

**Step 1: Seed realistic test data.** The `expect` skill's rules require ≥3 real records. Inside the Convex dashboard (or via a `scripts/seed-reminders.ts` helper if one exists), create:

```
Reminder A: scheduledAt = now - 30 min  (overdue urgency)
Reminder B: scheduledAt = now + 15 min  (due_soon urgency)
Reminder C: scheduledAt = now + 4 hours (upcoming urgency)
```

All three must:
- Be `type: "manual_reminder"`, `status: "pending"`.
- Belong to the test-tenant's closer account.
- Have parent opportunities in `follow_up_scheduled` status.
- Have leads with valid phone numbers (for the `tel:` / `sms:` button tests).

**Step 2: Launch the `expect` agent with a focused prompt.** Use the `Agent` tool (not Skill) so the subagent handles browser control in isolation.

```
Task: Verify the reminder-outcomes feature end-to-end using the expect MCP tools.

Feature summary: A closer dashboard at /workspace/closer shows a RemindersSection
card with pending manual_reminder follow-ups. Clicking a reminder now navigates
to /workspace/closer/reminders/[followUpId] (the new page we just built). On
that page, a closer can log a payment, mark the opportunity lost, or mark the
reminder as "no response" with three sub-choices.

What to verify:

1. Open /workspace/closer signed in as a closer. Confirm at least 3 reminders
   render. Click the first one. Assert the URL changes to
   /workspace/closer/reminders/<id> and the detail page renders with the lead's
   name in the page title (window.title / document.title).

2. On the detail page:
   - Assert the Contact card shows tel: and sms: buttons.
   - Assert the Metadata card shows the scheduled time and urgency badge.
   - Assert the History panel renders (either "No prior meetings" or a meeting row).
   - Assert the Action bar shows three buttons: "Log Payment", "Mark as Lost",
     "No Response".

3. Run the Log Payment flow: click "Log Payment", fill amount=100, currency=USD,
   provider="Stripe", no proof. Submit. Assert the dialog closes, a success toast
   appears, and the browser navigates back to /workspace/closer. Confirm the
   first reminder is no longer in the list (reactivity).

4. Click the second reminder. Run the Mark as Lost flow with reason="competitor".
   Assert toast "Opportunity marked lost", navigation back, reminder removed.

5. Click the third reminder. Run the No Response flow with nextStep="schedule_new",
   newContactMethod="text", newReminderAt = 2 days from now. Assert toast
   "New reminder scheduled", navigation back, the completed reminder is gone AND
   a new reminder appears (may take a reactive tick).

6. Responsive testing — repeat the step 1→6 flow at 4 viewports:
   - Mobile:   375×667  (iPhone SE)
   - Tablet:   768×1024 (iPad)
   - Desktop:  1280×720
   - Wide:     1920×1080
   Verify the tel/sms buttons stay ≥44×44 CSS pixels on all viewports.

7. Accessibility audit via axe-core. Report any critical or serious violations.
   Specific checks:
   - Radio group in the No Response dialog has proper labelling.
   - Focus order inside dialogs starts on the first interactive element and
     loops correctly.
   - Contrast ratio on the urgency badge is ≥4.5:1.
   - tel: / sms: buttons have aria-label that includes the lead name.

8. Performance metrics for the detail page (cold nav from dashboard):
   - LCP < 2500ms.
   - INP < 200ms for button clicks.
   - No long animation frames > 100ms during navigation.

9. Console + network audit:
   - No console.error during the full flow.
   - No 4xx/5xx network responses except the expected 401 for explicitly
     unauthorized routes (none in this flow).

10. Direct-URL tests:
    - /workspace/closer/reminders/invalid-id  -> "Reminder Not Found" empty state.
    - /workspace/closer/reminders/<another-closer's-id> -> "Reminder Not Found".

Return a concise report: pass/fail per numbered check, screenshots of the detail
page at mobile + desktop, and any a11y violations found. Do not modify code —
only report.
```

**Step 3: Read the agent's report.** Fix anything that failed. Common likely issues:

| Issue | Fix |
|---|---|
| `tel:` button missing `aria-label` | Phase 4C component — add. |
| No `role="status"` on `loading.tsx` | Phase 4A — already present; verify. |
| Radio group lacks fieldset/legend | Phase 5D — wrap in `<fieldset>`. |
| INP > 200ms on dialog open | Check `dynamic()` chunk size. |

**Step 4: Re-run the QA agent after fixes if any were needed.** Repeat until all checks pass.

**Step 5: Document the pass** with screenshots attached to the PR description or internal tracking tool. The `expect` skill captures these automatically.

**Step 6: Declare the feature shipped.** At this point:
- The design doc is implemented.
- The UI is verified.
- Accessibility + performance gates are clean.
- PostHog events flow.

**Key implementation notes:**
- **Do not run `expect` from the main thread.** AGENTS.md is explicit: delegate to a subagent so the main thread is free to edit code if fixes are needed.
- **Data seeding is non-negotiable.** An empty dashboard is not a valid QA result. If the dev environment has zero reminders, create some via the Convex dashboard function runner by calling `api.closer.followUpMutations.createManualReminderFollowUpPublic`.
- **Screenshots are the evidence.** PostHog event counts are corroborating; a passing `expect` run without screenshots attached to the PR is not considered complete.
- **PostHog verification.** Open the PostHog live-events view during the verification run and confirm all four expected events (`reminder_page_opened` + one outcome) fire per flow.
- **`pnpm tsc --noEmit` one last time.** After any fixes in Step 3, re-run to confirm the final state compiles.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| — | Verify | Browser-based QA via `expect` skill. Screenshots + reports. |
| *(any hotfix files)* | Modify | Depends on what the QA agent flags. Expect small tweaks, not structural changes. |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/closer/_components/reminders-section.tsx` | Modify | 6A |
| `app/workspace/closer/_components/reminders-section.tsx` | Modify | 6B (same file, second pass) |
| — | Verify (browser QA) | 6C |
| *(any hotfix files from 6C)* | Modify | 6C |
