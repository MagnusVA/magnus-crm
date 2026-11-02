---
version: 1
slug: "app-workspace-page-tsx"
primary_target: "app/workspace/page.tsx"
related_targets: []
---

# Overview (`/workspace`, the admin home)

Mode: Operate. Seventh surface in the world locked on Closer Today; recipes and tokens in `DESIGN.md`. Replaces the old dashboard header (green accent bar, ISO date), three shadcn ranking cards with icon tiles and help tooltips, and two tables that scroll sideways.

## Scope
Audience: owners and admins (closers and lead generators are redirected to their own homes). They open it to see who produced what today, this week or this month, and which posts bring people in.
User decisions (2026-11-01): same content, new design (no new headline figures, no attention line); the date picker designed here is the shared one and goes onto the Operations pages at once (they adopt it through `DashboardDateRangeFilter`); Top Posts & Reels stays on Overview with link previews (caption, author, handle, date, thumbnail) fetched unofficially from Instagram and stored, falling back to the readable URL; structure "Leaders first" (`.impeccable/mocks/decision/overview-leaders.html`).
Untouched: every number and its definition, the ranking rules, what Show all loads, the ClickHouse/live split, admin-only access.

## Direction contract
THESIS: A floor report that names who is ahead: each ranking leads with its first-placed person at full size, the rest as ruled rows under them, so the owner reads the winners in one pass. Refuses the dashboard of equal icon-tiled cards, help-tooltip headers and sideways-scrolling tables.
OWN-WORLD: Same as Closer Today: navy band (PageBand), paper ground, white ruled cards with 44px title rows, Barlow and Barlow Condensed with tabular figures, slate meta lines. No lime on the paper (the page has no next action); lime appears only as the Live dot and the active preset's fill is board text on navy. Amber and red only for section problems (partial, capped, error).
STORY: The owner lands on Today, sees the range and that it is live, reads the three leaders and their rates, switches to This week, scans phone closers' show rates and the posts that pulled people in, and opens Show all on a ranking.
FIRST VIEWPORT: Navy sidebar, white top bar. PageBand "Overview" with a 13px board-muted line ("This week · Mon Oct 27 – Sat Nov 1 · ● Live · Days run 1:00 am to 1:00 am, America/Tegucigalpa time"); right of the title the shared picker: a 34px segmented TODAY · THIS WEEK · THIS MONTH (condensed uppercase, board-raised track, the active segment board text on navy ink) and an outline Custom range button that names the range when chosen. Under it three equal ranking cards (Lead Gen, Top Qualifiers, Top DM Closers): 44px title row with the unit as meta ("Submissions per scheduled hour"); the leader block (40px avatar, 16px name, 13px "42 submissions · 6 h scheduled", the rate at 32px condensed with "/h"); ranks 2–5 as ruled rows (rank numeral, name, slate meta, 17px rate); a person without a schedule reads "No schedule", never "--"; footer "Total submissions 186" and Show all. Below: Phone closers table (booked, held, no-show, review, show rate with "N of M past calls have a result", no-show rate, a Total row) beside Top posts & reels (44px thumbnail, caption, "@handle · Reel · Oct 21", submissions figure and "31 people").
FORM: Leaders first, position 7 of my ordered list, dealt lead. seed:991e997eae56cfb5
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Data rules
- Overview data: `api.dashboard.overview.getOverviewDashboard` through `useAnalyticsReport` (live today, ClickHouse for earlier days, merged); Show all: `api.dashboard.overviewLeaderboards.listOverviewLeaderboardRows`. Sections carry `status` ready / empty / rebuilding / capped / error, and `truncated` (Slack cap) on qualifiers.
- Range words come from `overview.range.startBusinessDate` / `endBusinessDateInclusive` (business days, year only outside this year).
- Post previews: `leadGenOriginPreviews` via the admin-only `listOriginPreviews` query (built in parallel); rows without a ready preview show the readable URL with a kind word.
- Rates per scheduled hour; null rate means no schedule. Show rates "—" when nothing was held or missed.

## States
- Each section owns its state inside its card: loading (skeleton at real heights), empty ("No submissions today."), rebuilding the business day, capped (narrow the range), error, partial (Qualifiers' Slack cap, said in words in the card).
- Leader block only when rank 1 has a rate above zero; otherwise plain rows.
- A ClickHouse range loading, queued, delayed or failed: the freshness alert under the band; the band line keeps the range words.
- Range change keeps previous data dimmed (Kept Data While Reloading).
- Phones: one column; ranking cards stack; the phone closers table folds to two-line rows; posts stay rows.
