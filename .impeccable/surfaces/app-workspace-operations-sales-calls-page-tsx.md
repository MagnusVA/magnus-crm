---
version: 1
slug: "app-workspace-operations-sales-calls-page-tsx"
primary_target: "app/workspace/operations/sales-calls/page.tsx"
related_targets: []
---

# Operations › Sales Calls (`/workspace/operations/sales-calls`)

Mode: Operate. Built in the Departures Board world (`DESIGN.md`), in the Overview's family (`.impeccable/surfaces/app-workspace-page-tsx.md`). Replaces the old header (green accent bar, "Phone Sales Ops", currency select and freshness stacked on the right), five icon-tiled stat cards with help tooltips, the shadcn per-program card, a 1080px sideways-scrolling closers table and the generic collapsible meetings list.

## Scope
Audience: owners and admins. They open it to see how the phone sales floor did over a range: calls, show rate, cash, close rate, average sale; then which closers and programs produced it; then look up a meeting.
User decisions (2026-11-02): same content and data, new design; all sections weigh equally (keep the order figures, closers, programs, meetings); Programs keeps its bar / pie / table switch; money leads with the main currency (most payment sales) with other currencies listed beside it, and the tables keep one currency select; structure "Figures in the band" (`.impeccable/mocks/decision/sc-band-figures.html`).
Untouched: every number and its definition, the snapshot-job path for long ranges, the live/ClickHouse split, the export menu, admin-only access, the meetings queries (one row per page today, see open issues).

## Direction contract
THESIS: The band answers "how did the floor do" before any card: five headline figures sit inside the navy band as one ruled figure row, each with its proof line; the paper holds who and what produced them. Refuses the row of equal icon-tiled stat cards, help-icon headers and a table that scrolls sideways.
OWN-WORLD: PageBand navy with the book panel's figure grammar (11px condensed labels, 30px condensed figures, 13px proof lines at 75% board text, board-line rules); cash in lime as on the book panel, other currencies at 17px in board text. Paper ground, white DetailCards with 44px title rows, 28px condensed column heads, condensed tabular figures, zeros in slate. Status words in their inks (Not recorded amber ink, No-show danger ink). No lime on the paper.
STORY: The admin lands on Today, reads the five figures and that today is live, switches to This week, scans the closers ranked by revenue, opens the quiet closers only if needed, flips Programs to the table, and searches a meeting by name to open its deal.
FIRST VIEWPORT: Navy sidebar, white top bar. PageBand "Sales calls" with the 13px line (range words in medium board text · freshness with the Live dot · business-day line from @3xl); right of the title the board-tone picker, the currency select when there are several currencies, and Export. Under a board rule inside the band, five zones: CALLS (with "N canceled · N no-show"), SHOW RATE ("N of M past calls have a result"), CASH COLLECTED (lime main currency, others beside), CLOSE RATE ("N of M deals won"), AVERAGE SALE ("$X ÷ N payment sales"). Under the band, the Phone closers table full width: closers with activity ranked by revenue, Total row, the quiet closers folded into one footer line with Show them. Then Programs beside Meetings, and a "How these are counted" card last.
FORM: Figures in the band, position 5 of my ordered list, dealt lead. seed:39590909e0b72fcf
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Data rules
- Dashboard: `api.operations.salesCallsDashboard.getSalesCallsDashboard` through `useAnalyticsReport` (merge `mergeSalesCallsDashboard`); ranges over 7 days on a page not switched to ClickHouse go through the snapshot job (`useOperationsDashboardReport` + `useAllOperationsReportRows`, built by `buildHistoricalSalesDashboard`).
- Meetings: `listPhoneSalesMeetings` (paginated) and `searchSalesCallsMeetings` (two or more characters), on the dashboard's `window`.
- Main currency: most payment sales in the summary; ties go to USD, then alphabetical. Money is never added across currencies.
- Team total revenue counts only payments credited to a closer; the band's cash counts every final payment.

## States
- First load: skeleton band zones and cards at real heights. Range change: previous numbers stay at 60% (Kept Data While Reloading).
- Snapshot job queued / running / failed / ready, health banner, freshness alert: under the band, never inside it.
- Business day rebuilding: one line in place of the sections.
- Empty: "No calls booked with phone closers today." / "No calls or payments for any program this week." / "No meetings in this range." Rates read "—" when they have no base.
- Phones: band zones fold to two columns; the closers table folds to two-line rows; Programs and Meetings stack.
