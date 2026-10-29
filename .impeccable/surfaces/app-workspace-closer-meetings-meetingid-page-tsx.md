---
version: 1
slug: "app-workspace-closer-meetings-meetingid-page-tsx"
primary_target: "app/workspace/closer/meetings/[meetingId]/page.tsx"
related_targets: ["app/workspace/pipeline/meetings/[meetingId]/page.tsx"]
---

# Closer meeting detail (`/workspace/closer/meetings/[meetingId]`)

Mode: Operate. Second flagship; inherits the world locked on Closer Today (`.impeccable/surfaces/app-workspace-closer-page-tsx.md`). The admin twin `/workspace/pipeline/meetings/[meetingId]` follows the same composition with admin actions.

## Scope
Audience: the closer right before, during or after a call. Task: join, prepare, then record the outcome; owners and admins correct outcomes on the admin twin. Constraints: outcome writes carry side effects (`docs/agents/convex.md`); outcome eligibility rules (`hooks/use-outcome-eligibility.ts`); pending follow-up handling from PR #214; `CONTEXT.md` vocabulary (meeting attendance vs deal stage vs outcome).

Approved sketch: `.impeccable/mocks/meeting-detail.html` (render: `.impeccable/review/meeting-detail.png`), after-call state.

## Direction contract
THESIS: A call page is a question to answer, not a record to read. Refuses the equal-weight card grid with a row of peer action buttons.
OWN-WORLD: Same as Closer Today: navy shell and board, paper ground, white ruled cards, lime only for the next action, Barlow and Barlow Condensed with tabular figures, the stage colour scale.
STORY: The closer sees the call's status, answers "did they show up?", then won, follow-up or lost, with each consequence stated first; prep sits under the question and credit is one line.
FIRST VIEWPORT: Navy strip as one board row (TIME, PERSON, PROGRAM, GATE, STATUS). Left: the lime-bordered outcome panel (Showed up / No-show, then Won · log payment, Follow-up, Lost), Prep (booking answers, DM notes), Comments. Right: Deal card (stage track, credit line, Open deal), person card with copyable contacts and earlier meetings, Fathom link.
FORM: Departure Board fused with the category standard (rank 1 of 7); seed:2568c6848067786c.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## States to design in the build
- Before the call: strip shows BOARDING and Join; Prep leads; the outcome panel opens at the eligibility window.
- After recording: the panel collapses to a one-line summary with the outcome and a correction path.
- Pending follow-up: the unfinished-follow-up panel from PR #214 takes the outcome panel's place.
- No-show closed: reschedule-link actions replace the outcome panel.

## To verify before shipping
- No-show copy says the deal closes as lost; confirm against the no-show mutation.
- Copy never assumes the lead's pronouns.
