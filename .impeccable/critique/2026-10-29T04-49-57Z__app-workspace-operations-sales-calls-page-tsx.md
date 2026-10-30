---
target: sales-calls
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/Users/nimbus/.t3/worktrees/ptdom-crm/t3-fac7d69c/app/workspace/operations/sales-calls/page.tsx"
target_fingerprint: "sha256:179d19d02db495757f616c1fe75075937dbf681f6313494b69b9b4d3b0b7e1cb"
target_path: /Users/nimbus/.t3/worktrees/ptdom-crm/t3-fac7d69c/app/workspace/operations/sales-calls/page.tsx
timestamp: 2026-10-29T04-49-57Z
slug: app-workspace-operations-sales-calls-page-tsx
---
# Assessment A: Sales Calls (`/workspace/operations/sales-calls`)

## 1. Design-specificity verdict

The data is specific to this product and the metric definitions take real care, but the layout is a stock shadcn dashboard (icon tiles, chart toggle, wide table, list) any product could use.

## 2. Nielsen heuristics

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | System status | 3 | Good freshness, job alerts, skeletons; rebuilding wipes the page |
| 2 | Real-world match | 2 | Same money is "Cash Collected", "Payment Revenue" and "Revenue"; "Showed" vs CONTEXT.md's "held" |
| 3 | Control and freedom | 3 | Range syncs to the URL; closer filter and chart view reset on reload |
| 4 | Consistency | 2 | Ops pages use three body layouts; nav labels differ from H1s |
| 5 | Error prevention | 3 | Read-only page; custom ranges are validated |
| 6 | Recognition over recall | 2 | About 20 hover tooltips carry the meaning |
| 7 | Flexibility | 2 | No sorting, no click-a-closer-to-filter, no status filter |
| 8 | Minimalism | 2 | Crowded header; full-row AVG; "0 of 0 past calls" repeated 3 times |
| 9 | Error recovery | 3 | Retry and Generate again, with messages |
| 10 | Help | 3 | Every metric defined, hover-only |
| | **Total** | **25/40** | **Acceptable** |

## 3. Cognitive load

5 of 8 checks fail (high load):
- Single focus
- Chunking
- Visual hierarchy
- Minimal choices
- Working memory: Cash Collected vs Team Total must be compared from memory

Decision points with more than 4 options:
- The header: Export, currency, Day, Week, Month, Custom (`sales-calls-page-client.tsx:183-230`)
- The 10 numeric closer columns
- The 5 KPI tiles of equal weight

## 4. Emotional journey

A quiet day reads as a wall of $0.00 and "Nothing here", with no next call shown. Chasing unrecorded calls, the real job, sits ~1000px down; the visit never answers "are we on track?"

## 5. Strengths

- Honest metric definitions (`results-recorded.tsx`, `phone-closer-table.tsx:66-82`).
- Thorough state coverage: skeletons, freshness, and report-job alerts with cancel and retry (`report-job-status.tsx`).
- The range control and the searchable list are shared across the sibling pages.

## 6. Priority issues

**[P1] The page counts calls with no result but won't take you to them**
- **What:** "x of y past calls have a result" is shown, but Meetings is last, has no status filter, and drops the `status` and `closerId` that `/workspace/pipeline` passes in (`app/workspace/pipeline/page.tsx:26-30`, `sales-calls-details-list.tsx:200-241`).
- **Why it matters:** Recording results is the operator's daily job.
- **Fix:** Add a "needs attention" strip first (not recorded, next up, no-shows). Add a status filter, URL-sync the filters, and make the count a link.
- **Command:** /impeccable layout

**[P1] Weak metric hierarchy and drifting vocabulary**
- **What:** Five equal tiles with no goal or prior-period delta. AVG gets a full-width row captioned "total sales ÷ sales quantity" (`sales-calls-stat-cards.tsx:121-160`). "Total Calls" and "Booked" are the same count.
- **Why it matters:** An operator can't tell whether today is good.
- **Fix:** One primary row (cash against goal, close rate, show rate, held/booked) with deltas. Fold AVG into Cash. Use one name per metric.
- **Command:** /impeccable clarify

**[P1] The closer table breaks the layout and can't be acted on**
- **What:** `min-w-[1080px]` (`phone-closer-table.tsx:199`). The page renders 1696px wide at a 1440px viewport and "Avg Payment" is clipped (`sales-calls.light.1440.png`). Headers don't sort, and every Show-Up cell carries a second line.
- **Why it matters:** Comparing closers is the core judgment here.
- **Fix:** Contain the overflow. Group the columns into Attendance and Money. Sortable headers. Clicking a row filters Meetings.
- **Command:** /impeccable adapt

**[P2] The ops pages don't share one layout**
- **What:**
  - Booked Calls and Qualifications use a chart plus a goal ring; Sales Calls uses tiles plus a chart card; Lead Gen uses tiles plus tables.
  - Nav labels don't match the H1s: "Sales Calls" vs "Phone Sales Ops", "Qualifications" vs "Qualified Leads".
  - Each page has its own empty state, including empty axes on `booked-calls.light.1440.png`.
- **Why it matters:** Admins relearn each page daily.
- **Fix:** One ops layout (header, goal and headline row, per-person table, queue), with one empty state and one name per page.
- **Command:** /impeccable shape

**[P2] The header and the program chart add noise**
- **What:** The currency select shows even with one currency, and the control cluster pushes the H1 to y≈180. The pie switches from revenue to calls when there's no revenue, and its colors repeat after 5 programs (`per-program-stat-card.tsx:186-202`).
- **Why it matters:** Noise competes with the numbers.
- **Fix:** Hide single-currency controls, drop the pie, default to a table.
- **Command:** /impeccable distill

## 7. Persona red flags

- **Alex (power user):** No sorting, no closer-to-queue drill-down, filters reset on reload.
- **Sam (accessibility):** Help triggers rename each header to "About Booked, button" (`overview-help-tooltip.tsx:38-40`), adding about 20 tab stops. "(partial)" is explained only in a `title` attribute.
- **Riley (stress tester):** Legacy pipeline links lose their filters silently. Team Total can be lower than Cash Collected, explained only in a tooltip. At 390px Meetings rows hide the closer and time (`hidden md:flex`).

## 8. Minor observations

- Zero shows as both $0.00 and "—".
- "Per Program Statistic", "AVG" and "Nothing here" are weak labels.
- The tile icons and the H1 accent bar are decoration.

## 9. Provocative questions

1. If the operator saw one number at 10 a.m., should it be cash against goal or unrecorded calls?
2. Should a live Today floor and a historical report share one screen?
3. Why does the page closest to revenue have no goal when Booked Calls and Qualifications do?


## Detector and browser evidence (Assessment B)

CLI detector: 0 findings (exit 0).
Browser: document 1696px wide at 1440px viewport (256px overflow); mobile table 1421px inside 316px scroll container; Cash Collected needs 124px, has 112px; result-status text 4.24:1; 18 tooltip targets 19-20px high.
