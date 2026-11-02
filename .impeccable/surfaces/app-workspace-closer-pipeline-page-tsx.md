---
version: 1
slug: "app-workspace-closer-pipeline-page-tsx"
primary_target: "app/workspace/closer/pipeline/page.tsx"
related_targets: []
---

# Closer My Pipeline (`/workspace/closer/pipeline`)

Mode: Operate. A surface in the world locked on Closer Today (`.impeccable/surfaces/app-workspace-closer-page-tsx.md`); recipes and tokens in `DESIGN.md`. Second design (2026-11-01) replaces the program-card desk (commit 56ce0ae), which on a real closer showed 300+ open deals, 298 of them Booked with a call that passed months ago and no outcome, as identical amber rows in six cards.

## Scope
Audience: a closer between calls, or at the start and end of the day, looking past today: how the month is going, where every open deal stands, and what is stuck. Today owns calls, outcomes owed (its 30 newest) and tasks; this page owns the whole book, including the old unrecorded calls Today never reaches. User decisions (2026-11-01): clearing the unrecorded backlog is this page's job; open deals are one list by what's next, program a column and a filter; All deals stays, secondary and collapsed; the page must be informational with actions one step away. Constraints: money only from recorded payments; business-day months; `CONTEXT.md` vocabulary; bounded, indexed Convex reads; no commission, targets or quotas; closers only; no new write paths (actions reuse the meeting page, `SetNextStepButton` and the deal modal).

Approved sketch: `.impeccable/mocks/decision/pipeline-v3-book-panel.html`. Decision payload: `.impeccable/mocks/decision/pipeline-v3-payload.json` (round 2; round 1 `pipeline-v2-*` was re-rolled with the steer "more informational but still allow for further actions").

## Direction contract
THESIS: The book at a glance. One navy panel reads the whole book (where each open deal stands, how old the unrecorded backlog is, which programs carry it, the month's money), and one list below opens any deal in place to its calls, contact, credit and actions. Refuses a card per program of identical rows, and a page of buttons with nothing to read.
OWN-WORLD: Same as Closer Today: navy panel, paper ground, one white ruled card, Barlow and Barlow Condensed with tabular figures, stage words in the stage inks. Amber for open deals with no next step and calls never recorded (three amber strengths by age on the panel's bar); lime only for the month's cash figure and the one action in an opened row.
STORY: The closer reads the month's cash and wins, sees 298 of 316 deals have a call never recorded and how old they are, clicks that segment (or a program), and the list shows exactly those deals oldest first; they open a row, read the call, note and contact, and record the outcome or set a next step.
FIRST VIEWPORT: Title row "My Pipeline" with the business-day line and the month switcher. The navy book panel, three zones: the month (cash in lime with other currencies and the change line; won of decided), the open book (count, stage counts, one state bar Ahead · No next step · Not recorded under 30 days / 30–90 / over 90, each segment and legend item a filter), and a programs table (Program, Open, Not recorded, Won, Cash; a row is a filter). Under it the Open deals card: segmented All / Ahead / No next step / Not recorded with counts, a program select, columns Person, Deal, Last activity (date, NOT RECORDED flag, age bar), Next step, and a chevron; one row open in place. All deals collapsed below.
FORM: The book at a glance (dealt lead, round 2); seed:6769fa4e3617ce80. Signature interaction: every figure on the panel is a filter for the list, and a row opens in place (200ms height, the rest of the list stays put).
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Data rules
- Cash, wins, currencies and the main currency: as before (DESIGN.md, The Money Strip; The Separate Currencies Rule; The Main Currency Rule).
- A deal's program: sold, else first booked, else "No program".
- A deal's state, as of now: Ahead when it has a next step (a call ahead or an open task); else Not recorded when its last booked call passed with no outcome, aged by days since that call; else No next step.
- List order: Ahead by the step's time (overdue tasks first), then No next step, then Not recorded oldest call first. A state filter keeps that order; Not recorded is oldest first.
- Open deals read up to the bound in `getOpenDeals`; a partial read says so in words on the panel and the list.

## States to design in the build
- A new closer: no deals yet, said plainly. No open deals: the panel's book zone and list say so; the month still shows.
- A filter with no deals: one quiet line and Clear filter.
- An opened row loading: skeleton lines at the panel's height; a deal gone or reassigned: one quiet line.
- Past month selected: the month zone and the programs' Won and Cash read that month; open deals show their current state.
