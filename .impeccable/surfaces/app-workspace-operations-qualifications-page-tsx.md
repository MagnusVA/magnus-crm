---
version: 1
slug: "app-workspace-operations-qualifications-page-tsx"
primary_target: "app/workspace/operations/qualifications/page.tsx"
related_targets: []
---

# Qualifications (`/workspace/operations/qualifications`, admin)

Mode: Operate. Inherits the Departures Board world (`DESIGN.md`); closest precedent is Overview (`.impeccable/surfaces/app-workspace-page-tsx.md`). Replaces the green-accent header with "Showing: Today", the recharts per-opener bar chart, the radial goal ring, the help-tooltip "Setter Contributions" table and the collapsible Submissions list that loaded one row at a time.

## Scope
Audience: owners and admins. They open it to see whether the team is on goal for the range, which setters produced the qualified leads, and what each lead became.
User decisions (2026-11-02): same content and data, new design; the goal leads; pressing a setter filters Submissions through the queue's existing `slackUserId` argument (one primary filter at a time, so choosing a setter clears the stage filter and the reverse); "setter" everywhere (CONTEXT.md names the role), not "opener"; round 1 (live board, tiles, goal beside ranking) and a straight restyle of the current layout were rejected as too far or not purposeful; round 2 chose "Split desk" (`.impeccable/mocks/decision/qual-split-desk.html`).
Untouched: every number and its definition, the live/ClickHouse/snapshot split, exports, schedules dialog, team goal dialog, admin-only access, Convex queries.

## Direction contract
THESIS: One desk: the goal in the band, then setters and their submissions as two panes of one card, so "are we on goal, who got us there, what did they bring" reads in one screen. Refuses the dashboard that shows the same per-setter numbers twice (chart and table) above a list that scrolls off the page.
OWN-WORLD: Departures Board: navy PageBand (title, range words, Live, business-day line, Schedules, Export, board-tone picker) with a goal row under a board-line hairline: TEAM GOAL label, 30px condensed "29 of 70", "41%", a 14px bar of setter segments in board text, "70 a day × 1 business day", Edit goal. White ruled card, 44px title rows, Barlow / Barlow Condensed tabular figures, stage words in stage ink. No lime on the paper; the Live dot is the only lime.
STORY: The admin sees 29 of 70 and the bar, reads the setters by count, presses Sarah, sees her 12 leads and their stages, opens one to see booking, closer and DM credit, then presses All setters and searches a handle.
FIRST VIEWPORT: Band as above. Below, the split card fills the rest of the screen: left 360px Setters pane (All setters with the total first, then each setter with avatar, name, count at 20px, a share bar, "1.7/h · 4:44 PM" or "No schedule"; scheduled setters with none fold into one line), selected row on muted fill with a 3px ink inset bar; right pane titled with the selection and "12 qualified · newest first", search and stage select, ruled rows QUALIFIED, LEAD (name over handle · platform), SETTER (only for All setters), PROGRAM, STAGE word, chevron; a row opens in place. Each pane scrolls on its own; "Show 25 more" footer.
FORM: Split desk, position 3 of my ordered list, dealt lead of re-roll 1. seed:21de348d22664b54
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

Signature interaction: selecting a setter (row button, `aria-pressed`) refills the right pane in place, keeping the old rows dimmed until the new ones arrive (Kept Data While Reloading); the goal bar's segment for that setter stays full while the others drop to 35%. Motion: 200ms opacity and the row-open `grid-template-rows` transition only; none under reduced motion.

## Data rules
- Dashboard: `getQualificationsDashboard` through `useAnalyticsReport` (live today, ClickHouse earlier days); ranges over 7 days on live source use the snapshot job (`useOperationsDashboardReport`), whose state shows under the band.
- Setter key = Slack user id; it is the queue's `slackUserId` filter. Queue pages return one row per page (bounded reads), so the pane asks for pages until 25 rows show or the range is exhausted.
- Per hour: one decimal with "/h"; null rate reads "No schedule". Share bar = qualified ÷ the top setter's qualified.

## States
- Loading: skeletons at real row heights in both panes; band keeps the range words.
- Quiet range (no qualified, no scheduled setters): one SectionEmpty line naming the range; goal row still shows 0 of N.
- No goal: the goal row reads "No goal set" with an outline Set goal button.
- Snapshot queued/running/failed and ClickHouse alerts: under the band, never inside it.
- Filtered pane empty: names the setter/stage/search and offers Clear filters.
- Narrow (< @4xl): panes stack, setters first as a compact list; the goal row wraps under the title.
