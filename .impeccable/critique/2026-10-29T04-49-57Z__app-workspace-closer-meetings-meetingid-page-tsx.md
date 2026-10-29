---
target: meeting-detail
total_score: 18
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 3
target_identity: "file:/Users/nimbus/.t3/worktrees/ptdom-crm/t3-fac7d69c/app/workspace/closer/meetings/[meetingId]/page.tsx"
target_fingerprint: "sha256:c4f930b79119c46fc333bd7a1f1c1360b5b9c8d64bf7cffee298f697ae66c2a1"
target_path: /Users/nimbus/.t3/worktrees/ptdom-crm/t3-fac7d69c/app/workspace/closer/meetings/[meetingId]/page.tsx
timestamp: 2026-10-29T04-49-57Z
slug: app-workspace-closer-meetings-meetingid-page-tsx
---
# Assessment A: Closer meeting detail

Paths are relative to `app/workspace/closer/meetings/`. Screenshots are the inventory captures.

## 1. Design-specificity verdict
The content is specific to this product: DM credit, touches, Fathom, no-show reasons, reschedule links. The composition is generic: identical cards in a 3-column grid and an outline button row. The page reads as a record with actions attached, not a tool for recording what happened on a call.

## 2. Nielsen heuristics
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of status | 2 | A call 18 days old with no outcome shows only a 10px "Not recorded" pill. A pending follow-up is never shown. |
| 2 | Real-world match | 2 | The UI says "opportunity". Deal stage ("Booked") and attendance appear as two unlabeled badges. |
| 3 | User control | 1 | No undo for payment, lost or no-show. A half-finished follow-up leaves no actions. |
| 4 | Consistency | 2 | Join Meeting appears twice. No-show labels differ between the dialog and the bar. |
| 5 | Error prevention | 2 | Lost and no-show confirm. Payment has no review step and no default program. |
| 6 | Recognition | 3 | The payment dialog omits the lead name and the booked program. |
| 7 | Flexibility | 1 | No keyboard path or remembered defaults. |
| 8 | Minimalist design | 2 | The attribution block dominates column 1. |
| 9 | Error recovery | 2 | If follow-up "Done" fails, the dialog closes with "Contact support". |
| 10 | Help | 1 | Nothing says what each outcome does to the deal. |
| | **Total** | **18/40** | Poor |

## 3. Cognitive load
The page fails 5 of 8 checks, which is high: single focus, visual hierarchy, minimal choices, progressive disclosure, and working memory.

Decision points with more than 4 options:
- **Header row:** up to 5 equal-weight buttons, not grouped by consequence (`outcome-action-bar.tsx`).
- **Payment dialog:** 5 fields, 6 currencies and 4 payment types (`payment-form-dialog.tsx`).

## 4. Emotional journey
Before the call, attribution crowds out prep. The high-stakes moments are flat: a won deal earns a toast and a pale outline "Deal Won" button. A no-show gets the same red destructive styling as a loss, and the dialog never says the deal closes as lost. The low point is the follow-up flow: close it before pressing Done and every action vanishes without explanation.

## 5. Strengths
- Lost and no-show use AlertDialogs with reasons. The lost dialog also blocks closing while it submits (`mark-lost-dialog.tsx`).
- No-show recovery has its own bar with one-click reschedule (`no-show-action-bar.tsx`).
- Outcomes unlock only from 5 minutes before the start (`hooks/use-outcome-eligibility.ts`).

## 6. Priority issues
**[P0] An abandoned follow-up leaves the deal with no actions**
- **What:** generating a link inserts a pending follow-up, but the deal only moves on Done (`follow-up-dialog.tsx`). Closing with Esc sets `hasActiveFollowUp`, which hides every outcome (`outcome-action-bar.tsx`), while the badge still says "Booked".
- **Why:** the deal ends up in a state the closer can't see or fix.
- **Fix:** move the deal stage when the link is created, or treat closing as Done. Show the active follow-up.
- **Command:** `harden`

**[P1] No "outcome due" signal**
- **What:** the only sign of a past call with no outcome is a 10px badge (`meeting-overview-card.tsx`; light 1440).
- **Why:** forgotten outcomes corrupt pipeline and revenue reporting.
- **Fix:** show a prominent "Record outcome" band while `not_recorded`.
- **Command:** `layout`

**[P1] Flat outcome row with the destructive action loudest**
- **What:** Mark as Lost is the only filled, colored button, and Log Payment is plain outline.
- **Why:** misclicks are costly, and the visual weight steers toward losing.
- **Fix:** sequence the choice as "Did they show?" then won, follow-up or lost, and give the win the primary weight.
- **Command:** `distill`

**[P1] Dialogs hide their consequences**
- **What:** the no-show dialog never mentions that the deal closes as lost. The payment dialog has no review step, no lead name, and leaves Program empty even though the booked program is known.
- **Why:** a wrong amount or program goes straight into revenue.
- **Fix:** name the lead and the consequence, default the program, and add a summary confirm.
- **Command:** `clarify`

**[P2] Attribution outranks call prep**
- **What:** credit rows and touches sit above notes and booking answers.
- **Why:** a closer about to dial needs prep, not the credit trail.
- **Fix:** collapse attribution and move prep up.
- **Command:** `layout`

## 7. Persona red flags
- **Riley:** hits the P0. Pressing Esc mid-submit in the no-show dialog closes and resets it (`onOpenChange` isn't guarded).
- **Casey:** at 390px the actions wrap at the top and aren't sticky, so they're unreachable from the comments (light 390).
- **Alex:** no shortcuts, re-enters currency and program every time, and in the admin view the actions are at the very bottom (owner 1440).

## 8. Minor observations
- The lead name and Join Meeting each appear twice.
- No-show reason copy uses "--" in one place and "—" in another.
- The dark-mode email link and avatar have low contrast (dark 1440).
- The Fathom Save button looks enabled when the field is empty.
- Labels use uppercase 10px micro text.
- The admin view has no name heading, no Notes card, and an inline Deal Won card where the closer view uses a modal.

## 9. Provocative questions
1. Should the page start from one question, "Did they show?", instead of four peer buttons?
2. Does a closer need attribution on a call screen at all?
3. How does a closer fix an outcome they logged by mistake today?


## Detector and browser evidence (Assessment B)

CLI detector: 0 findings (exit 0).
Browser: Mark as Lost contrast 3.97:1; mobile email needs 337px in 246px; closer email needs 188px in 113px; breadcrumb links 20px high; Enter: sends control 16px high. P0 follow-up dead-end verified in source (follow-up-dialog.tsx:221-222, outcome-action-bar.tsx:73-79).
