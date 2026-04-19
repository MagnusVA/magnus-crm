# Phase 6C — Browser QA Gate

> **Status:** _Pending — awaiting browser-run verification._
>
> This document freezes the acceptance criteria, test scenarios, and evidence
> targets that the `expect`-driven QA pass must satisfy before the
> `reminder-outcomes` feature can be declared shipped. The main-thread
> implementation passes both `pnpm tsc --noEmit` and `pnpm lint` (scoped to the
> feature's seven files). All that remains is the live-browser verification.

---

## 0. Environment pre-flight

Before kicking off the `expect` run, confirm:

- [ ] Dev server is up (`pnpm dev`) and hitting the same Convex deployment that
      contains the Phase 1–3 schema + mutations.
- [ ] The signed-in WorkOS user has the `closer` role in the tenant under test.
- [ ] PostHog live-events view is open in a side tab so events can be
      corroborated as they fire.
- [ ] No browser extensions are injecting DOM (they will break axe-core).

---

## 1. Data seeding

The `expect` skill's house rule is **"no verification without ≥3 real
records"**. Seed the test tenant with three `manual_reminder` follow-ups across
the urgency spectrum:

| Ref | `reminderScheduledAt`    | Expected urgency | Expected badge copy |
|-----|--------------------------|------------------|---------------------|
| A   | `now - 30 minutes`       | `red`            | "Overdue"           |
| B   | `now + 15 minutes`       | `amber`          | "Now"               |
| C   | `now + 4 hours`          | `normal`         | "Due"               |

Seeding path: `api.closer.followUpMutations.createManualReminderFollowUpPublic`
(via the Convex dashboard function runner).

All three reminders must satisfy:

- `type: "manual_reminder"`, `status: "pending"`.
- Parent opportunity in `follow_up_scheduled`.
- Lead has a valid `phone` (so the `tel:` / `sms:` buttons are testable).
- A fourth opportunity with status `payment_received` (or `lost` / `no_show`)
  and a pending reminder attached — exercises Branch 2 of the action bar
  (terminal-status lock-out).

---

## 2. Scenario matrix

The closer opens `/workspace/closer`, spots the Reminders card, clicks a row,
lands on the detail page, picks one of three outcomes, and returns to the
dashboard. Each scenario below corresponds to one click-through; they must all
pass.

### 2.1 Happy path — Log Payment

| Step | Assertion |
|------|-----------|
| Click reminder **A** on the dashboard | URL changes to `/workspace/closer/reminders/<id>`; `document.title` contains the lead name |
| Detail page renders | Contact card has `tel:` + `sms:` buttons; Metadata card shows the scheduled time + "Overdue" badge; History panel renders (either "No activity recorded yet" or at least one meeting/payment row) |
| Action bar shows 3 buttons | Labels: "Log Payment", "No Response", "Mark as Lost" |
| Click **Log Payment** | Dialog opens; focus lands on "Amount" input |
| Fill `amount=100`, `currency=USD`, `provider=Stripe`, no proof; Submit | Spinner shows; toast "Payment logged successfully"; dialog closes; navigates to `/workspace/closer` |
| Back on dashboard | Reminder A no longer appears in the list |
| PostHog | One `reminder_outcome_payment` event with `amount_minor=10000`, `currency=USD`, `provider=Stripe`, `has_reference_code=false`, `has_proof=false` |

### 2.2 Happy path — Mark as Lost

| Step | Assertion |
|------|-----------|
| Click reminder **B** | URL + title assertions (as above) |
| Click **Mark as Lost** | AlertDialog opens; focus trapped; ESC cancels |
| Fill `reason="chose competitor"`; Submit | Toast "Opportunity marked as lost"; dialog closes; navigates to `/workspace/closer` |
| Back on dashboard | Reminder B no longer appears |
| PostHog | One `reminder_outcome_lost` event with `has_reason=true` |

### 2.3 Happy path — No Response → Schedule new

| Step | Assertion |
|------|-----------|
| Click reminder **C** | URL + title assertions |
| Click **No Response** | Dialog opens; default radio is "Schedule new"; note textarea says "Note" (not "Reason") |
| Toggle `newContactMethod=text` | ToggleGroup selection moves to "Text" with icon |
| Fill `newReminderDate = tomorrow`, `newReminderTime = 10:00`, `newReminderNote = "Try again after demo"`; Submit | Toast "New reminder scheduled"; dialog closes; navigates to `/workspace/closer` |
| Back on dashboard | Reminder C removed; a **new** reminder for the same lead appears within a tick |
| PostHog | One `reminder_outcome_no_response` event with `next_step=schedule_new`, `new_contact_method=text`, `has_new_reminder_note=true` |

### 2.4 No Response → Give up

| Step | Assertion |
|------|-----------|
| Seed a fresh reminder **D** and open it | Detail page renders |
| Click **No Response**, select "Give up" | Note label changes to **"Reason"** |
| Submit with `note="ghosted after 3 attempts"` | Toast "Opportunity marked as lost"; reminder D removed |
| PostHog | `next_step=give_up`, `has_note=true` |

### 2.5 No Response → Close only

| Step | Assertion |
|------|-----------|
| Seed reminder **E** and open it | Detail page renders |
| Click **No Response**, select "Close only" | Opportunity stays in its current status |
| Submit with empty note | Toast "Reminder closed"; reminder E removed from list |
| PostHog | `next_step=close_only`, `has_note=false` |

### 2.6 No Response → future-time validation

| Step | Assertion |
|------|-----------|
| Open any reminder; click **No Response** | Dialog opens |
| With "Schedule new" selected, set date=today, time=10 minutes ago; Submit | Inline error under the time field: "Must be a future time" (or equivalent copy); mutation NOT called |

### 2.7 Branch 2 — Terminal opportunity

| Step | Assertion |
|------|-----------|
| Open the reminder attached to the `payment_received` opportunity | Action bar shows a single info Alert: "The underlying opportunity is already Payment Received. This reminder can no longer drive a status change — close it from the dashboard." |
| No outcome buttons render | Only the informational alert |

### 2.8 Branch 1 — Already completed

| Step | Assertion |
|------|-----------|
| In a second tab, complete a reminder via any outcome | Dialog confirms success |
| Switch back to the first tab, which was already on the same detail page | Convex reactivity swaps the action bar to "This reminder has already been completed." (no outcome buttons) |

### 2.9 Direct-URL tests

| URL | Expected |
|-----|----------|
| `/workspace/closer/reminders/invalid_id` | "Reminder Not Found" empty state; 200 response (no crash) |
| `/workspace/closer/reminders/<another-closer's-id>` | Same "Reminder Not Found" state — the query guard returns null |
| `/workspace/closer/reminders/<completed-id>` | Detail page renders with Branch 1 action bar |

---

## 3. Responsive matrix

Repeat scenario **2.1** at each viewport; all assertions must hold + the
extra tap-target rule:

| Viewport  | Dimensions | Tap-target rule |
|-----------|------------|-----------------|
| Mobile SE | 375×667    | `tel:` / `sms:` buttons measure ≥44×44 CSS px |
| iPad      | 768×1024   | Two-column layout collapses to one column under the breakpoint |
| Desktop   | 1280×720   | Two-column layout visible; left column ≈ 60% width |
| Wide      | 1920×1080  | No horizontal scroll; cards capped at readable width |

---

## 4. Accessibility audit (axe-core)

Run axe on each of: the dashboard, the detail page, and each of the three
dialogs (opened via keyboard). Zero critical or serious violations.

Specific spot-checks beyond axe's defaults:

- [ ] Radio group in `ReminderNoResponseDialog` has proper labelling — either
      a `<fieldset>`+`<legend>` or `role="radiogroup"` + `aria-labelledby`.
- [ ] Focus trap inside each dialog starts on the first interactive element.
- [ ] Closing the dialog via ESC or Cancel returns focus to the triggering
      button in the action bar.
- [ ] `tel:` / `sms:` buttons have `aria-label` that includes the lead name.
- [ ] Urgency badge's label is readable by SR (not color-only).
- [ ] Contrast: urgency badge text-on-background ≥ 4.5:1 in both light and
      dark modes.
- [ ] All interactive rows in the Reminders card reachable via Tab; Enter
      triggers navigation; Escape does nothing (no modal to close).

---

## 5. Performance

Cold navigation dashboard → detail page on desktop (1280×720), Fast 3G
throttling **off**:

| Metric | Budget |
|--------|--------|
| LCP    | < 2500 ms |
| INP    | < 200 ms on every button click |
| CLS    | < 0.1 over the full flow |
| Long animation frames | None > 100 ms during navigation |

`next/dynamic` should keep the three dialog bundles out of the initial route
chunk. Verify in the Network tab: the dialog JS only requests after the first
button click.

---

## 6. Console + network

- [ ] No `console.error` during any of the scenarios above.
- [ ] No `console.warn` that traces back to this feature's seven files.
- [ ] No 4xx / 5xx responses on the happy paths.
- [ ] Convex mutations return within p95 < 500ms on the happy paths.

---

## 7. PostHog event ledger

By the end of the full matrix above, PostHog should have captured the
following events (one per completed flow):

| Event | Expected count | Required properties |
|-------|----------------|---------------------|
| `reminder_outcome_payment`     | ≥ 1 | `follow_up_id`, `payment_id`, `amount_minor`, `currency`, `provider`, `has_reference_code`, `has_proof` |
| `reminder_outcome_lost`        | ≥ 1 | `follow_up_id`, `has_reason` |
| `reminder_outcome_no_response` | ≥ 3 | `follow_up_id`, `next_step` (one of `schedule_new` / `give_up` / `close_only`), `has_note`, `has_new_reminder_note`, `new_contact_method` |

No PII (no lead name, no email, no phone) appears in any event payload.

---

## 8. Static-verification passes (already complete)

These gates passed on the main implementation thread and do **not** need to be
re-run as part of 6C unless a fix lands first:

| Check | Result |
|-------|--------|
| `pnpm tsc --noEmit` (whole repo)                                              | ✅ EXIT=0 |
| `pnpm exec eslint` on the seven new/modified feature files                    | ✅ 0 errors, 0 warnings |
| Bundle chunk-splitting (three dialogs behind `next/dynamic`)                  | ✅ verified via the component source — each dialog module is loaded lazily |
| Telemetry schema sanity (snake_case properties, no PII, `captureException` on errors) | ✅ confirmed by grep across the four dialog files |

---

## 9. Files shipped in Phases 4–6

| Path | Phase | Type |
|------|-------|------|
| `app/workspace/closer/reminders/[followUpId]/page.tsx`                                             | 4A | New — RSC |
| `app/workspace/closer/reminders/[followUpId]/loading.tsx`                                          | 4C | New |
| `app/workspace/closer/reminders/[followUpId]/error.tsx`                                            | 4C | New |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-detail-page-client.tsx`          | 4B | New |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-contact-card.tsx`                | 4B | New |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-metadata-card.tsx`               | 4D | New |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-history-panel.tsx`               | 4E | New |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-outcome-action-bar.tsx`          | 5A | New |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-payment-dialog.tsx`              | 5B | New |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-mark-lost-dialog.tsx`            | 5C | New |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-no-response-dialog.tsx`          | 5D | New |
| `app/workspace/closer/_components/reminders-section.tsx`                                           | 6A–6B | Modified — dialog removed, `router.push` wired |

---

## 10. Running the gate

The phase plan calls for the main thread to delegate browser verification to a
subagent. When `expect` tooling is available, kick off the run with:

```
Agent tool → subagent: expect-runner
Prompt: see plans/reminder-outcomes/phases/phase6.md §6C Step 2 (verbatim).
```

On pass, attach the screenshots + axe report + PostHog event counts to the PR
description. On fail, read §6C Step 3 for the common failure → fix table and
re-run.

---

## 11. Ship criteria (definition of done)

The feature is declared shipped when **all** of the following are true:

1. Every checkbox in §1–§7 is ticked off in a browser session on the dev
   environment.
2. Screenshots of the detail page at mobile + desktop viewports are attached
   to the PR.
3. `pnpm tsc --noEmit` is still EXIT=0 after any hotfixes from §10.
4. PostHog shows the expected events for each of the three outcome paths.
5. A closer (not an engineer) has done one click-through on the staging
   environment and reported no surprises.
