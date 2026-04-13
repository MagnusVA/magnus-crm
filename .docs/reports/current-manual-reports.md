# Sales Team Report 2026 (PT DOM) — Detailed Document Analysis

## 1. Document Purpose

This workbook is a **full-year phone sales team performance tracker** for a coaching/fitness business. It logs every booked sales call, tracks its outcome, records revenue, and aggregates performance KPIs per closer per month. The suffix "PT DOM" likely refers to a specific product line or market segment (e.g., Personal Training — Domestic).

---

## 2. Sheet Inventory

The workbook contains **14 sheets**:

| #    | Sheet Name        | Purpose                           | Has Real Data?                                                      |
| ---- | ----------------- | --------------------------------- | ------------------------------------------------------------------- |
| 1–2  | JANUARY, FEBRUARY | Monthly performance + raw logs    | Yes — fully populated                                               |
| 3–4  | MARCH, APRIL      | Monthly performance + raw logs    | Partial — raw data exists but summary tables show placeholder names |
| 5–12 | MAY – DECEMBER    | Monthly performance + raw logs    | No — empty templates                                                |
| 13   | RANGE INFO        | Custom date-range filtered report | Yes — filtered to Apr 7, 2026                                       |
| 14   | DATA              | Master consolidated raw data log  | Yes — 2,360 rows                                                    |

---

## 3. Monthly Sheet Layout (JANUARY – DECEMBER)

Each monthly sheet has two distinct zones stacked vertically.

### Zone 1: Summary Dashboard (Rows 1–12)

Two side-by-side KPI tables, each tracking a different call type:

**Left table — "Sales Team New Calls"**
**Right table — "Sales Team Follow Up Calls"**

Both tables share the same column structure:

| Column                 | What It Measures                     | Example (Andrew, Jan New Calls) |
| ---------------------- | ------------------------------------ | ------------------------------- |
| Closers                | Phone closer's first name            | `Andrew`                        |
| Booked Calls           | Total calls scheduled                | `131`                           |
| Cancelled Calls        | Calls cancelled before the call date | `6`                             |
| Calls Showed           | Prospects who actually attended      | `79`                            |
| No Shows               | Prospects who didn't attend          | `46`                            |
| Show Up Rate           | Showed ÷ (Booked − Cancelled)        | `63.2%`                         |
| Sales                  | Count of closed deals                | `28`                            |
| Cash Collected         | Total dollars collected from sales   | `$42,396`                       |
| Close Rate             | Sales ÷ Calls Showed                 | `35.4%`                         |
| Average Cash Collected | Cash Collected ÷ Sales               | `$1,514.14`                     |

The last row is always a **TEAM TOTAL** that aggregates all closers. For example, January's team totals for New Calls were: 771 booked, 134 sales, $313,979 cash collected, 32.5% close rate.

### Zone 2: Raw Transaction Log (Row 14 onward)

Below each summary table sits a detailed log of every individual call, again split into two side-by-side sections (New Calls on the left, Follow Up Calls on the right). Each log entry contains:

| Column       | Description                                      | Example                 |
| ------------ | ------------------------------------------------ | ----------------------- |
| Date         | Date of the call                                 | `2026-01-01`            |
| Username     | Prospect's social media handle (sometimes empty) | `coachrafik`            |
| Email        | Prospect's email address                         | `agn.nunez17@gmail.com` |
| Phone Closer | Which closer handled it                          | `Andrew`                |
| Status       | Outcome of the call (see Section 5)              | `Sold`                  |
| Amount       | Revenue collected (only for Sold status)         | `500`                   |

**Example raw rows from January (New Calls):**

