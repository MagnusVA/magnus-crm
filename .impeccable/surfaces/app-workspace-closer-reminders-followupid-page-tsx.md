---
version: 1
slug: "app-workspace-closer-reminders-followupid-page-tsx"
primary_target: "app/workspace/closer/reminders/[followUpId]/page.tsx"
related_targets: ["app/workspace/pipeline/reminders/[followUpId]/page.tsx"]
---

# Closer task detail (`/workspace/closer/reminders/[followUpId]`)

Mode: Operate. Third surface in the world locked on Closer Today (`.impeccable/surfaces/app-workspace-closer-page-tsx.md`); shares the meeting page's outcome grammar (`.impeccable/surfaces/app-workspace-closer-meetings-meetingid-page-tsx.md`). The admin twin `/workspace/pipeline/reminders/[followUpId]` uses the same task pane with no queue and payment only.

## Scope
Audience: the closer working their call-back and text-back tasks, usually several in one sitting, calling from this page (user decision, 2026-10-29). Task: read why the task exists, reach the person (call, text, copy the number), record what happened, move on to the next task. Constraints: the existing reminder outcome mutations only (`logReminderPayment`, `markReminderLost`, `markReminderNoResponse` with `schedule_new` / `close_only` / `give_up`), so no backend or report changes; `CONTEXT.md` vocabulary ("Task", never "Reminder" in the UI; deal, deal stage); outcome writes carry side effects (`docs/agents/convex.md`); copy never assumes the person's pronouns.

Approved sketch: `.impeccable/mocks/decision/task-queue.html` (render: `.impeccable/review/task-queue.png`). Decision round payload: `.impeccable/mocks/decision/task-payload.json`.

## Direction contract
THESIS: Tasks are worked as a queue, not opened one by one. Refuses the record page that strands the closer after one outcome and sends them back to Today for the next.
OWN-WORLD: Same as Closer Today: navy shell and board strip, paper ground, white ruled cards, lime only for the next action (Call on an open task, the chosen outcome), Barlow and Barlow Condensed with tabular figures, the stage colour scale; overdue in the danger ink as on Today's Tasks card.
STORY: The closer opens a task from Today, sees the note and the number, calls, answers "Did you reach {first name}?", picks the outcome, and the next task opens; when the queue is empty they land back on Today.
FIRST VIEWPORT: Navy sidebar, white top bar. Left 340px queue: the closer's tasks grouped Overdue, Today, Later, Waiting on the person (same rows and due labels as Today's Tasks card), the open task marked with a lime inset. Right pane: the navy strip as one board row (DUE / PERSON / DEAL / REACH BY / STATUS); under it on the left the task note card, the reach card (the number large in Barlow Condensed with lime Call, Text, Copy), the lime-bordered two-step outcome panel; on the right the Deal card (stage track, credit line, payments, Open deal) and Calls on this deal.
FORM: Queue and task (dealt structure, user's lock); seed:9a39e8c0293ab5e8.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Outcome flow (user decision, 2026-10-29)
Step 1 "Did you reach {first name}?": Yes, we talked / No answer. Nothing is written by step 1.
- Yes: Won · log payment (`logReminderPayment`, lime) or Lost (`markReminderLost`).
- No answer: Try again (new task: call or text, date, time, note; `markReminderNoResponse` `schedule_new`), Close this task only (`close_only`, the deal is untouched), Mark the deal lost (`give_up`).
Each choice states its consequence before it is confirmed.

## States to design in the build
- Open task, due later, due now, overdue (status word changes in place).
- Completed task: the outcome panel becomes a one-line summary of what was recorded; Call stays available but loses the lime.
- Deal finished elsewhere (won or lost, no-show included): a quiet line naming the deal's stage; no outcome actions.
- Stale-deal nudge (`stale_opportunity_nudge`): resolved from the deal, so the pane points to Open deal.
- Not found or not yours, loading, and an empty queue.
- Admin twin: no queue; "Acting for {closer}" line; only Won · log payment.

## Settled
- The route stays `/reminders/`; only the UI says Task. Breadcrumbs name it.
- The queue reuses `getCloserTasks` (Today's Tasks card), so it adds no new query. Scheduling-link rows open in the queue too (see Waiting-link tasks); stale-deal nudges open the deal.

## Waiting-link tasks (user decisions, 2026-10-29)
Approved sketch: `.impeccable/mocks/task-link.html` (render: `.impeccable/review/task-link.png`).
- A scheduling-link task (`type: "scheduling_link"`, "Waiting on the person") opens in the same queue and pane as a call-back task, never on the person page.
- Strip: SENT (when the link went out) / PERSON (and why: "Reschedule link · after the Oct 26 no-show") / DEAL / REACH BY ("Link · not booked yet") / STATUS ("Waiting", with how long and "no booking").
- Left column: the link card (the full URL, lime Copy link, one line on what happens when the person books through it), the reach card (number with Call, Text, Copy; none lime, the link is the next action), then "Not booking?" with two choices that state their consequence: Cancel the link (closes the task, the deal stays in Follow-up) and Mark the deal lost (closes the task and the deal as lost). Right column: Deal card and Calls on this deal, as for call-back tasks.
- Generating a scheduling link moves the deal to Follow-up at once; there is no confirm step and no "Mark follow-up scheduled". Only the Calendly booking moves it on (to Booked). No backfill for links stuck before this change (user decision, 2026-10-29: correct going forward); such a deal keeps the meeting page's fallback banner with Cancel the link.
