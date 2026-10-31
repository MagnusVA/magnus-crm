---
version: 1
slug: "app-workspace-leads-customers-leadid-page-tsx"
primary_target: "app/workspace/leads-customers/[leadId]/page.tsx"
related_targets: []
---

# Person page and deal modal (`/workspace/leads-customers/[leadId]`)

Mode: Operate. Fifth surface in the world locked on Closer Today (`.impeccable/surfaces/app-workspace-closer-page-tsx.md`); recipes and tokens in `DESIGN.md`. Replaces the old person page (three header metrics, Programs, Opportunities, Meetings, Portal Notes, Payments and Timeline cards, a six-card side rail) and the right-hand "Opportunity Detail" sheet.

## Scope
Audience: closers and admins on the same composition (user decision, 2026-10-31). Closers arrive from My Pipeline deal rows, the task page's "Open deal", the meeting page's "Person page" and "Open deal", and ⌘K search, mostly to see where each deal stands before a call and to act on a deal with no next step. Admins arrive from the operations lists and search, to check and fix a person's deals.
Actions (user decisions, 2026-10-31):
- Closer: reach the person (call, text, copy email) and set the next step on their own open deal (call back or booking link). Existing deal actions stay: side-deal payment, mark lost, delete empty side deal, additional payment on a won deal.
- Admin: the same page plus "fix the deal": mark lost, set the next step for the closer, cancel a pending task; and the existing lifecycle move-back, disposition, enrollment status, void side-deal payment.
- History lives on the page only: one person-wide timeline. The deal modal shows the deal's facts and actions, not an activity feed.
- The deal opens in a centred modal, not a side sheet; `?opportunityId=` deep links keep opening it.
Constraints: `CONTEXT.md` vocabulary (person, deal, stage, program, task; never "opportunity" in the UI); money only from recorded payments, never added across currencies; business-day dates; bounded indexed Convex reads; closers see every deal on the person but open only their own (summary rows for others).

Approved sketch: `.impeccable/mocks/decision/person-strip.html`, revised by the at-a-glance sketch `.impeccable/mocks/person-glance.html` (user approval, 2026-10-31: the first build felt hollow on thin people and scrolled too much). Decision payload: `.impeccable/mocks/decision/person-payload.json`.

## Direction contract
THESIS: The person as one board row, then each deal as its own card with its stage track and next step. Refuses the record page of equal-weight cards where calls, payments and deals only connect through a program name.
OWN-WORLD: Same as Closer Today: navy strip, paper ground, white ruled cards, lime only for the one next action, Barlow and Barlow Condensed with tabular figures, stage chips and tracks from the stage scale, amber for an open deal with no next step.
STORY: The visitor reads who the person is and where they stand in one strip, sees which deal needs a next step, sets it or opens the deal, and reads the history and booking answers when preparing.
FIRST VIEWPORT: Navy sidebar, white top bar. Navy strip: PERSON (name as h1, "Customer since Oct 25 · 3 deals"), STAGE (lifecycle word), PAID (per currency), NEXT STEP (status word: the soonest call or task, or amber "No next step" / "Not recorded" naming the deal), REACH BY (Call with the number, Text, Copy email). Main column: one card per open deal titled by program with its stage chip and closer, the stage track, the credit line, its last three calls as rows (a call with no result carries the lime Record outcome), and a footer with the next step and the deal's actions; then Closed deals as one-line rows; then Booking answers and Timeline side by side. Right column: one dense person card (contact, touches, stage, disposition, programs, notes). A person with one or two deals fits one 1440×900 screen.
FORM: Strip and deal cards (dealt structure, user's lock); seed:9ddef6cdf20b0897.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Data rules
- Next step per open deal: the next scheduled call, else the open task (call back, text back, link waiting), else a past call with no outcome ("Record outcome" on the meeting page), else "No next step" in amber. Same order as My Pipeline's next-step cell.
- The strip's NEXT STEP: "No next step" (amber, naming the deal) when any open deal the viewer can act on has none; else the soonest step across open deals; else nothing open ("No open deals").
- Paid: the person's payments per currency, main currency first (most payments), never summed across currencies.
- Credit and attribution show once, on the deal card and in the modal, not again in a person card.

## States to design in the build
- One deal; many deals (newest open first, then won, then lost); a lead with no deals (Slack qualified, captured by lead gen).
- A closer viewing another closer's deal: summary card, no actions, no modal.
- Lost and won deals stay listed, marked by their chip and track.
- Merged person redirects; missing person; loading skeleton at real heights; section errors in place.
- Phone width: the strip stacks; deal cards and rail become one column.

## Open decisions for the build
- Where portal notes, identifiers, custom fields beyond booking answers and the DM portal facts sit in the rail (one "Record" card or separate cards), and how the admin lifecycle controls appear.
