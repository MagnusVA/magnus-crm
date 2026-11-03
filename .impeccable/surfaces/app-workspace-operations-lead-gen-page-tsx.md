---
version: 1
slug: "app-workspace-operations-lead-gen-page-tsx"
primary_target: "app/workspace/operations/lead-gen/page.tsx"
related_targets: []
---

# Lead Gen (`/workspace/operations/lead-gen`, Operations › Lead Gen)

Mode: Operate. Eighth surface in the Departures Board world; recipes and tokens in `DESIGN.md`. Replaces the old header (green accent bar, "Lead Gen Ops" title, lime Settings button), four icon-tiled summary cards with help tooltips, a free-floating source toggle with "Showing: …", and five shadcn table cards (two of them scrolling sideways).

## Scope
Audience: owners and admins (`lead-gen:view-all`). They open it to see what the lead gen team captured in a range, how far those people went, who produced it, which posts pulled them in, and to export or void a bad submission.
User decisions (2026-11-02): same content and data, new design; structure "Funnel first" (`.impeccable/mocks/decision/leadgen-funnel.html`); raw submissions must stay on the page but folded at the foot, with no prominence. Browser verification deferred by the user; captures come later.
Untouched: every query and ClickHouse report, the snapshot-job path for long ranges, the export menu's formats, the void mutation and its dialog's consequence text, admin-only access, the URL range sync.
Sibling threads redesign Qualifications, Booked Calls and Sales Calls in parallel; this page keeps the Overview skeleton (band with range words, freshness and picker; sections as DetailCards) so the four read as one family.

## Direction contract
THESIS: The page leads with where the captured people went: a conversion strip from Prospects to Customer with each step's share of prospects, then who captured them and which posts pulled them in. Refuses four equal icon-tiled KPI cards, tooltip-headed tables and sideways scrolling.
OWN-WORLD: Navy PageBand holding the totals zone (book panel grammar: 11px condensed labels, 30px condensed figures, 13px lines, board-line rules) and a source tab row (directory-band tabs, lime underline on the active source) with Export and Settings as board buttons. Paper ground, white ruled DetailCards, Barlow and Barlow Condensed tabular figures. No lime on the paper; lime only as the Live dot and the active source underline.
STORY: The owner lands on Today, reads the totals and the range, sees how many prospects moved to conversation, qualified, booked, showed and became customers, scans specialists by team with their per-hour rate and a small funnel bar each, checks the top posts per team, switches source or range, exports, and on a bad capture opens Raw submissions at the foot to void it.
FIRST VIEWPORT: Navy sidebar, white top bar "Operations › Lead Gen". PageBand: "Lead Gen", a 13px line "This week · Oct 27 – Nov 1 · ● Today live · earlier days as of 2:31 PM · Days run …", the board-tone picker right; under a board-line rule four totals (Submissions, Specialists active, Scheduled hours, Per scheduled hour) in 30px condensed; under another rule ALL SOURCES · INSTAGRAM · META BUSINESS tabs left, Export and Settings & schedules right. Then a white "Prospect conversion" strip: six stage cells (label, 30px figure, "40% of prospects", a 6px share bar) and a paper Deals cell; "By specialist" opens the full per-specialist table in place. Under it Specialists by team (team label rows with subtotals, person rows with avatar, "36 h scheduled" meta, submissions, per hour, a prospects → qualified → customer bar, a Total row) beside a 384px Top posts & reels card with team tabs and thumbnail rows.
FORM: Funnel first, position 5 of my ordered list, dealt. seed:b9cd5d93661f15bd
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Data rules
- Overview, workers, origins by team, conversions and resparks through `useAnalyticsReport` (live today, ClickHouse earlier, merged) exactly as before; long live ranges go through the operations snapshot job (`useOperationsDashboardReport`), whose status alert sits under the band.
- Conversion counts all sources and people first captured in the range; Raw leads follow the source filter, resparks cover all sources. Say these scopes in card meta, never in tooltips.
- Specialist rows join conversion rows by `workerId` for the per-row funnel bar only; the full conversion figures stay in the conversion card's By specialist table.
- Range words from the query range's business days (year only outside this year). Rates two decimals as before; null rate reads "No schedule".

## States
- Each section owns its state in its card: skeleton at real heights on first load, SectionEmpty naming the range ("No submissions today."), capped and partial notes said in words in the card.
- Range or source change keeps each section's previous data dimmed (Kept Data While Reloading).
- Raw submissions stays folded until opened; opened, 25 rows then "Show more"; voided rows keep their VOIDED word, time and reason.
- Container folds: below `@5xl` posts move under specialists; the stage strip goes 3 + 3 then 2 per row; tables fold to two-line rows in narrow cards.
