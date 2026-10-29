---
version: 1
slug: "app-workspace-closer-page-tsx"
primary_target: "app/workspace/closer/page.tsx"
related_targets: []
---

# Closer Today (`/workspace/closer`)

Mode: Operate. First flagship of the whole-app redesign; its world becomes the app's visual language.

## Scope
Audience: closers at a desk beside a live video call. Task: see the next call and join it, record outcomes still owed, work today's tasks, glance at the week's performance. Constraints: business-day time (tenant time zone), honest metric definitions, `CONTEXT.md` vocabulary (deal, task, deal stage), WCAG 2.2 AA.

Approved sketch: `.impeccable/mocks/hybrid-today.html` (render: `.impeccable/review/hybrid-today.png`). Decision round: `.impeccable/mocks/decision/`.

## Direction contract
THESIS: The closer's day is a departures board inside a calm, standard CRM. Refuses the category default of equal-weight KPI cards and a month calendar leading the page.
OWN-WORLD: Navy shell `#141A28`, cool paper ground `#F5F6F8`, white cards with 1px rules, lime `#84B135` only for the next action and primary buttons, navy-ink `#1F2E0A` for text on lime. Barlow for text, Barlow Condensed for times, status words and figures, tabular numerals. Stage scale: booked blue, held slate, follow-up teal, won lime, lost red.
STORY: The closer sees what's boarding, records what's owed, clears today's tasks, then checks the week.
FIRST VIEWPORT: Navy sidebar; white top bar with search. Left: the navy "Today's calls" board (TIME / PERSON / PROGRAM / GATE / STATUS, 44px rows), the next call a lime BOARDING row with Join and countdown; under it the Performance card (four figures with their basis, deal-stage bar). Right column: Needs outcome, then Tasks in two-line rows grouped Overdue / Today / Waiting on the lead.
FORM: Departure Board (rank 1 of 7) fused with the category standard at the user's steer; seed:2568c6848067786c.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Settled
- Performance figures come from `getPipelineSummary` (`convex/closer/dashboard.ts`): stage counts, `total` (the "of N deals" caption), `decided` (close rate), cash and payment count. Show-up rate needs a held-meeting count added to that query (it already reads the range's meetings); "vs last week" is a second call of the same query for the previous range.
- Nothing goes below Performance; the screen is complete as sketched.
