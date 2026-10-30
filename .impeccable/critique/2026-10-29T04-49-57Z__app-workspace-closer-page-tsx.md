---
target: closer-dashboard
total_score: 24
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/Users/nimbus/.t3/worktrees/ptdom-crm/t3-fac7d69c/app/workspace/closer/page.tsx"
target_fingerprint: "sha256:f22ed3fd615b38e36990c49ce772251feb2fc0cefd8f2236816f6dac7efbf1de"
target_path: /Users/nimbus/.t3/worktrees/ptdom-crm/t3-fac7d69c/app/workspace/closer/page.tsx
timestamp: 2026-10-29T04-49-57Z
slug: app-workspace-closer-page-tsx
---
# Closer dashboard (`/workspace/closer`): Assessment A

`_c/` = `app/workspace/closer/_components/`. Screenshots: L1440 (light), D1440 (dark), M390 (mobile).

## 1. Design-specificity verdict
The parts are specific to a closer: a next-call countdown, follow-up urgency, and a close rate that leaves out no-shows. The page around them is a generic dashboard. "My Dashboard / Welcome back" doesn't give the date, there is no list of today's calls, and last week's numbers sit above today's schedule.

## 2. Nielsen heuristics
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | System status | 2 | The live call drops out of the hero card. Follow-ups render nothing while loading or when empty. |
| 2 | Real-world match | 2 | "opps", "decided", "Stale" and Reminders vs Follow-up differ from `CONTEXT.md`. |
| 3 | User control | 3 | Today and prev/next work. The view resets to Week every visit. |
| 4 | Consistency | 2 | Two lookalike Day/Week/Month controls. "Join Meeting" vs "Go to Meeting". |
| 5 | Error prevention | 3 | The page is mostly read-only, and an invalid custom range can't be applied. |
| 6 | Recognition vs recall | 2 | Today's calls and unlogged calls have to be found in a grid. |
| 7 | Flexibility | 2 | Cmd+K and Cmd+1-4 exist, but the calendar has no keys and no agenda view. |
| 8 | Minimalism | 2 | Two time-zone notes, two range bars, and oversized empty states. |
| 9 | Error recovery | 3 | The Calendly banner names the fix. "Lookup incomplete" is vague. |
| 10 | Help | 3 | Every metric has a tooltip, but nothing tells the closer what to do next. |
| **Total** | | **24/40** | **Acceptable** |

## 3. Cognitive load
4 of 8 checks fail, so the load is high: single focus, grouping (the header period control drives a panel two blocks below it), minimal choices, and working memory (two independent ranges use the same words).
Decision points with more than 4 options: the schedule toolbar (6, `_c/calendar-header.tsx`); the header and toolbar together (10 time controls on M390); the pipeline legend (5).

## 4. Emotional journey
On a full day, the countdown card is the high point. Then come the low points. A closer two minutes late finds a different meeting in that card. A quiet week greets them with an emerald "$0". The page ends on an empty grid that says "check back later" (L1440 bottom, M390), which leaves them nothing to do.

## 5. Strengths
- `_c/featured-meeting-card.tsx`: urgency rises in both color and text, and Join is the primary action.
- `_c/reminders-section.tsx`: each row is one link with a dot, a tint and a text label ("Call · Overdue"), and it leads to a page that resolves the follow-up.
- `_c/pipeline-strip.tsx`: the close rate is honest, legend items open the filtered pipeline, and truncation is disclosed.

## 6. Priority issues
**[P1] No today agenda**
- What: the order is next call, follow-ups, Performance, then a Week grid (`min-w-[700px]`, `_c/week-view.tsx`), which scrolls sideways on M390.
- Why: "what's next, in order?" needs a list.
- Fix: make a Today list (time, person, event type, deal stage, Join/Prep) the spine of the page. Put Performance below it and make the calendar secondary.
- Command: `/impeccable layout`

**[P1] The live call vanishes from the hero card**
- What: `convex/closer/dashboard.ts:190-198` only returns meetings where `scheduledAt >= now`, polled every 60 s, so "Starting now" lasts at most a minute.
- Why: Join disappears when a closer running late needs it most.
- Fix: keep the meeting in the card until it ends, then show "Record outcome".
- Command: `/impeccable harden`

**[P1] Calls that need an outcome have no queue**
- What: unlogged calls show only as a "Not recorded" color on calendar blocks (`_c/meeting-block.tsx`).
- Why: outcomes drive the pipeline and the close rate, and the closer has to remember which calls are unlogged.
- Fix: add a "Needs outcome (n)" list near the top.
- Command: `/impeccable shape`

**[P2] Two lookalike range controls**
- What: the header ToggleGroup drives only Performance and the calendar Tabs drive only the schedule (`_c/closer-dashboard-page-client.tsx:197-215`). The time-zone note appears twice, and both control rows stack on M390.
- Fix: put the period control inside the Performance header and show the note once.
- Command: `/impeccable distill`

**[P2] Follow-ups are invisible when empty or loading**
- What: the section returns `null` while loading and when empty, so the layout shifts when it arrives. Dates are absolute, "Now" lasts 60 s (`_c/reminder-urgency.ts`), and the list stops at 50 without saying so.
- Fix: always render it, with a skeleton and an explicit "No follow-ups due". Group into Overdue / Today / Later.
- Command: `/impeccable onboard`

## 7. Persona red flags
- **Alex (power user):** the calendar has no keyboard shortcuts. The view is plain `useState`, so it resets every visit. Prep takes two clicks: dialog, then View Details.
- **Sam (screen reader):** the `aria-live` countdown re-announces every minute. Month cells label a div that has no role. The pipeline's empty message is 10 px. The missing follow-up section is silent.
- **Casey (mobile):** the first screen is a title, 4 range buttons and an empty state (M390). The week grid needs sideways scrolling, Join sits at the top out of thumb reach, and Search is hidden.

## 8. Minor observations
- The emerald cash tile celebrates $0.
- The title has a decorative accent bar.
- KPIs are in a mono font.
- The skeleton has 7 legend chips for 5 stages.
- Dead code with different empty copy: `_c/closer-dashboard-header.tsx`, `featured-meeting-section.tsx`, `featured-meeting-card-wrapper.tsx`.
- "Unknown Lead" fallback.
- Raw red, amber and emerald colors bypass the tokens.

## 9. Provocative questions
1. At 8 a.m., which matters more: cash collected or the next three calls?
2. Should unlogged calls outrank upcoming ones?
3. Does a month calendar belong on this page at all?


## Detector and browser evidence (Assessment B)

CLI detector: 0 findings (exit 0).
Browser: five 16x16px controls; five 20px-high status filters; Cash collected / 0 payments contrast 4.36:1; empty-state text 4.14:1; role text 4.44:1.
