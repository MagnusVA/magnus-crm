# Redesign backlog, grouped by archetype

Sources: `routes.md` (route map), `drift.md` (source drift), `.impeccable/review/inventory/` (285 screenshots), and the critique snapshots in `.impeccable/critique/` (closer dashboard 24/40, meeting detail 18/40, person detail 22/40, Sales Calls 25/40). Written 2026-10-28.

Scope: 43 live screens. The 11 redirect-only routes need no design work.

## 0. Bugs to fix outside the redesign

These are behaviour bugs. Fix them in small PRs off `main`, not on the redesign branch.

| # | Bug | Evidence |
|---|---|---|
| B1 | **P0.** Closing the follow-up dialog after "Generate link" without pressing Done leaves a pending follow-up. That hides every outcome button, and the deal stays "Booked". Nothing on the page shows the pending follow-up. | `app/workspace/closer/meetings/_components/follow-up-dialog.tsx:221-222`, `outcome-action-bar.tsx:73-79` (checked in source) |
| B2 | The live call disappears from the closer's hero card once it has started: the query keeps only `scheduledAt >= now`. | `convex/closer/dashboard.ts:190-198` (from the critique; not yet checked in source) |
| B3 | Deleting a deal in the sheet pushes `/workspace/opportunities`, which redirects to the list, so the user loses the person they were on. | `delete-opportunity-dialog.tsx:80` |
| B4 | Opening a deal in the sheet never writes `?opportunityId=` to the URL, so Back and share don't work. | `opportunity-sheet-context.tsx:51-58` |
| B5 | `hsl(var(--x))` wraps OKLCH tokens, which makes the colour invalid. Affected: the skeleton shimmer, a sticky table-header shadow, and the No Show chart colour. | `app/globals.css:207-209`, `event-type-config-list.tsx:216`, `meeting-outcome-distribution-chart.tsx:32` |
| B6 | Legacy redirects drop query filters: `/pipeline` → `/opportunities` → list, and Sales Calls ignores the `status`/`closerId` it receives. | `app/workspace/pipeline/page.tsx:26-38` |
| B7 | Merge and redistribute have no page-level guard. Convex enforces roles on the data, so this is defence in depth. | `routes.md` §6 |
| B8 | The notification bell is a placeholder over an empty array. Either build it or remove it. | `components/notification-center.tsx:24-32` |

## 1. Foundations (system-wide; blocks everything else)

- **Status colour contract.** About 360 palette classes in 42 files bypass the tokens, and the hub is `lib/status-config.ts`. Payment statuses conflict between screens: recorded is amber in one place and blue in another, disputed is rose in one and red in another. Define one semantic status scale for deal stage, meeting attendance, payment, lead lifecycle and urgency, with light and dark values and AA contrast. Each concept gets one badge form.
- **Chart palette.** All five `--chart-*` slots are yellow to brown, and the program pie repeats colours after five programs. A categorical palette is needed.
- **Type scale.** There are 50 `h1`s ranging from `text-base` to `text-5xl`, and 96 arbitrary text sizes (9.6, 10, 11 and 13px). The 10px uppercase micro-labels appear across the detail pages. KPI numbers are set in mono.
- **Contrast.** The muted text measures 4.14–4.44:1 on several screens, and "Mark as Lost" measures 3.97:1. Fix this at the token level.
- **Hit targets.** Controls are 14–20px tall: help icons, status filters, breadcrumbs, "Enter: sends". Set a 24px minimum in the components.
- **Spacing and containers.** There are 216 arbitrary layout values, nested page padding (shell `p-6` plus the detail page's own `px-*`), several unrelated max widths, and 59 card padding overrides.
- **Vocabulary.** Use the `CONTEXT.md` terms everywhere: deal not opportunity, held not showed, and one name for money collected. "Not recorded" currently means both an attendance state and an empty date.

## 2. Shell and navigation

- There are four separate shells: workspace, admin, onboarding, and the public pages with the DM portal. Decide which ones share the frame.
- The command palette has its own menu: it lacks Reports and Profile, and its shortcut labels differ from the sidebar. Derive both from one navigation model.
- Breadcrumbs show `...` for unmapped segments, and some ancestor links go to redirect routes.
- Nav labels don't match the page titles ("Sales Calls" vs "Phone Sales Ops", "Qualifications" vs "Qualified Leads").
- There's no shared page-header component. Build one: title, context line, primary action, and a slot for secondary controls.

## 3. Dashboards and reports (13 screens)

- **One operations layout.** Header, then the "needs attention" strip, then headline metrics against goal and against the previous period, then a per-person table, then the queue. Today Sales Calls, Booked Calls, Qualifications and Lead Gen each use a different body layout.
- **One date-range control.** There are three implementations (dashboard, report, Slack qualifications), plus raw date inputs on Billing. Keep the business-day and browser-day semantics and the Monday-start weeks.
- **Tables stay inside the page.** Sales Calls renders at 1696px on a 1440px viewport (`min-w-[1080px]`), and Team Performance at 1681px. Group the columns, make the headers sortable, and let clicking a row filter the queue.
- **Empty and quiet days.** Walls of "$0.00", "—" and "Nothing here", and empty chart axes. An empty state should say what to do next.
- **Tooltips carry too much meaning.** There are about 20 help icons per page, and they overwrite each header's accessible name.
- Overlap between Qualifications (ops) and Slack Qualifications (report): decide whether it's one screen or two.

## 4. Record detail (7 screens)

- **Lead with the next action.** Meeting detail needs a "Record outcome" band for past calls with no recorded result. Person detail needs a header action bar (new deal, add note, copy contact).
- **Outcome flow.** Start with "Did they show?", then branch to won, follow-up or lost. The win gets the primary weight; today Mark as Lost is the loudest button. The dialogs should state their consequences, and payment needs a review step and should default to the booked program.
- **Organise the page around the deal.** Nest each deal's meetings, payments and next task inside the deal. Today they are parallel lists linked only by program name, and attribution appears three times.
- **Prep before credit.** On the call screen, notes and booking answers come before the attribution trail.
- **One meeting detail.** The admin and closer versions differ in card layout, action placement and the won flow.
- **Mobile.** Grid children overflow (383px inside 310px) and the email is clipped. The actions should stay reachable on a phone.

## 5. Lists and tables (8 screens)

- Rows open through `onClick` only, so they don't work from the keyboard. Make the primary cell a real link.
- There's no shared data-table interface: billing, team, booking reviews and lead gen each build their own wrapper. Build one table recipe with sorting, a sticky header, the density rules and a mobile card fallback. The person browser already has a card fallback to build on.
- Filters should be URL-synced everywhere (the closer pipeline does this today; Sales Calls does not).

## 6. Forms, wizards and settings (8 screens)

- 21 form files still use the `FormItem` composition. Move them to `Field` and `FieldGroup`.
- 17 select and menu files are missing their group components.
- High-stakes dialogs (payment, lost, no-show, void, delete) share one pattern: name the record, state the consequence, review, then confirm.

## 7. Public, onboarding and portal (6 screens)

- Lower priority. The DM portal and onboarding are the first thing external people see of the brand, so they belong to the brand-forward end of the system, not the dense app end.

## 8. Closer home (needs its own design brief)

- A list of today's calls as the backbone of the page, plus a "Needs outcome (n)" queue. Performance moves below, and the calendar becomes secondary.
- One period control, placed inside the Performance section.
- The follow-ups section always renders: a loading state, an explicit "none due", and Overdue / Today / Later groups.