```
Date: 2026-01-01 | Email: longevitypromax@gmail.com   | Closer: Andrew  | Status: Overran    | Amount: —
Date: 2026-01-01 | Email: kevinwesleychung@gmail.com  | Closer: Andrew  | Status: Lost       | Amount: —
Date: 2026-01-01 | Email: agn.nunez17@gmail.com       | Closer: Andrew  | Status: Sold       | Amount: $500
Date: 2026-01-01 | Email: dreamchaseherfit@gmail.com  | Closer: Andrew  | Status: Follow up  | Amount: —
```

**Example raw rows from January (Follow Up Calls):**

```
Date: 2026-01-01 | Email: gabriel.fitcoach@gmail.com   | Closer: Andrew  | Status: Sold | Amount: $400
Date: 2026-01-01 | Email: bolobuiltfitness@gmail.com   | Closer: Johann  | Status: Sold | Amount: $5,333
Date: 2026-01-01 | Email: veganlovebycass@gmail.com    | Closer: Johann  | Status: Sold | Amount: $4,500
```

---

## 4. Closers (Team Roster)

The active roster changes slightly across months:

| Closer   | Jan | Feb | Mar | Apr | RANGE INFO |
| -------- | --- | --- | --- | --- | ---------- |
| Andrew   | ✓   | ✓   | ✓   | —   | —          |
| Isabella | ✓   | ✓   | ✓   | ✓   | ✓          |
| Johann   | ✓   | ✓   | ✓   | ✓   | ✓          |
| Luke     | ✓   | ✓   | ✓   | ✓   | ✓          |
| Michael  | ✓   | ✓   | ✓   | ✓   | ✓          |
| Tyler    | ✓   | ✓   | ✓   | ✓   | ✓          |
| Joshua   | ✓   | ✓   | ✓   | —   | —          |
| Reece    | —   | —   | —   | ✓   | ✓          |

Months May–December use generic placeholders ("Phone Closer 1" through "Phone Closer 5"), indicating they are templates waiting to be configured.

---

## 5. Status Values (Call Outcomes)

Every raw transaction carries one of these status labels:

| Status          | Meaning                                    | Has Amount? | Example Context                     |
| --------------- | ------------------------------------------ | ----------- | ----------------------------------- |
| **Sold**        | Deal closed, payment collected             | Yes         | `Sold — $500`                       |
| **Lost**        | Prospect declined or was not interested    | No          | Prospect said no after the call     |
| **No show**     | Prospect did not attend the scheduled call | No          | 177 no-shows in Jan new calls       |
| **Canceled**    | Call was cancelled before it took place    | No          | 135 cancellations in Jan new calls  |
| **Rescheduled** | Call was moved to a future date            | No          | 47 rescheduled in Jan new calls     |
| **Follow up**   | Needs another touch, not yet decided       | No          | 151 follow-ups in Jan new calls     |
| **Overran**     | Call ran over time / ended inconclusively  | No          | 9 in Jan new calls                  |
| **DQ**          | Disqualified (prospect not a fit)          | No          | Appears in Feb only (5 occurrences) |

**January New Calls status breakdown:**

```
No show:     177  (23.0%)
Follow up:   151  (19.6%)
Canceled:    135  (17.5%)
Sold:        134  (17.4%)
Lost:        118  (15.3%)
Rescheduled:  47  ( 6.1%)
Overran:       9  ( 1.2%)
```

---

## 6. Revenue Details

Amounts are only recorded for `Sold` status rows and represent **cash collected** (not contract value).

| Metric        | January New Calls | January Follow Ups |
| ------------- | ----------------- | ------------------ |
| Total deals   | 134               | 62                 |
| Total cash    | $313,979          | $236,532           |
| Min deal size | $50               | $100               |
| Max deal size | $25,000           | $25,000            |
| Avg deal size | $2,343            | $3,815             |

Follow-up calls have a notably higher average deal size, suggesting that prospects who return for a second call tend to commit to higher-value packages.

---

## 7. RANGE INFO Sheet — Custom Date-Range Report

This sheet lets the user filter all data to a **specific date range** using two date cells (located at approximately row 3, columns K–L). At the time of extraction, both dates were set to **April 7, 2026**, making it a single-day report.

