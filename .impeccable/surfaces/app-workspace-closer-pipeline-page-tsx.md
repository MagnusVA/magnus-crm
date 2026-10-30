---
version: 1
slug: "app-workspace-closer-pipeline-page-tsx"
primary_target: "app/workspace/closer/pipeline/page.tsx"
related_targets: []
---

# Closer My Pipeline (`/workspace/closer/pipeline`)

Mode: Operate. Fourth surface in the world locked on Closer Today (`.impeccable/surfaces/app-workspace-closer-page-tsx.md`); recipes and tokens in `DESIGN.md`. Replaces the old stage-tab table, which opened on "Day" and was usually empty.

## Scope
Audience: a closer between calls, or at the start and end of the day, looking past today: how the month is going and where every open deal stands. Today owns calls, outcomes owed and tasks; this page never repeats them. Motivation is money and the book of deals equally, and a lookup of every deal must stay (user decisions, 2026-10-29). Constraints: money only from recorded payments (deals carry no price before a payment); business-day months (tenant time zone); `CONTEXT.md` vocabulary (deal, deal stage, program, person, task); bounded, indexed Convex reads; no commission, targets or quotas (no data); closers only.

Approved sketch: `.impeccable/mocks/decision/pipeline-programs.html` (render: `.impeccable/review/pipeline-programs.png`). Decision payload: `.impeccable/mocks/decision/pipeline-payload.json`.

## Direction contract
THESIS: A closer's book is read the way the floor talks, by program: what each program paid this month and which of its deals are still open. Refuses the stage-tab table of every deal ever, opening on an empty day.
OWN-WORLD: Same as Closer Today: navy strip, paper ground, white ruled cards, lime only for the next action and the month's cash figure, Barlow and Barlow Condensed with tabular figures, stage words in the stage inks, amber reserved for an open deal with no next step.
STORY: The closer reads the month's cash against last month, scans each program's open deals for one with no next step, opens it, and finds any past deal in the lookup below.
FIRST VIEWPORT: Navy sidebar, white top bar. Title "My Pipeline" with the month and business-day line and a month switcher. Navy money strip: cash collected this month (lime figure) with the change against this time last month and the payment count; won of decided; open deals with how many have no next step; the programs sold. Then one ruled card per program, two up at desktop: the program's cash and wins this month in its header, its open deals (person, stage word, next step) as rows, a footer "N open · N closed" with "All {program} deals". Below: All deals, the lookup card with All / Open / Won / Lost tabs (counts), a program filter, a person search and the table.
FORM: Desk by program (dealt lead, user's lock); seed:0d33ad67a2131e3e.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, a DESIGN.md update for any new recipe, and every shipping raster carrying its provenance

## Data rules (settled with the user, 2026-10-29)
- Cash: the closer's payments (attributed closer) recorded in the business month, excluding disputed payments and deposits, as Today's Performance counts them; the change compares against the previous month cut to the same elapsed length.
- Currencies: totals are never added across currencies. The headline shows the main currency: the one with the most payments this month (amounts are never compared across currencies), then last month's main currency, then USD; other currencies are listed beside it by payment count, each with its own sum (changed at the finish review, 2026-10-29: comparing raw amounts let HNL outrank USD). Program headers do the same.
- A deal's program: the program sold (`soldProgramId`), else the program first booked (`firstBookingProgramId`); deals with neither group under "No program".
- Next step: the deal's next scheduled call (`nextMeetingAt`), else its open task (call back, text back, or scheduling link waiting), else "No next step" in amber.
- Program order: by this month's cash, highest first; programs with open deals but no cash this month after them; programs with neither are left out of the sections (their deals stay in the lookup).

## States to design in the build
- One program: a single full-width section. No open deals in a program: one quiet line in its card. A new closer: no deals yet, said plainly with what fills the page.
- Lookup: empty search or filter result, loading, partial results (bounded read) said plainly.
- A month with no payments: "$0" is honest, with the payment count "No payments yet".
- Past month selected: the strip and program headers read that month; open deals still show their current state.