It contains **three side-by-side summary tables** (unlike the monthly sheets which have two):

1. **New Calls** — same KPI columns as monthly sheets
2. **Follow Up Calls** — same KPI columns
3. **Sales Team Totals** — a combined view merging new + follow-up

**Example from RANGE INFO (Apr 7 filter):**

```
Tyler:   15 booked | 6 cancelled | 6 showed | 3 no-shows | 4 sales | $2,700 cash | 66.7% close rate
Michael:  6 booked | 1 cancelled | 2 showed | 3 no-shows | 1 sale  | $1,000 cash | 50% close rate
Johann:   7 booked | 1 cancelled | 2 showed | 4 no-shows | 0 sales | $0          | 0% close rate
TEAM:    33 booked | 9 cancelled | 14 showed | 10 no-shows | 5 sales | $3,700 cash | 35.7% close rate
```

Below the summary tables is a raw transaction log (32 rows for that date), also in three parallel sections.

---

## 8. DATA Sheet — Master Consolidated Log

This sheet is the **single source of truth** containing all raw transactions across all months. It has **2,360 rows** of data organized in **three parallel sections** (28 columns wide):

| Section           | Columns (approx.)   | Content                                             |
| ----------------- | ------------------- | --------------------------------------------------- |
| Left (cols B–G)   | New Calls log       | Date, Username, Email, Phone Closer, Status, Amount |
| Center (cols N–T) | Follow Up Calls log | Date, Username, Email, Phone Closer, Status, Amount |
| Right (cols W–AB) | All Calls combined  | Date, Username, Email, Phone Closer, Status, Amount |

The third section merges both new and follow-up calls into a single chronological list, which is unique to this sheet and not found on the monthly tabs.

---

## 9. Filters & Dimensions Available

| Dimension             | Where It's Filterable         | How                                                                    |
| --------------------- | ----------------------------- | ---------------------------------------------------------------------- |
| **Month**             | Sheet tabs (JANUARY–DECEMBER) | Each tab = one month                                                   |
| **Custom Date Range** | RANGE INFO sheet              | Two date-input cells control the filter                                |
| **Call Type**         | Every sheet                   | New Calls vs. Follow Up Calls are always separate side-by-side tables  |
| **Closer**            | Summary tables + raw data     | Each row in summary = one closer; raw data has a "Phone Closer" column |
| **Status**            | Raw data logs                 | "Status" column on every raw data row                                  |
| **Prospect**          | Raw data logs                 | Filterable by Email or Username                                        |
| **Deal Size**         | Raw data logs                 | "Amount" column on Sold rows                                           |

---

## 10. Formula-Driven vs. Manual

The **summary tables are formula-driven** — they compute KPIs from the raw data below them. Evidence for this:

- March and April have raw transaction data (87 and 145 rows respectively) but the summary tables show zeros because the closer names in the summary rows ("Phone Closer 1", etc.) don't match the actual closer names in the raw data (Isabella, Tyler, etc.). The formulas likely use SUMIFS/COUNTIFS keyed on the closer name.
- January and February summaries match the raw data counts exactly (e.g., Jan shows 771 booked calls in the summary, and 771 raw data rows exist).

---

## 11. Template vs. Live Data Summary

| State                            | Sheets            | Row Count           | Revenue                          |
| -------------------------------- | ----------------- | ------------------- | -------------------------------- |
| **Fully active**                 | January, February | ~1,600 raw rows     | $993,494 combined                |
| **Data present, summary broken** | March, April      | ~230 raw rows       | Formulas show $0 (name mismatch) |
| **Empty template**               | May – December    | 0 rows              | —                                |
| **Cross-month consolidated**     | DATA              | 2,360 rows          | All months combined              |
| **Date-filtered view**           | RANGE INFO        | 32 rows (for Apr 7) | $3,700                           |
