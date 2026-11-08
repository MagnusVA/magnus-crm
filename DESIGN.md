---
name: Magnus CRM
description: A departures board inside a calm, standard CRM. Navy shell and board, paper ground, white ruled cards, lime for the next action.
colors:
  navy-shell: "#141a28"
  shell-raised: "#1d2536"
  board: "#141a28"
  board-raised: "#1d2536"
  board-foreground: "#eef1f6"
  board-muted: "#9aa4b6"
  board-line: "rgb(242 244 247 / 0.08)"
  board-danger: "#ff8a8e"
  paper: "#f5f6f8"
  card: "#ffffff"
  ink: "#141a28"
  ink-muted: "#4f596b"
  rule: "#e3e7ed"
  input-rule: "#d5dbe3"
  muted-fill: "#eef1f5"
  lime: "#84b135"
  on-lime: "#141a28"
  lime-ink: "#4a7212"
  warning: "#f5b700"
  warning-surface: "#fff4cc"
  warning-ink: "#7a5200"
  danger: "#d93a40"
  danger-ink: "#b42328"
  stage-booked: "#4c6fd0"
  stage-booked-ink: "#2b4aa8"
  stage-held: "#8e99ac"
  stage-held-ink: "#4f596b"
  stage-follow-up: "#2a9d95"
  stage-follow-up-ink: "#1d756f"
  stage-won: "#84b135"
  stage-won-ink: "#4a7212"
  stage-lost: "#d93a40"
  stage-lost-ink: "#b42328"
  paper-dark: "#090d14"
  card-dark: "#121826"
  popover-dark: "#171e2d"
  navy-shell-dark: "#0d121c"
  board-dark: "#1b2336"
  board-raised-dark: "#26304a"
  ink-dark: "#eef1f6"
  ink-muted-dark: "#98a2b3"
  rule-dark: "rgb(255 255 255 / 0.09)"
  lime-ink-dark: "#a6cf5e"
  warning-surface-dark: "#3a2f0a"
  warning-ink-dark: "#ffd666"
  danger-dark: "#e5484d"
  danger-ink-dark: "#ff8a8e"
  stage-booked-dark: "#6f8fe6"
  stage-booked-ink-dark: "#9db4f2"
  stage-held-ink-dark: "#b9c2d0"
  stage-follow-up-dark: "#3fb8b0"
  stage-follow-up-ink-dark: "#7ccbc6"
typography:
  display:
    fontFamily: "Barlow, sans-serif"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "Barlow, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.25
  title-strip:
    fontFamily: "Barlow, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.25
  title-choice:
    fontFamily: "Barlow, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 600
  title:
    fontFamily: "Barlow, sans-serif"
    fontSize: "15px"
    fontWeight: 600
  body:
    fontFamily: "Barlow, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
  body-meta:
    fontFamily: "Barlow, sans-serif"
    fontSize: "13px"
    fontWeight: 400
  figure-xl:
    fontFamily: "Barlow Condensed, sans-serif"
    fontSize: "32px"
    fontWeight: 600
    lineHeight: 1.05
    fontFeature: "tnum"
  figure-money:
    fontFamily: "Barlow Condensed, sans-serif"
    fontSize: "30px"
    fontWeight: 600
    lineHeight: 1.05
    fontFeature: "tnum"
  figure-lg:
    fontFamily: "Barlow Condensed, sans-serif"
    fontSize: "1.625rem"
    fontWeight: 600
    lineHeight: 1
    fontFeature: "tnum"
  figure:
    fontFamily: "Barlow Condensed, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1
    fontFeature: "tnum"
  board-title:
    fontFamily: "Barlow Condensed, sans-serif"
    fontSize: "19px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.02em"
  status-word:
    fontFamily: "Barlow Condensed, sans-serif"
    fontSize: "15px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.08em"
  status-word-strip:
    fontFamily: "Barlow Condensed, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.08em"
  stage-word:
    fontFamily: "Barlow Condensed, sans-serif"
    fontSize: "13px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.08em"
  due:
    fontFamily: "Barlow Condensed, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    letterSpacing: "0.02em"
  label:
    fontFamily: "Barlow Condensed, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    letterSpacing: "0.14em"
  chip:
    fontFamily: "Barlow Condensed, sans-serif"
    fontSize: "11px"
    fontWeight: 700
    letterSpacing: "0.1em"
rounded:
  chip: "4px"
  control-sm: "5.6px"
  control: "7px"
  surface: "9.8px"
  pill: "9999px"
spacing:
  hairline: "1px"
  row-pad-y: "7px"
  stack: "14px"
  card-x: "16px"
  board-x: "18px"
  panel-x: "20px"
  column-gap: "20px"
  page-y: "20px"
  page-x: "24px"
  label-row: "28px"
  board-row: "44px"
  title-row: "44px"
  boarding-row: "56px"
  person-row: "60px"
  strip-row: "64px"
  queue-width: "340px"
  today-rail: "384px"
  form-measure: "640px"
components:
  button-primary:
    backgroundColor: "{colors.lime}"
    textColor: "{colors.on-lime}"
    rounded: "{rounded.control}"
    height: "32px"
    padding: "0 10px"
  button-primary-lg:
    backgroundColor: "{colors.lime}"
    textColor: "{colors.on-lime}"
    rounded: "{rounded.control}"
    height: "36px"
    padding: "0 14px"
  button-outline:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "32px"
    padding: "0 10px"
  button-link:
    textColor: "{colors.lime-ink}"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.surface}"
  card-title-row:
    typography: "{typography.title}"
    height: "{spacing.title-row}"
    padding: "8px 16px"
  board:
    backgroundColor: "{colors.board}"
    textColor: "{colors.board-foreground}"
    rounded: "{rounded.surface}"
  board-row:
    height: "{spacing.board-row}"
    padding: "0 18px"
  board-row-boarding:
    backgroundColor: "{colors.lime}"
    textColor: "{colors.on-lime}"
    height: "{spacing.boarding-row}"
  board-strip:
    backgroundColor: "{colors.board}"
    textColor: "{colors.board-foreground}"
    rounded: "{rounded.surface}"
    height: "{spacing.strip-row}"
    padding: "8px 16px"
  outcome-panel:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.surface}"
  outcome-choice:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "64px"
    padding: "12px 16px"
  outcome-choice-won:
    backgroundColor: "{colors.lime}"
    textColor: "{colors.on-lime}"
    rounded: "{rounded.control}"
    height: "64px"
    padding: "12px 16px"
  step-chip:
    backgroundColor: "{colors.lime}"
    textColor: "{colors.on-lime}"
    typography: "{typography.chip}"
    rounded: "{rounded.chip}"
    height: "20px"
    padding: "0 6px"
  stage-chip:
    typography: "{typography.chip}"
    rounded: "{rounded.chip}"
    height: "20px"
    padding: "0 6px"
  task-row:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    padding: "7px 16px"
  count-badge-owed:
    backgroundColor: "{colors.warning}"
    textColor: "{colors.on-lime}"
    rounded: "{rounded.pill}"
    height: "18px"
    padding: "0 7px"
  book-panel:
    backgroundColor: "{colors.board}"
    textColor: "{colors.board-foreground}"
    rounded: "{rounded.surface}"
    padding: "14px 18px"
  book-panel-cash:
    textColor: "{colors.lime}"
    typography: "{typography.figure-money}"
  open-deal-row:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    height: "48px"
    padding: "8px 16px"
  no-next-step-flag:
    backgroundColor: "{colors.warning-surface}"
    textColor: "{colors.warning-ink}"
    rounded: "{rounded.chip}"
    height: "20px"
    padding: "0 6px"
  lookup-row:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    height: "{spacing.board-row}"
  person-strip:
    backgroundColor: "{colors.board}"
    textColor: "{colors.board-foreground}"
    rounded: "{rounded.surface}"
    height: "{spacing.strip-row}"
    padding: "8px 18px"
  timeline-row:
    typography: "{typography.body-meta}"
    padding: "5px 16px"
  deal-modal:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.surface}"
    width: "672px"
  deal-modal-section-title:
    typography: "{typography.title}"
    height: "{spacing.title-row}"
    padding: "8px 20px"
  page-band:
    backgroundColor: "{colors.board}"
    textColor: "{colors.board-foreground}"
    rounded: "{rounded.surface}"
    padding: "16px 18px"
  page-band-search:
    backgroundColor: "{colors.board-raised}"
    textColor: "{colors.board-foreground}"
    rounded: "{rounded.control}"
    height: "44px"
    padding: "0 14px"
  person-row:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    height: "{spacing.person-row}"
    padding: "0 18px"
  input:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "32px"
    padding: "4px 10px"
  range-picker:
    backgroundColor: "{colors.board-raised}"
    textColor: "{colors.board-muted}"
    rounded: "{rounded.control}"
    height: "34px"
    padding: "0 12px"
  range-picker-active:
    backgroundColor: "{colors.board-foreground}"
    textColor: "{colors.board}"
    rounded: "{rounded.control-sm}"
  ranking-leader:
    typography: "{typography.figure-xl}"
    padding: "14px 16px"
  ranking-row:
    padding: "7px 16px"
  post-thumbnail:
    backgroundColor: "{colors.muted-fill}"
    rounded: "{rounded.control}"
    size: "44px"
---

# Design System: Magnus CRM

## Overview

**Creative North Star: "The Departures Board"**

The closer's day reads like an airport departures board set inside a calm, ordinary CRM. One navy surface carries what is moving: today's calls, or the single call or task the page is about, each with one condensed status word that changes in place (On time, Boarding, Not recorded, Held; Due 4:15 PM, Due now, Overdue, Done). Around it the CRM stays quiet: cool paper ground, white cards divided by one-pixel rules, plain Barlow text. Lime marks the one thing to do next. When a page has no next action, it has no lime.

Density is that of a second screen beside a live video call. Rows are 44px, card title rows 44 to 46px, text 14px with 13px meta lines, and every number sits in Barlow Condensed with tabular figures so times and amounts line up down a column. The navy shell and lime are the brand speaking loudly, as PRODUCT.md commits. On the paper, lime is not decoration; it is the button.

The world was built and reviewed on five closer surfaces: Today (`app/workspace/closer/page.tsx`), the meeting page, the task page, My Pipeline, and the person page with its deal modal. Leads & Customers, New side deal and Profile followed, shared by closers and admins. Overview (`app/workspace/page.tsx`), the admin home, carried the world to the admin side as a floor report, and its date range picker became the dashboards' shared one. The rest of the app has not migrated yet (see Migration Status at the end).

**Key Characteristics:**
- Navy is a surface, not an accent: the sidebar shell, the Today board, the page strips and the page band.
- One status word per row, condensed, uppercase and coloured by meaning. It changes in place and never moves to a badge somewhere else.
- Lime is reserved for the next action and primary buttons, always with navy text on it.
- White cards with 1px rules and a 44px title row; rows ruled, never zebra-striped.
- Barlow for words; Barlow Condensed for times, status words, figures, labels and chips.
- Flat surfaces. Depth comes from tone (navy, white, paper), not shadow.

## Colors

A navy and lime brand pair on a cool grey paper, with a five-colour stage scale and two urgency colours (amber for owed, red for lost or overdue).

### Primary
- **Magnus Lime** (lime): the next action and nothing else on the paper. On navy it also sets the book panel's cash figure and the person strip's CUSTOMER word; nothing else on a board is lime text. The page band's primary button is lime, and the active directory tab carries a 2px lime underline. Primary buttons, Set next step on a deal with none, the one lime action in an opened deal row, the Boarding row, the Won choice, the outcome panel's 2px border and its step chip, the Call or Text button on an open task, the open task's inset marker in the queue. In the navy shell it is identity: the mark, the active nav item's tint and icon. It is also the text selection colour, the 6px Live dot of the freshness line, and the one "Show this range" button in the date range picker's calendar. Lime is a fill only; never set lime text on white.
- **Navy on Lime** (on-lime): the only text colour on a lime fill (6.9:1).
- **Lime Ink** (lime-ink): lime as text on light surfaces (5.7:1 on white): link buttons, the caret, the light-theme focus ring. In dark it lifts to lime-ink-dark.

### Secondary
- **Magnus Navy** (navy-shell, board): the sidebar shell, the Today board and the page strips. Navy in both themes. Its raised tone (board-raised, shell-raised) is for buttons on the board and the shell's hover.
- **Board text** (board-foreground, board-muted): primary and secondary text on navy. Board rules are hairlines of board-line.
- **Board Danger** (board-danger): Overdue on navy, light enough to read on it.

### Tertiary: the stage scale
Each deal stage has a fill colour (bars, dots, track rings, 15% chip tints, the person timeline's 6px event dots) and an ink colour (text on light surfaces). Booked is blue, Held slate, Follow-up teal, Won lime, Lost red. Qualified borrows the Held slate. The scale is the only way a stage is coloured; the Deal card's track, the stage chip, the Performance bar and the board's held-call result all read from it.

### Urgency
- **Owed Amber** (warning, warning-ink, warning-surface): something the closer still owes. "Not recorded" on the board, "Due now" on the strip, the Needs outcome count, the sidebar's owed badge (amber fill, navy text). On My Pipeline amber covers two things the closer owes on an open deal: no next step, and a call that passed with no outcome recorded ("Not recorded"). On the book panel's bar, No next step is a hollow amber ring; Not recorded is solid amber under 30 days, dense amber hatching for 30–90 days and sparse hatching over 90 days, thinning as the calls go cold. The legend repeats those fills, and the panel's sentence and the programs table's Not recorded figures set their counts in amber. In the Open deals list, the "No next step" and "Not recorded" flags are amber ink on the amber surface, and a Not recorded row's age bar fills amber. On the person page it marks what the viewer owes on a deal: the strip's NO NEXT STEP and NOT RECORDED words, and the deal footer's "No next step" and "Not recorded" flags.
- **Lost Red** (danger, danger-ink): lost deals, no-shows, overdue tasks, the Lost choice's title and mark, the reason chip on a task row, section errors.

### Neutral
- **Cool Paper** (paper): the page ground, the band under a card's choices, task group headings.
- **Card White** (card): every card, the outcome panel, the queue column, the top bar.
- **Navy Ink** (ink) and **Slate Ink** (ink-muted): body text and secondary text. Slate ink measures 4.5:1 or better on paper and white.
- **Rule** (rule) and **Input Rule** (input-rule): the 1px dividers between rows and around cards; input borders.
- **Muted Fill** (muted-fill): hover rows, the secondary button, count pills.

### Dark theme: the re-tiering
Dark is not an inversion. The ground drops to near-black (paper-dark), cards sit one step up (card-dark), popovers one more (popover-dark). The shell drops below the ground's tier (navy-shell-dark) so the chrome recedes. The board goes the other way: board-dark is lighter than both ground and cards, with board-raised-dark above it and a 10% light ring around strips, so the board stays the strongest surface on the page. Lime stays the same; its ink, the stage inks, amber ink and danger ink all lift to light values made for a dark ground (the `-dark` tokens). Rules become 9% white.

### Named Rules
**The Next Action Rule.** On the paper, lime marks the next action and primary buttons only. A finished task's Call button loses its lime; a recorded outcome collapses to a one-line summary with no lime. If two things on a screen are lime, at most one is a button the closer should press now.

**The Navy Text Rule.** Text on lime is navy, always. Lime text on light surfaces uses lime ink.

**The One Scale Rule.** A deal stage is coloured only from the stage scale, in one form per surface: a condensed tinted chip, a track ring, a bar segment, or an ink word on navy.

**The Board Is Dark Rule.** The board and its strips are dark surfaces in both themes. Content on them uses the dark theme's inks (the Today board scopes the `dark` class onto itself so text, inks and focus rings come out right).

## Typography

**Body Font:** Barlow (400, 500, 600, 700), loaded through `next/font` as the app's sans.
**Figure and Label Font:** Barlow Condensed (500, 600, 700).
**Brand Font:** Aceh Light, for the Magnus wordmark in the shell only.
**Code Font:** JetBrains Mono, for links and identifiers to copy.

**Character:** Barlow is a plain, slightly industrial grotesque that keeps the CRM calm; its condensed cut gives the board its departures-board voice and lines numbers up in narrow columns.

### Hierarchy
- **Display** (600, 26px, 1.1, -0.01em): the page title ("Today") and, in Condensed at the same size, the clock beside it.
- **Headline** (600, 20px): the outcome question ("Did Ana show up?", "How did the call end?").
- **Title Strip** (600, 18px): the person's name in the board strip. It is the page's `h1` on the meeting, task and person pages, and the deal modal's title.
- **Title Choice** (600, 17px): an outcome choice's name; the task note (500, 17px, relaxed leading).
- **Title** (600, 15px): card titles in the 44px title row.
- **Body** (400, 14px): everything else. **Body Meta** (13px, slate ink or board-muted): the line under a name, card meta, captions, footers.
- **Figure XL** (Condensed 600, 32px, tabular): the Performance figures.
- **Figure Money** (Condensed 600, 30px, tabular): the book panel's figures (cash, won, the open count); other currencies beside the cash sit at 17px.
- **Figure Large** (Condensed 600, 26px, tabular): the strip's time or due time, the person strip's paid figure in the main currency (other currencies at 17px), the Boarding row's time; the phone number on the reach card at 28px.
- **Figure** (Condensed 600, 20px, tabular): a board row's time, with its AM/PM at 12px in board-muted.
- **Board Title** (Condensed 600, 19px, 0.02em): the board's own heading.
- **Status Word** (Condensed 700, 15px on the board, 17px in the strip, 0.08em, uppercase): one per row, coloured by meaning. The person strip sets two: the lifecycle stage and the next step.
- **Stage Word** (Condensed 700, 13px, 0.08em, uppercase): a deal's stage as a word in its stage ink, in open deal and lookup rows.
- **Due** (Condensed 600, 14px, 0.02em): a task row's due label, red when overdue. At 15px it is the person deal card's footer fact, and at 13px the timeline's date column.
- **Label** (Condensed 600, 11px, 0.14em, uppercase): column heads on the board and strip (TIME, PERSON, PROGRAM, GATE, STATUS; DUE, PERSON, DEAL, REACH BY, STATUS; PERSON, STAGE, PAID, NEXT STEP, REACH BY), day headings in the week board, task group headings ("OVERDUE · 2") and the sidebar's group label.
- **Chip** (Condensed 700, 11px, 0.1em, uppercase): stage chips, the step chip, a task's reason chip.

### Named Rules
**The Condensed Figures Rule.** Every time, count, amount, phone number and status word is set in Barlow Condensed with tabular numerals. Tables get tabular numerals from the base layer; elsewhere, add them.

**The Phone As Written Rule.** A phone number is shown through `formatPhone` (`lib/phone.ts`) wherever it appears (the directory row, the person strip, the person card): a North American number stored as bare digits reads "+1 500 555 9610"; a number already grouped keeps its grouping, and anything else shows as stored. Never regroup other countries' numbers by guess.

**The Labels Name Columns Rule.** The 11px condensed uppercase label names a column, a day or a group of rows, and it sits on the rule above the rows it heads. It never floats above a heading to restate what the heading says.

## Layout

The workspace is the navy sidebar plus a white 52px top bar holding the sidebar toggle, breadcrumbs and the wide "Search people and deals" field (256px, ⌘K). Page content sits in the `page-inset` on the paper: 24px by 20px from `sm`, 16px on phones, and 12px top and bottom on short screens.

- **Today:** up to 1500px wide. In a page container of `@4xl` (56rem) or wider, a two-column grid: the board and then Performance on the left, and a right rail with Needs outcome above Tasks, 20rem wide (24rem from `@6xl`). Gaps are 20px between columns and 14px between stacked cards. Narrower, it is one column in the order a closer works: calls, outcomes, tasks, performance.
- **Meeting page:** the strip spans the page; under it, from `@4xl`, a main column and a right rail of 20rem (24rem from `@6xl`), 20px apart, with 14px between cards. Narrower, the rail moves under the main column.
- **Task page:** the strip spans the pane; under it, a main column and a right rail of 20rem (22rem at the widest container), 18px apart, with 14px between cards.
- **Task queue:** from `lg` up, a 340px white queue runs the full height against the sidebar, with the task pane beside it. Below `lg` the queue moves into a left sheet opened from the pane.
- **My Pipeline:** up to 1500px wide, one column with 14px gaps: the title row with the month switcher, the book panel, Open deals, then All deals folded into a one-line card (the "All deals" title, a 13px slate line and an outline "Find a deal") that opens the lookup in its place. The lookup opens on its own when the URL carries `tab=`, `program=`, `q=`, `stage=` or `status=`. The month (`month=`) and the list's filter (`show=`, `age=`, `in=`) live in the URL too, written in place with `history.replaceState` so a change never navigates.
- **Person page:** up to 1500px wide, laid out so a person with one or two deals fits one screen. The person strip spans the column; under it, from `@4xl`, a main column (open deal cards, then Closed deals, then Booking answers and Timeline side by side) and a 360px right column holding the one person card, 18px apart, 14px between cards. Narrower, it is one column: strip, deals, booking answers, timeline, person card.
- **Leads & Customers:** up to 1500px wide, one column with 14px gaps (12px on short screens): the page band, then the results card. The page root is the container the rows fold by.
- **Overview:** up to 1500px wide, one column with 14px gaps (12px on short screens): the page band, any freshness alert, then the rankings and the lower pair. The page root is the container. From `@4xl` the three ranking cards sit side by side in equal thirds at equal heights (the grid stretches each card, and its footer sits at the bottom with `mt-auto`); narrower they stack. From `@5xl` Phone closers sits beside Top posts & reels at 1.35 to 1 fractions, each at its own height (`items-start`); narrower, Phone closers comes first. A range change keeps the old numbers dimmed (Kept Data While Reloading).
- **Lead Gen** (`/workspace/operations/lead-gen`, Operations › Lead Gen): up to 1500px wide, one column with 14px gaps (12px on short screens), the page root the container: the report band with its totals and source tabs, the snapshot job's status or the freshness alert under it, the Prospect conversion card, then Specialists and Top posts & reels side by side from `@5xl` (the rest and a 24rem posts column, each at its own height, `items-start`), Respark, and Raw submissions folded at the foot. Narrower, the posts card goes under Specialists. The skeleton (`lead-gen-admin-skeleton.tsx`, also `loading.tsx`) stands the band, the totals and tabs, the conversion strip and the pair at their real heights.
- **Sales calls** (`/workspace/operations/sales-calls`, Operations › Sales calls): up to 1500px wide, one column with 14px gaps (12px on short screens), the page root the container: the report band with figures, any validation line, freshness alert, health banner or snapshot job status under it, Phone closers full width, then Programs and Meetings side by side from `@5xl` at 1 to 1.1 fractions, each at its own height (`items-start`), and the "How these are counted" card last. Narrower, Programs comes before Meetings. While the business day rebuilds, one line stands in place of the sections and the band drops its figures. The skeleton (`sales-calls-page-skeleton.tsx`) draws the band with its five zones at the same column steps, Phone closers, and the pair.
- **No-shows & Cancellations** (`/workspace/operations/missed-meetings`, Operations › No-shows & Cancellations): up to 1500px wide, one column with 14px gaps (12px on short screens), the page root the container: a `PageBand` whose line is the range ("Last 30 days · Oct 7 – Nov 5") and one sentence, with the board-tone picker (opening on the last 30 business days as a custom range, synced to the URL once chosen) and a board-tone Export CSV on the right, and the band's tab row under them (ALL, NO-SHOWS, CANCELED with condensed counts, a 2px lime rule under the chosen one), in Billing's grammar. Below `@xl` the presets, an icon-only date button and an icon-only Export share one row, so the band stays under a third of a phone screen. Then one Deals card, its own container (`@container/missed`) and the tabs' panel: the title row holds "N · newest first" and the booked-again switch. Rows are one 44px line from `@3xl/missed`: WHEN ("Nov 5 · 11:15 AM"), PERSON (the name; the handle is the link's `title`), CONTACT (phone, then email), CLOSER, BOOKED BY (the setter, then the DM closer with their team's short name in slate) and STATUS. Narrower, two lines: the name and status, then when · phone in slate. The deal's source is only in the CSV. The page reads every kind and filters on the client, so the tabs' counts are exact; a new range or the switch keeps the last complete list at 60% until the new one has every row. The footer shows only while loading or when the range passes the export cap.
- **Billing** (`/workspace/billing`): up to 1500px wide, one column with 14px gaps (12px on short screens), the page root the container: a `PageBand` with its one line, the board-tone Export CSV, and NEEDS REVIEW · REVIEWED · DISPUTED tabs with a condensed count each (the Needs review count in amber), written to `?status=` in place. Then one Payments card, its own container (`@container/payments`): the program and type filters and one Paid date pair (from – through) sit right of the title as 30px controls on one line from `@4xl/payments`, on their own rows below it. Rows are one 44px line: PAID (its head's `HelpTip` says dates follow the browser's time zone), CUSTOMER (the name, else the email or phone, nothing under it), PROGRAM, TYPE, AMOUNT, a narrow PROOF column with the file icon, the status word and a chevron. Below `@4xl/payments` program and type share one cell ("Program · type"), and below `@2xl/payments` a row is two lines (name and amount, then paid · program · type and the proof icon with the status word). A new tab or filter keeps the last rows at 60%. **The payment page** (`/workspace/billing/<id>`) has the band with a back link, the customer's name, "Paid … · program · type", Copy payload and Correct payment as board-tone buttons, Mark reviewed in lime only while the payment needs review, and AMOUNT, STATUS, PROOF and CLOSER zones. Under it, from `@4xl`, a main column and a 24rem rail, 18px apart. The main column holds the fact cards in two columns from `@xl/facts` (Payment, with Reference, Recorded, Reviewed, Internal note and Payment ID, then Proof; beside them Customer and call, with name, email and phone ruled from the scheduled time and recording, then Attribution), then History. The rail holds Comments, then Slack contributors. Facts the band states (amount, type, program, paid time) aren't repeated in the cards. Fact rows use the dense grammar (a 110px slate label column, about 32px, groups ruled). Proof keeps the file's kind, size and Open proof in its title row over a thumbnail 160px tall that opens the full-size viewer. History and Slack contributors are dense ruled rows, one per event, with each change on its own before → after line. Narrower, one column: facts, Comments, History, Slack contributors.
- **Booking Reviews** (`/workspace/operations/booking-reviews`): the same column: a `PageBand` of the title and one line, then one ruled card whose meta counts the reviews ("9 open · 3 held · newest first"), of 44px rows that each link to their review: RECEIVED, INVITEE, WENT TO (the person the booking was added to, "—" when held), ALSO MATCHED, BY ("email, phone" in slate), the status word HELD in danger ink or DECIDE in amber ink, and a chevron; two lines below `@3xl`. One footer line shows only when more reviews can load or some names didn't load. **The review page** is one comparison. The band holds the status word right of the title, one subtitle line (received, call, event) and one or two short sentences saying whose each detail is. From `@4xl` a main column and a 20rem rail (24rem from `@6xl`) sit 18px apart. The main column is one card: a table with THIS BOOKING on a 40% muted fill, then a column per matched person (name, a 13px slate role, Open person, a slate MERGED marker), and 34px rows for Name, Email, Phone, Instagram, First seen and Deals (the count and the newest deal's stage word). A cell that matches the booking takes a check in ink, and says "Same" when it is exactly the booking's value; a cell that differs is slate with an `sr-only` "different"; an empty one is "—". Below `@2xl` of the card the table becomes a block per record with label and value rows, marks kept. Under the table, one fact line (their time, host, booked via), then a native `details` fold per person for deals and known identifiers, and Form answers. The rail asks "Same person?" in the Outcome Panel's grammar with one line per answer; a resolved review shows a small plain card, with no lime. Narrower, the rail follows the comparison.
- **Reports** (`/workspace/reports/*`: Team Performance, Revenue, Pipeline Health, Leads & Conversions, Activity Feed, Reminders, Slack Qualifications): up to 1500px wide, one column with 14px gaps (12px on short screens), the page root the container (`REPORT_PAGE` in `reports/_components/report-ui.tsx`). Each page is a `ReportBand`, the report band with figures: the title, the range in words, the freshness words and the day line from `@3xl`, the reports' own date controls in the board tone in the action slot (the five quick picks TODAY · THIS WEEK · THIS MONTH · LAST MONTH · LAST 90 DAYS, scrolling sideways below `@xl`, with an icon-only Custom range button), the page's figure zones (`FigureZone`, the book panel's grammar, worded zeros), and a board-line row of board-tone filter selects. The reporting database's alert sits under the band. Then ruled `ReportCard`s, each its own container, side by side from `@5xl` where both are short (`items-start`). Tables use the Phone Closers Table grammar and fold by their card before they stack; Team Performance's closers are one card with NEW CALLS · FOLLOW-UP CALLS tabs and fit 1440 with no sideways scroll. Ranked breakdowns are `BarList` rows (the Programs Card's bars). Caps, partial reads and scope notes are ruled `ReportNote` lines in the card they concern. Activity Feed rows are 44px lines (WHEN, WHO, WHAT, RECORD, STATUS) with one status word each. Each section keeps its last data at 60% while a new range loads, and shows its own skeleton, empty and error line.
- **New side deal and Profile:** a 640px measure centred in the page inset: the page band, then one ruled card, 14px apart.
- **Settings** (`/workspace/settings`): an 1100px measure, the page root the container, 14px gaps: a `PageBand` with one 13px line that points to Booking setup and Team (the tabs say what the page holds), with the tab row under it in the Team band's grammar (INTEGRATIONS, BUSINESS DAY, LEAD GEN, RESPARK; Respark only with `settings:manage`). A tab writes `?tab=` in place with `history.replaceState`; the legacy `?tab=calendly` opens Integrations and `#lead-gen-rules` opens Lead gen and scrolls to it. Integrations sets Calendly and Slack side by side from `@4xl` (`items-start`) with API keys full width under them, one column narrower; Integrations carries an amber count (red if one has failed) of integrations whose status word isn't CONNECTED. Each integration card has one status word in its title row, dense fact rows (a 110px slate label column, about 32px, groups ruled) and a 40px action row, lime only on Connect or Reconnect. Slack's channels are fact rows too: what goes there as the label ("Qualified leads", "Stale leads", "Lead gen", "Booking reviews", each with a `HelpTip`), the channel as the value, and any problem on a line under the value. The other tabs are one Form card each, its rows' descriptions moving beside the control from `@4xl`; the card's one standing note (the day's span, the Respark hold) sits in the footer beside Save, and a rebuild line shows above the footer only while it runs or after it fails. Save is lime only while there's an unsaved change. The skeleton (`settings-skeleton.tsx`, also `loading.tsx`) draws the band with tabs and the Integrations cards at their real heights.
- **Respark** (`/workspace/lead-gen/respark`, the setter's page): an 1100px measure, the page root the container, 14px gaps. **Start:** a `PageBand` with the title, one line, the lime "Get my batch" right of the title (none with no team; an empty pool keeps it, since the counts can lag and the claim decides) and three zones for today: BATCHES TODAY, ENTRIES TODAY, NOT A FIT TODAY. Under it the Next batch card: "25 people · held until 01:00" as meta (a `HelpTip` names the business day's end and time zone), a FILLS IN THIS ORDER label and five ruled 36px rows, each a bucket swatch, "1 · Qualified, never booked" and the count in 15px condensed (a zero in slate). Bucket swatches are categorical chart tokens in bucket order (blue, teal, ink, amber, slate; ink stands in for lime, which marks the next action), on the cards and the person sheet too. No team or an empty pool is one `SectionEmpty` line in the card. **Working a batch:** the band reads "Respark batch", "25 people · held until 01:00" and, when the read was capped, an "older history left out" `HelpTip`; the zones are WORKED ("7/25" over a 4px board-tone bar), ENTRIES, NOT A FIT, SKIPPED and TO GO (three a row on a phone, five from `@3xl`), and the keys sit right of the title as board-tone `Kbd` chips from `@3xl`. People stay in batch order. Worked people are one 40px ruled line each (the handle, the result in 13px slate, ENTRY in ink or NOT A FIT and SKIPPED in slate), consecutive ones sharing one card; a Not a fit inside its Undo window is a dashed 40px line with "Undo · 4s". Each open person is a white card, its own container (`@container/card`): a 44px title row (the handle as the button that opens the person sheet, Copy, the bucket word from `@md/card`, Open Instagram ↗ from `@2xl/card` and View from `@3xl/card`), then facts in the dense grammar (a 6rem slate label column, 28px rows: Stage, Captured, Qualified, Deal) beside LAST TOUCHES (up to three, the date in condensed slate) from `@xl/card`. From `@3xl/card` Resparked, Not a fit and Skip sit at the right end of the title row as 32px buttons, so a card is as tall as its facts; narrower they are one row of 36px buttons under the facts, and below `@xl/card` everything stacks. The card being worked takes a 3px inset ink bar on its left edge, and only its Resparked is lime; the others are outline. What a button does is its `title`. A blocked person shows one danger-ink line under the facts and only Skip and View. **Done:** the start band with "Get another batch", then one ruled line, "Batch done in 18 min · 14 entries · 3 not a fit · 8 skipped" with a My activity card link, above the Next batch card. **The person sheet** has the handle, the stage as a status word with the disposition and the bucket, then sections under 11px labels: Identity in dense facts, then Every touch, Deals and calls (attendance as a status word), Opener notes and Respark history as ruled 32px rows with a condensed slate date column. The skeleton (`lead-gen-respark-skeleton.tsx`, also `loading.tsx` and the page's own loading state) draws the start band with its zones and the Next batch card at their real heights.
- **Capture** (`/workspace/lead-gen/capture`, the setter's page): a 640px measure, the page root the container, 14px gaps. A `PageBand` with the title and one line, then TODAY, UNIQUE and DUPES as three zones in one ruled grid (an 11px condensed label with a `HelpTip`, a 26px condensed figure; TODAY's tip says how the business day runs), then INSTAGRAM and META BUSINESS as a tab list in the Team band's grammar over the capture cards. While the business day rebuilds, one board-muted line stands in place of the zones. On Instagram the Origin card comes first: while choosing, a 44px post or reel URL field, detected as it's pasted, then "Or pick one without a link" over four 32px outline buttons (Story poll, Story, Follower, Application; 2×2 below `@md`). Once chosen it is one 44px row: ORIGIN, the value ("Reel · C9x2AbQ" linked to the post, or the origin's name) and a ghost Change. Meta Business has no Origin card. The capture card holds the 44px Profile URL field (Handle with an @ for Meta Business) with the lime Capture beside it from `@md/capture`, full width under it narrower; before an origin is chosen both are disabled over "Pick an origin first." The last capture is one ruled line under the field: the status word (NEW and KNOWN in ink; DUPE, ALREADY SAVED and NOT A FIT in slate; DON'T CONTACT in danger ink), the handle as entered, the time in condensed slate, and the confirmation in 13px under them. Capture is the page's one lime. Today's list is My activity's; Capture doesn't repeat it. The skeleton (`lead-gen-capture-skeleton.tsx`, also `loading.tsx`) draws the band with its zones and tabs, the choosing Origin card and the capture card at their real heights.
- **My activity** (`/workspace/lead-gen/my-activity`): an 1100px measure, the page root the container, 14px gaps. A `PageBand` whose line is the range its figures cover, from the range the server read ("Today · Nov 5", the business day in its `HelpTip`; only the dates once a query still holds an earlier day), the freshness words and, from `@3xl`, "Your captures and worked resparks."; the board-tone picker in the action slot (today by default; below `@xl` the presets and an icon-only date button share one row); and RAW LEADS, RESPARKS, ENTRIES, NOT A FIT and LEADS/HR as zones, three a row on a phone (Leads/hr spanning two) and five from `@xl`, each with a `HelpTip` (Entries = raw leads + resparks; Leads/hr = raw leads ÷ scheduled hours, "—" with no schedule). The reporting database's alert sits under the band. Then one Submissions card, its own container (`@container/subs`), whose meta names the rows' own days only while they differ from the band's: one 36px line per row from `@3xl/subs`, WHEN ("Nov 5 · 11:15 AM", or the time alone when the range is one day, which the band names), PROSPECT (the @handle linked to the profile), WHAT (CAPTURE and RESPARKED in ink, NOT A FIT in slate), SOURCE and ORIGIN (truncated, the full value in its `title`); narrower, two lines: the handle and WHAT, then when · source · origin in slate. A footer with "Show 25 more" shows only when more can load. A new range keeps the last figures and rows at 60% until the new ones arrive. Empty is one `SectionEmpty` line naming the range ("Nothing captured today."); while the business day rebuilds, the zones drop and one line stands in place of the list. The skeleton (`lead-gen-activity-skeleton.tsx`, also `loading.tsx`) draws the band with five zones and the card's rows at their real heights.
- **Onboarding** (`/onboarding`, then `/onboarding/connect`): outside the workspace, in the `StandaloneShell` frame: the 52px navy bar named "Setup" with the theme toggle and, on the connect page while someone is signed in, a ghost Sign out in board-muted. Under it, one 560px column centred near the top of the paper (about 24px under the bar on a phone, 56px from `@2xl` of the frame), the column the container, 14px gaps. While something runs, one small ruled card holds a slate `Spinner` and one line ("Checking your invite…", "Opening sign-up for {company}…", "Setting up your account…"). An invite that can't be used, or a setup that can't continue, is one ruled card: a 44px title row with the page's `h1` ("This invite has expired") and one status word on the right (EXPIRED, INVALID, NOT FOUND and NO INVITE in danger ink, ALREADY USED in slate), one 14px line saying what to do, the company as a dense fact row when known, and a paper footer: the lime "Sign in to continue" for a used invite, otherwise an outline Sign in (Sign out when blocked while signed in, or a lime Sign in when signed out) beside a ghost Home. **Connect Calendly** is a `PageBand` ("Welcome, {company}" and one line, no action) over one Setup card: three 44px step rows (a slate number, or a check once done; the step; its 13px slate detail; the status word: DONE in slate, NEXT, CONNECTED and READY in ink, FAILED in danger ink, PLAN NEEDED in amber), the detail folding under the step below `@md` of the column; after a Calendly error, the code's message as one 13px line under the steps (amber for the plan, danger ink otherwise); "What Magnus reads from Calendly" as a label over three 32px rows; and a paper footer with "Needed to start the workspace." on the left until Calendly is connected and the page's one lime action on the right: Connect Calendly, Try again after a retryable error, Open workspace once connected, with an outline "See Calendly plans ↗" beside it after the plan error.
- **System admin** (`/admin`): in the `StandaloneShell` frame named "System admin" (theme toggle, a ghost Sign out in board inks), an 1100px measure, the page root the container, 14px gaps. A `PageBand` "Tenants" with one line, the lime "New tenant invite" (under the line on a phone) and status tabs (ALL, then each tenant status, scrolling sideways on a phone), with "14 tenants · newest first" or "25 shown · newest first" right of them from `@md`. After a create or New link, the invite link card: "Invite link for {company}", the expiry as meta, a read-only mono URL field that selects on focus and an outline Copy link. The tenants card is the tabs' panel, with no title row: from `@3xl` one 44px line, COMPANY, CONTACT, STATUS (amber while the company owes a step, danger ink for an expired invite or a lost connection, ink when active, slate otherwise), CREATED, INVITE ("expires Nov 9", "expired Nov 2" in danger ink, only while the invite is open), an outline New link and a ghost Delete in danger ink; two lines from `@lg`, three on a phone. Support requests is one card of about 60px rows: the subject and the sender (a `mailto:` name), the time and NEW in amber or REVIEWED and CLOSED in slate, then the message clamped to two lines with Show all. The create and delete dialogs use the correction dialog's frame; Delete names the company, says what happens as five ruled rows and asks for the name.
- **Public pages** (`/`, `/privacy`, `/support`): in the `StandaloneShell` frame through `PublicShell` (`components/public-shell.tsx`): the navy bar with no area name, the theme toggle and a ghost Sign in in board inks (none on the landing page, which sets its own). Under it, one 720px column near the top of the paper, the column the container, 14px gaps, and a 13px slate footer line at its foot ("Magnus CRM", then Privacy and Support, leaving out the page's own). **Landing:** while a signed-in visitor is routed to their workspace, one small ruled card with a slate `Spinner` and "Routing your workspace…". Signed out, a `PageBand` with the headline and one line, the page's one lime action "Sign in" and a board-tone outline "Create account" beside it (under the line on a phone); a "How it works" card of three 44px rows, each a slate condensed number and a step; and one 13px slate line about invites. **Privacy:** a `PageBand` ("Privacy policy" and the effective date) over one card of ruled sections (the intro paragraph first, untitled), each a 15px title and its 14px paragraphs in ink; the email in Contact is an ink link. No lime. **Support:** a `PageBand` ("Support", the reply time) over the Send a request form card in the Settings grammar (`SettingRow` rows, the two optional fields saying so, field errors as 13px danger lines, sent and failed as one 13px line above the footer) with the support email on the left of its paper footer and the lime "Send request" on the right, then "What to include" as three dense fact rows.
- **Deal modal:** centred, up to 672px wide and 88% of the viewport tall (56rem at most). The header stays fixed and the sections scroll under it. On a phone it fills the screen but for an 8px margin.
- **The board** answers to its own width (`@container/board`): the full table from `@3xl` (48rem), the table without Gate from `@xl` (36rem), with narrower Time and Program columns and Join beside the person on the Boarding row (in place of the call's length), and below that two-line rows with the time on the left and the status word on the right.
- **The meeting strip** is one row from `@4xl`, two rows from `@lg` (time, person and status; then the program under the person and the gate under the status), and below that stacked cells that each carry a condensed label. The task strip and the person strip still go straight from one row to stacked cells in narrow containers.

### Responsive rules

Pages and components respond to the space they get, not to the screen: a half-screen window, an open sidebar or a zoomed-in browser all shrink the space without changing the viewport the way `md`/`xl` expect.

- **Make the page root a container** (`@container` on the page's outer element) and lay the page out with `@4xl:` and `@6xl:`. Viewport breakpoints (`sm:`, `lg:`) are for the shell only: the page inset, the sidebar, the task queue.
- **Make any card whose inside changes shape a container too** (the board, the strip, the outcome panel, Performance, Needs outcome, the book panel, Open deals), so it reflows by its own width in either column. Name it (`@container/board`) when an inner container could catch the query by mistake.
- **Fold before you stack.** Between the full row and the phone stack, add a middle layout that drops the lowest-value column or puts two cells in one row. Stacked, labelled cells are for phones.
- **`short:`** (viewport height under 54rem: laptops, zoomed browsers) tightens vertical rhythm only: the page inset, page gaps and board row heights (44px to 40px, the Boarding row 56px to 48px). It never hides content.
- Skeletons use the same container steps as the page they stand in for.
- **Today's cards keep their height.** Needs outcome shows four calls and Tasks eight rows; "Show N more" adds the rest inside the same height and the list scrolls (`useExpandInPlace`), so a long list never pushes the page down. Until the list is scrolled to its end, a 28px "Scroll to the bottom to see more" strip sits along its bottom edge (`ScrollMoreHint`); clicking it scrolls to the end, and at the end it fades out. Tasks' footer also counts reminders due after today ("· 3 later") beside All tasks.

Rhythm: 16px inner padding on cards and rows, 18px on the board, 20px inside the outcome panel at medium widths. Rows: 28px label rows, 44px board rows, a 56px Boarding row, 64px strip rows, 26px task group headings, two-line task rows with 7px vertical padding. Interactive targets never drop below 24px: the extra-small button, shortcut pills and card links are 24px tall at least.

## Elevation & Depth

The system is flat. Depth comes from three tones: navy for what is moving, white for records, paper for ground. Cards carry a 1px rule, not a shadow. The two exceptions are functional: the active segment of a toggle group lifts by a 1px shadow, and the open task in the queue is marked by a 3px lime inset bar on its left edge. In dark, strips gain a 10% light ring because the board's tier, not a shadow, separates them.

### Shadow Vocabulary
- **Segment lift** (`box-shadow: 0 1px 2px rgb(20 26 40 / 0.12)`): the selected option of a segmented toggle (Performance's period control).
- **Queue marker** (`box-shadow: inset 3px 0 0 var(--color-primary)`): the open task's row in the queue, over a 10% lime tint.

### Named Rules
**The Tone Not Shadow Rule.** A surface stands out by being navy, white or lime, never by floating. No drop shadows on cards, strips or panels.

## Shapes

Gently rounded, never pill-shaped except for counts and dots. Surfaces (cards, the board, strips, the outcome panel, summaries) use a 9.8px radius; buttons, inputs, choices and tab lists use 7px; small buttons 5.6px; chips 4px. Counts, shortcut pills, status dots and track nodes are fully round. Rules are 1px; the outcome panel's border is the one 2px line, in lime. A dashed 1px border means "not yet": the note that the outcome opens five minutes before the call.

## Components

### Buttons
- **Shape:** gently rounded (7px), 32px default, 36px large, 28px small, 24px extra-small.
- **Primary:** lime fill, navy text, 14px medium (semibold where the surface asks). Hover drops the fill to 80%.
- **Outline:** paper fill, 1px rule, navy text; hover fills muted. On an open task, the way the task does not ask for (Text when it is a call) is outline.
- **Link:** lime-ink text, underline on hover. Card secondary links (Open deal, the person's page) are navy semibold with a 40% underline that darkens on hover.
- **On the board:** board-raised fill, board text, a 15% light border (Join, Open Zoom, copy link).
- **Focus:** a 3px ring at 50% of the ring colour (lime ink in light, lime in dark). Pressing nudges the button down 1px.

### Cards / Containers (`DetailCard`)
- **Corner Style:** 9.8px.
- **Background:** card white, 1px rule.
- **Title row:** 44px tall, 16px sides, a rule beneath; 15px semibold title, then an optional chip, then meta pushed right in 13px slate.
- **Footer row (`DetailCardFooter`):** 40px, a rule above, a fact on the left and a link on the right.
- **Padding:** 16px. Content rows run edge to edge with rules between them.

### Inputs / Fields
- **Style:** 32px, 7px radius, 1px input rule, transparent fill (8% light in dark).
- **Focus:** the border takes the ring colour with a 3px ring at 50%.
- **Error:** red border and a 20% red ring.

### Navigation
- **Shell:** navy sidebar (navy-shell; navy-shell-dark in dark) with the Magnus mark in lime and the Aceh wordmark. Items in light board-style text; the active item takes a 16% lime tint and a lime icon. The owed count sits beside its item as an amber pill with navy figures. The Reports group label uses the condensed label style at 60% opacity. The footer carries the signed-in identity.
- **Top bar:** white, 52px, a bottom rule, breadcrumbs, and the search field and the theme toggle on the right. Breadcrumbs stay on one line at every width: on phones only the parent and the page show, and the page truncates.
- **Command palette:** every role's pages carry the sidebar's names, order and ⌘1 to ⌘4 shortcuts, read from the same list (`app/workspace/_components/workspace-nav.ts`). An admin's palette also lists Operations, Team and Booking setup's pages under those names, the seven reports, Lead gen rules and Respark; everyone gets Profile.

### The Board Row (signature)
The departures board on Today: a navy surface with a 19px condensed title, a summary ("5 calls · 1 held · 4 to go"), and Today / Tomorrow / This week tabs. Columns are TIME, PERSON, PROGRAM, GATE, STATUS under 28px condensed labels; rows are 44px with board-line rules. The time is 20px condensed. Held and canceled rows dim to board-muted, and canceled times are struck through. The next or live call becomes the **Boarding row**: 56px, lime fill, navy text, a 26px time, the navy Join button in the Gate column and a 22px countdown ("12 min", "Live") after the status word. The whole row is the link to its meeting; its buttons sit above that link.

**Status words on the board:** Boarding (navy on lime), On time (board text), Not recorded (amber ink), Held (slate ink, followed by the deal's stage in its stage ink and the won amount), No-show (lost ink), Canceled (board-muted).

### The Board Strip (signature)
The meeting and task pages open with their record as one board row: a navy strip with 28px condensed column labels, then a 64px row. Meeting: TIME, PERSON, PROGRAM, GATE, STATUS. Task: DUE, PERSON, DEAL, REACH BY, STATUS. The time is 26px condensed with a 13px day line under it; the person is the page's `h1` at 18px; the status is a 17px condensed word with an 8px dot and a 13px detail line ("Starts in 12 min", "3 h past due"). The word changes in place:
- **Meeting:** On time (board text, slate dot), Boarding and In progress (lime word and dot), Not recorded (amber), Held (board text, slate dot), No-show and Canceled (board text, red dot).
- **Task:** Due 4:15 PM / Due Tomorrow (board text, blue dot), Due now (amber), Overdue (board danger), Done (board text, slate dot).

**The person strip** is the strip's sibling on the person page: PERSON, STAGE, PAID, NEXT STEP, REACH BY. The name is the `h1` with "Customer since Oct 25 · 3 deals" under it. STAGE is the lifecycle stage as a 17px condensed word in board text; lifecycle stages are not deal stages and never take the stage scale, and only CUSTOMER is lime. A disposition or "Inactive · 12 days" sits under it in board-muted (Do not contact in board danger). PAID is per currency: the main currency at 26px, each other currency beside it at 17px, then "N payments", or "Nothing paid". NEXT STEP is a word with an 8px dot, then a 13px line naming the deal:
- NO NEXT STEP and NOT RECORDED in amber when the viewer can act on that deal. Another closer's deal with no step reads NO NEXT STEP in board text, "deal of {closer}".
- CALL THU 4:30 PM or CALL BACK … in board text with a blue dot; a past-due task in board danger; LINK SENT with a slate dot; NO OPEN DEALS with a slate dot.

REACH BY holds the board buttons: Call with the number in 15px condensed, Text, and an icon button that copies the email.

### The Outcome Panel
The page's one next action, on the meeting and the task page. A white panel with a 2px lime border and a 9.8px radius. A step chip (lime, navy condensed "STEP 1 OF 2") sits beside a 20px question; a slate line under it states what recording does. The choices are 64px buttons (7px radius, a 32px round icon mark, a 17px title and a 13px consequence line) in a responsive grid. A paper band at the foot holds shortcuts or "Back to …".
- **Step 1:** "Did {first name} show up?" (meeting) or "Did you reach {first name}?" (task). The yes choice has a lime border on a 10% lime tint; the no choice is plain with a red mark. Step 1 writes nothing.
- **Step 2:** "Won · log payment" is the one lime-filled choice. Follow-up is plain with a teal mark. Lost is plain with a red mark and a red title.
- **Every choice states its consequence** before the dialog confirms it ("Closes the deal as lost, with a reason.").
- **Recorded:** the panel collapses to a one-line summary on a plain card: the stage chip, the outcome, a byline, and secondary buttons. No lime.
- **Not yet open:** a dashed card with a clock icon saying when recording opens.

### `DealCard` and the Stage Track
The track and the credit line are shared components, `DealStageTrack` and `DealCreditLine` (`app/workspace/_components/deal-stage-track.tsx`), used by the meeting page's Deal card, the person deal card and the deal modal. A `DetailCard` titled "Deal" with the stage chip beside the title and the program as meta. Under it, the stage track: one node per stage on the deal's own path (Qualified, Booked, Held, then Won; Follow-up inserted when it applies; Lost as the ending, or straight after Booked when a missed call closed it). Passed nodes are filled with the current stage's colour, the current node is a 3px ring of it on white, and later nodes are 40% slate rings. Connecting lines take the stage colour up to the current node. Labels are 11px condensed; the current one is in ink. Then a 13px credit line ("Lead gen **Ana** · Closer **Bo**") and a footer with first touch (or payments) and Open deal.

### Stage Chip
A 20px condensed chip, 4px radius, 11px bold uppercase, stage ink on a 15% stage tint (12% for Lost): BOOKED, HELD, FOLLOW-UP, WON, LOST: NO-SHOW.

### Ruled List Rows and the Task Row
Lists are rows inside a card, ruled by 1px lines, with no rule above the first. A row's primary text is a link stretched over the whole row; the row's own button sits above it. Hover fills 60% muted.

The **task row** has two lines: "**Name** · note" with the due label right-aligned in 14px condensed (red when overdue), then a 12px context line (program · stage), with an optional red condensed reason chip (NO-SHOW, CANCELED), and a 24px Call, Text or Copy link button on the right: lime when the task is overdue, outline otherwise. Groups are headed by 26px condensed labels on the paper ("OVERDUE · 2" in red ink; "TODAY", "LATER", "WAITING ON THE PERSON"). The open task in the queue gets the lime inset marker, a 10% lime tint, and no button.

### The Book Panel
My Pipeline's month and its whole open book on one navy panel (`book-panel.tsx`), the board's sibling for figures, with the 10% light ring in dark. It is its own container (`@container/book`). Zones are 14px by 18px inside (16px sides on a phone), split by board-line rules. Labels are 11px condensed; figures are 30px condensed with a 13px line under them at 75% board text.
- **Month:** Cash collected · {month} and Won · {month}. Cash is the main currency's total in lime; each other currency follows at 17px in board text with its own sum. The change line compares the same elapsed part of last month in the main currency, signed with a true minus ("−$2,000"); a fall reads in board danger. Then the payment count, or "No payments yet". Won is the count with "of N decided" under it.
- **Open book:** "Open deals" ("Open deals now" on a past month), the count, and the stage counts in 13px board-muted ("Booked 12 · Call held 3 · Follow-up 1"). Under them the state bar: 14px tall, a 3px radius, 2px gaps, one segment per state sized by its count: Ahead in board text at 70%, No next step, then Not recorded by age (Owed Amber gives the fills). Under the bar the legend names each segment with its swatch and a condensed count; Ahead and No next step always show, an age band only when it holds deals. Then one 13px sentence naming the oldest call: "N calls passed with no outcome recorded, the oldest on {day}.", the count in amber. With none owed it reads "N deals have no next step." or "Every open deal has a next step."
- **Programs:** a table headed Program, Open, Not recorded, Won, Cash, one ruled 28px row per program with its counts in 14px condensed (a zero in board-muted, Not recorded in amber above zero) and the month's cash in the program's own currency, "+N" for more currencies, a dash for none. Eight rows show, then "N more programs". Below `@md/book` the table drops Won and Cash, which the month zone already states.
- **Partial reads** add "(partial)" or a "+" to the figure, and "Your oldest open deals aren't counted." to the sentence. They are never hidden.

**Zones by width.** From `@5xl/book`, three zones side by side: month, open book, programs. From `@4xl/book`, the month and the open book side by side with the programs under both, at most 576px wide. Narrower, the zones stack, ruled between, and the month's two figures sit side by side.

**Every count is a filter.** Each legend item and each program row is a button with `aria-pressed` that filters Open deals below; pressing it again clears it. The selected one takes the board-raised fill, and while a state is chosen the bar's other segments drop to 35%. The bar's segments take a click too but sit outside the tab order and the accessibility tree: the bar is a pointer shortcut, the legend the keyboard path. A legend item with no deals is disabled.

**The Separate Currencies Rule.** Money is never added across currencies. Every currency keeps its own sum, on the book panel, in the programs table and in the lookup.

**The Main Currency Rule.** The main currency is the one with the most payments, never the one with the larger amount. Amounts in different currencies are never compared. A tie goes to last month's main currency, then US dollars.

### The Open Deal Row
The open book as one list on a ruled card (`open-deals.tsx`), its own container (`@container/deals`). The book panel and the card's controls set the same filter.
- **Header:** the 15px title "Open deals", a segmented toggle of All / Ahead / No next step / Not recorded with counts (the segment lift), the program select ("All programs" first), and, when the panel set an age, an outline chip naming it ("30–90 days") with a clear cross; all 30px, 7px radius, 13px. From `@2xl/deals` a 13px slate line on the right names the order: "By what's next", or "Oldest call first" on Not recorded.
- **Columns:** 28px condensed heads PERSON, DEAL, LAST ACTIVITY, NEXT STEP, then a 28px column for the chevron. Rows are at least 48px, 8px by 16px, ruled.
- **Person:** the 15px semibold name, a button stretched over the row that opens it, with the inset focus ring.
- **Deal:** the program with its stage word.
- **Last activity:** the business day in 15px condensed. A Not recorded deal shows the call's day instead ("Oct 9 call") with the amber "Not recorded" flag, and under them a 4px age bar, at most 144px wide, amber on muted and full at 120 days. Only Not recorded rows carry the bar.
- **Next step:** the next-step cell. A Not recorded deal shows the navy underlined Record outcome link to the call's meeting page; while its row is open, or when no meeting is linked, a slate dash.
- **Chevron:** slate, turning half a turn when the row opens.

**The order rule.** By what's next: Ahead deals by the step's time (calls and tasks, an overdue one first, then sent links), then No next step by the latest activity, then Not recorded with the oldest call first. A filter keeps this order; ties go by name.

**A row opens in place.** One row opens at a time and tints 40% accent. Its details grow on a 200ms `grid-template-rows` transition (none with reduced motion) and stay mounted until the close finishes; the rest of the list stays put. While the deal loads, a skeleton stands at the loaded height, footer included. On a 30% muted fill, three columns from `@4xl/deals`: **Calls · N** (up to three, newest first: the day in 15px condensed, the time and length in 13px slate, the attendance word in its ink), **Reach by** (the phone in 15px condensed, the email, then the credit line in 13px slate with each name in ink), and **Note** (up to four lines, or "No note on this deal."). A ruled footer holds Open deal and Open task as card links and one lime button: Record outcome when a call passed with no result, else Set next step. A deal that is no longer the closer's says so in one line.

Twenty-five rows show, then a 40px footer reads "Showing N of M" with an outline "Show 25 more"; a new filter starts again at 25. A filter with no deals keeps one `SectionEmpty` line saying what is absent, with Clear filters.

**The folds.** From `@4xl/deals`, the five columns (1.15, 1.15, 1 and 1.25 fractions, then the chevron). From `@xl/deals`, the name, the deal and the chevron on the first line, last activity and the next step under them. Narrower, one column: the name with the chevron, then the deal, last activity and the next step.

### The Next-Step Cell
A deal's next step in plain 14px text (13px on narrow rows), in this order: an upcoming call ("Call Thu 4:30 PM"), else the open task ("Call back today 3:00 PM", with the time in red ink once past; "Reschedule link sent · Oct 27"), else the amber "No next step" flag, a 20px chip with amber ink on the amber surface. A call that passed with no result is never the step. It goes on its own 12px slate line under the step ("Oct 27 call, no result"), so it never truncates the step or the flag.

**The Business Day Rule.** A date without a time is the business day the instant falls on (the tenant's time zone and its day-start hour), never the calendar day, so the strip, deal cards, person card, timeline and deal modal agree with My Pipeline. Times of day stay in the tenant's time zone. The year shows only when it is not this year.

### `SetNextStepButton`
A small lime button with a calendar-plus icon, "Set next step", shared from `app/workspace/_components/set-next-step-button.tsx`. It opens the call-back or booking-link dialog (the admin version for an admin, who sets it for the deal's closer). It shows only where the server says the deal takes a step, so it is lime only on an open deal with none.

### The Person Deal Card
One `DetailCard` per deal, open deals first with the ones needing a step at the top, 14px apart. The title row holds the program name, the stage chip and, as meta, the closer ("Deal of {closer}" for another closer's deal), then a won deal's money in 14px condensed ink, each currency separately. Under it the shared `DealStageTrack` and `DealCreditLine`. The footer states one fact in condensed 15px (semibold, 0.02em, tabular) with its verb or lead word in medium slate: "**Call** Thu 4:30 PM", "**Call back** today 3:00 PM", "**Paid** $2,000 · Oct 29", or the lost reason in danger ink with its day. An open deal with no step shows the amber "No next step" flag; a passed call with no result shows the amber "Not recorded" flag, the call's day and a Record outcome link.

**Calls inside the card.** Under the credit line, 28px condensed heads (CALL · ATTENDANCE · LENGTH · NOTE) and up to three ruled 48px call rows, newest first: "Thu Jun 18" in condensed with the time in slate, the attendance word in its ink (amber "Not recorded" for a passed call still scheduled), the length, and the call's latest comment or "No note yet". A row links to its meeting page; "All N calls" opens the deal modal. A call with no result carries the lime Record outcome on its own row, and the footer then states the first touch instead of repeating it. The calls fold to two lines per call in a narrow card.

Actions sit right in the footer: the lime Set next step, then Open task and Open deal as card links. A card holds at most one lime button: Record outcome on a call row or Set next step in the footer. Another closer's deal shows the same summary with no actions and does not open.

**Closed deals collapse.** Only open deals get full cards. Won and lost deals sit in one "Closed deals" card under them, one ruled 44px row each: program, the condensed stage word in its ink, the closer, paid per currency or the loss reason in danger ink, and the day; the row opens the deal modal when the viewer may open the deal. When the person has no open deal, the newest closed deal keeps its full card.

### Booking Answers, Timeline and the Person Card
**Booking answers** and **Timeline** sit side by side under the deals from `@4xl`, equal in width, each at its own height. Booking answers are ruled rows, a 13px slate question over the answer; an answer that only repeats a phone, email or handle shown in the person card is left out. The title row names the booking ("Calendly · Jun 18").

**The person card** is the right column's only card, titled with the first name and "Lead · Open" or "Customer · Active" as meta. Dense rows (a 96px slate label column, about 32px each) in groups split by a rule: contact (phone in condensed, email truncated, handles); first and last touch; the DM portal facts when present; Stage with "since {day}" and the stage path on hover, then Disposition; programs with their status (the admin select); identifiers that add something; portal notes. Admins' Move back and Set disposition sit in its footer. "Inactive · N days" shows in the strip only.

**The timeline** is the person's history, newest first, one ruled 32px row per event: a 52px condensed date column, a 6px dot on the stage scale (lime for payments, enrolment and becoming a customer; red for no-shows, cancellations, losses and voided payments; blue for bookings; teal for follow-ups; slate otherwise), and a 13px sentence: the fact in medium, an amount as a 14px condensed figure, then " · {program}" in slate ("Payment recorded · $2,000", "No-show · TestProgram call Oct 10"). The title row counts the events. Ten rows show, then the footer's "Show older" adds ten more and keeps the shown rows while a bigger page loads.

### The Deal Modal
A deal opens in a centred modal, never a side sheet, and a `?opportunityId=` link opens it on page load; closing it removes the parameter. It is a card-white dialog with a 9.8px radius and a 10% ring, no shadow.
- **Header:** fixed, ruled beneath: the program as an 18px title with the stage chip beside it, a 13px line ("Created Oct 9 · Booked through Calendly"), and a ghost close button.
- **Track and credit:** the shared `DealStageTrack`, then the credit line with the Slack qualifier named when the deal came through Slack.
- **Next step** (open deals): the next-step cell at 15px beside the deal's actions: Record outcome and Open task as links, the lime Set next step. An open side deal's Record payment is lime only when Set next step is absent. Under it, a band at 50% muted fill holds the closing actions as outline buttons: "Fix the deal" for an admin (cancel task, mark lost, delete), "Close the deal" for a closer's side deal.
- **Sections:** ruled sections with a 44px title row and right-aligned meta, no card of their own: Lost reason (in danger ink), Calls with the count, Payments with the per-currency total (an outline Add payment on a won deal), Notes, and Details (the booked program beside the sold one when they differ, first booked, payment received, first and latest touch).
- **No activity feed.** History lives on the person page's timeline.

### The Lookup Table
"All deals" on a ruled card. On My Pipeline it sits folded behind "Find a deal" under Open deals until it is wanted (see Layout). The header row holds the title, a segmented toggle of All / Open / Won / Lost with counts, a program select and a person search (all 30px, 7px radius, 13px). The table has 32px condensed column heads (PERSON, PROGRAM, STAGE, LAST ACTIVITY, NEXT STEP, PAID) and 44px ruled rows. Last activity is in the due style, and Paid is right-aligned in 15px condensed. Below `md` it becomes two-line rows. The footer says "N deals" or "Showing N of M", names partial reads in words, and offers "Show N more". An empty result says what was searched and offers "Clear filters".

### `PageBand`
A page's header as a navy band, the strips' sibling (`app/workspace/_components/page-band.tsx`), used where a page has no strip: Leads & Customers, New side deal, Profile and Overview. A 9.8px board surface, 16px by 18px inside (14px by 16px in a narrow container), with the 10% light ring in dark; it scopes `dark` like the board. It holds the 26px display title as the page's `h1`, a 13px board-muted line under it saying what the page does, and an optional back link above the title (13px medium board-muted with a chevron, "Leads & Customers"). The page's one primary action sits right of the title as a lime button and wraps under it on a phone. Anything the page searches or filters by sits inside the band under the title.

**The directory band** fills that slot on Leads & Customers. The search field is the page's hero: 44px, board-raised fill, 7px radius, a 15% light border, a search icon and 16px text in board text, focused on load except on touch screens, `/` to return to it, Escape to clear; a `/` key hint shows until something is typed, then a clear button. Under a board-line rule that runs edge to edge, the lifecycle tabs (ALL, LEADS, CUSTOMERS, PROSPECTS) are 40px, 13px condensed semibold uppercase at 0.12em in board-muted; the active tab is board text over a 2px lime underline. Right of the tabs a 13px board-muted line says what the list shows: "Newest activity first" (hidden on phones), "Searching…", or "3 matches for “ana”".

### The Directory Row
Leads & Customers is one white ruled card of person rows (`person-row.tsx`), the tab's panel. A row reads left to right as who, their deal, what happens next and money, with no column heads:
- **Person:** the 15px semibold name as the row link; a 13px slate line with the phone in 14px condensed, then the email, else the handle.
- **Deal:** the person's current deal (the newest open deal, else the newest deal) as the program with its condensed stage word in stage ink; a 13px slate line "Your deal", "Deal of {closer}" or "No closer", plus "· +N open". "No deal yet" in slate when there is none.
- **Next step:** My Pipeline's resolver set as the person deal card's footer fact (verb in medium slate, then the 15px condensed figure). The amber "No next step" or "Not recorded · {day} call" flag only on a deal the viewer can act on; the same words in slate otherwise; "No open deal" for a closed deal. Under it, "Last activity {day}" in 13px slate.
- **Money:** right-aligned, the paid figure at 20px condensed, "Several currencies" in 13px slate when payments span currencies, or a slate dash when nothing is paid. Under it an 11px condensed lifecycle word: LEAD and PROSPECT in slate, CUSTOMER SINCE {DAY} in lime ink.

**The folds** (`person-row-grid.ts`, shared with the skeleton), by the page's width: from `@4xl` four columns (1.25, 1.2 and 1.1 fractions, then 10rem for money) on a 60px row with 18px sides; from `@xl` the person and money share the first line, with the deal and the next step side by side under them; narrower, the deal and the next step stack under the person while money stays at the right of the name. Rows are 10px top and bottom with 16px sides below `@4xl`.

A 40px footer counts what shows ("25 shown", "37 customers", "3 matches") with an outline "Show 25 more". No matches names what was searched, hints at a phone or email, and offers Clear search (and Search everyone on a narrower tab).

**The report band** fills it on Overview. The 13px line names what the numbers cover: the range in words in medium board text ("This week · Oct 27 – Nov 1", "Today · Nov 1", or a custom range's dates), then " · " and the freshness words ("● Live", "Data as of 2:31 PM", "Today live · earlier days as of 2:31 PM", with the lime Live dot only while today is live), then the business-day line ("Days run 1:00 am to 1:00 am, America/Tegucigalpa time"), hidden below `@3xl`. The shared date range picker sits in the action slot in its board tone and wraps under the title on a phone. When the reporting database is loading, queued, delayed or failed, its alert renders under the band, never inside it, and the band keeps the range words.

**The report band with totals** fills it on Lead Gen (`lead-gen-band.tsx`): the report band's title, range line and board-tone picker, with two zones under it, each under a board-line rule that runs edge to edge.
- **Totals** in the book panel's grammar: Submissions, Specialists active, Scheduled hours, Per scheduled hour. Each is an 11px condensed board-muted label, a 30px condensed figure and a 13px line at 75% board text saying what it counts ("Submissions ÷ scheduled hours"). Units ("h", "/h") are 13px medium board-muted Barlow; a range with no schedule reads "No schedule" in 15px medium board-muted. Two by two, ruled between, 12px by 16px (18px sides from `@lg`); four across from `@3xl`, ruled left. Before the first numbers arrive each figure is a pulsing 10% light bar; on a range or source change the zone dims to 60% (Kept Data While Reloading).
- **Source tabs and tools:** ALL SOURCES · INSTAGRAM · META BUSINESS in the directory band's tab style (40px, 13px condensed semibold uppercase at 0.12em, board-muted, the active one board text over a 2px lime underline), one radio group that filters the page, arrow keys moving the choice. On the right, Export and "Settings & schedules" as board buttons: 28px, 5.6px radius, 13px, board-raised fill, a 15% light border, a 10% light hover (and while the export menu is open). They wrap under the tabs in a narrow band.
- A range the picker rejects says why in board danger under the range line.

**The report band with figures** fills it on Sales calls (`sales-calls-page-client.tsx`, `sales-figures.tsx`). The 13px line is the report band's: the range words in medium board text, then the freshness words, then the business-day line from `@3xl`. The freshness words appear only once the live dashboard has loaded, and not while a snapshot job stands in for it, so the line never claims "Live" over numbers it hasn't got. The action slot holds the board-tone picker, a 34px board-tone currency select (14px condensed semibold, board-raised fill, 15% light border) only when the range has several currencies, and Export restyled as a board-tone band button. Under the title, a board-line rule runs edge to edge and five zones sit in one ruled grid (1px board-line gaps, board fill in each cell), 12px by 16px inside (18px sides from `@lg`):
- **The zones:** CALLS ("N canceled · N no-show"), SHOW RATE ("N of M past calls have a result", "(partial)" appended when the counts are a lower bound), CASH COLLECTED, CLOSE RATE ("N of M deals won") and AVERAGE SALE ("$X ÷ N payment sales"). Each is the book panel's grammar: an 11px condensed semibold label at 0.14em in board-muted, a 30px condensed semibold figure (line height 1.05) and a 13px proof line at 75% board text.
- **Money:** cash in the main currency (the one with the most payment sales; ties go to US dollars, then alphabetical) in lime, as on the book panel; each other currency follows on the same baseline at 17px condensed in board text, and the proof line counts each one ("12 payment sales in USD · 2 in EUR"). Average sale takes the same form with the main figure in board text. With no payments the cash proof reads "No payments yet", the average a dash over "No payment sales to average".
- **Columns by width:** two zones a row on a phone with Average sale spanning both, three from `@3xl` (Average sale spanning two), five across from `@5xl`.
- **Loading:** before the first numbers each zone holds a figure bone and a proof bone in board-raised; on a range change the zones dim to 60% (Kept Data While Reloading).

### The Date Range Picker
The dashboards' one range control (`DateRangePicker`, `app/workspace/_components/date-range-picker.tsx`). Overview and My activity set it in their bands; the Operations pages set it on the paper through `DashboardDateRangeFilter`, which stacks the picker, the business-day line (`DayDefinition`) and any validation message (12px danger) under one another, right-aligned from `sm`. The picker never carries the business-day line itself.
- **Presets:** a 34px segmented toggle, TODAY · THIS WEEK · THIS MONTH, 13px condensed semibold uppercase at 0.1em, a 7px track with 5px segments and 2px inset. **Board tone:** board-raised track with a 15% light border, board-muted words, a 10% light hover; the active segment is board-foreground with navy text. **Paper tone:** muted track, slate words; the active segment is card white with ink text and the segment lift.
- **Custom range:** a 34px outline button with a calendar icon, 13px "Custom range" until a range is chosen, then the range itself in 14px condensed semibold ("Oct 1 – Oct 31", years only outside this year). Chosen, it is pressed (`aria-pressed`) and takes the active segment's fill: board-foreground on the band, ink on the paper. On the board tone it overrides the outline variant's dark fills, since the band scopes `dark`.
- **The calendar:** a popover aligned to the button's end with `collisionPadding` 16 and a width of the viewport less 2rem at most, so it never runs off a phone. Two months side by side (one on a phone, with outside days shown). The range's ends are ink with paper text, not lime; the days between take the calendar's muted range fill. A ruled foot holds a 13px line that either names the draft range or says why it can't be shown (in slate), and the small lime "Show this range", disabled until the range is valid. It is the popover's one lime.

**The One Picker Rule.** A dashboard range is chosen with `DateRangePicker`, in its board tone on a band and its paper tone on the ground. Validation and business-day rules stay with the caller.

### The Ranking Card
Overview's three rankings (`overview-rankings.tsx`): Lead Gen, Top Qualifiers and Top DM Closers, each a `DetailCard` titled with the team and its unit as meta ("Submissions per scheduled hour"). Rates are per scheduled hour, one decimal, in condensed tabular figures with a 13px medium slate "/h".
- **The leader block:** rank 1 at full size when the rate reads at least 0.1/h at one decimal (0.05 or more): a 40px avatar, a 16px semibold name, a 13px slate meta line ("42 submissions · 6 h scheduled"; "DmTeam1 · 12 booked · 44 h scheduled"), and the rate at 32px condensed on the right, 14px by 16px inside. The rank is said to screen readers only.
- **Ruled rows:** everyone else, and rank 1 when it does not lead: a 1.125rem column with the rank in 15px condensed slate, the name in 14px medium over a 13px slate meta line, the rate at 17px condensed; 7px by 16px, ruled, no hover (rows do not link).
- **No schedule:** a person with no scheduled hours reads "No schedule" in 13px slate where the rate goes, and the meta drops the hours. Never "--" or 0.0.
- **Footer:** 40px, ruled above: the total in 13px slate with its figure in 15px condensed ink ("Total submissions 186"), and "Show all" as a card link on the right.
- **Show all** appears only on a full top five, since only a full one can have more behind it. It loads the whole ranking into the same card at the five-row height and scrolls it there (`useExpandInPlace`, with `ScrollMoreHint` along the bottom edge), so the rankings beside it keep their height; it then reads "Show top 5". The expanded list carries its own freshness line and skeleton while it loads from the reporting database.
- **Partial:** Top Qualifiers' Slack cap is one 13px ruled line above the rows: "**Partial.** This range hit the Slack event cap, so the ranking uses the events read."

**The Quiet Day Rule.** A ranking where nobody did anything (a zero total and no rate above zero) does not rank zeros: the card shows one `SectionEmpty` line and no footer. Empty lines name the range in words: "No submissions today.", "Nobody qualified this week.", "No bookings by DM closers in this range." (`rangePhrase`). No one is crowned on a quiet day; a leader block needs a rate that reads above 0.0.

### The Phone Closers Table
Booked-call outcomes per phone closer (`phone-closer-operations-section.tsx`), a `DetailCard` with "Show rate: held ÷ (held + no-show)" as meta, its own container (`@container/closers`).
- **Heads:** Label style (11px condensed, 0.14em, uppercase, slate), at least 28px, bottom-aligned and right-aligned over figures: PHONE CLOSER, BOOKED, HELD, NO-SHOW, REVIEW, SHOW RATE, NO-SHOW RATE. Two-word heads may break to two lines so all six figure columns fit a half-width card.
- **Rows:** ruled; the closer's name in semibold over the results line, "7 of 7 past calls have a result" in 13px slate ("(partial)" appended when attendance counts are partial). Figures are 15px condensed tabular, right-aligned; a zero No-show or Review is slate. Rates read "—" when nothing was held or missed.
- **Total row:** last, on a 40% muted fill, "Total" with its own results line, every figure in ink.
- **The fold:** below `@xl/closers` the table becomes a list of two-line rows: the name, then the counts in words ("**13** booked · **8** held · **1** no-show · **0** to review · **89%** show rate · **11%** no-show rate"), figures in condensed ink, words in 13px slate. The Total row keeps the muted fill and moves its results line under the counts.
- **Partial:** when attendance counts are partial, one 13px ruled line above the rows, in the table and the fold alike: "**Partial.** Too many calls in the last day to check every end time, so the past-call count is a lower bound." Help is always said on the page, never only in a hover `title`.
- **Empty:** "No calls booked with phone closers today." (or this week, or in this range).

**Ranked by revenue** on Sales calls (`phone-closers-card.tsx`): the same card, full width, with "Ranked by revenue in {currency} · Show rate: held ÷ (held + no-show)" as meta (on its own line in a narrow card). Rows rank by revenue in the table currency, then booked, then name.
- **Heads:** PHONE CLOSER, BOOKED, CANCELED, NO-SHOW, HELD, SHOW RATE, CLOSE RATE, PAYMENT SALES, REVENUE, AVG SALE. A zero Canceled, No-show, Payment sales or Revenue is slate; rates and averages read "—" with no base.
- **Proof line:** under each name, the results line and, when the closer has deals at a first held call, " · N of M deals won".
- **Total row:** the muted Total row sums the closers, so its proof line adds " · $X not credited to a closer" when the band's cash in that currency is larger than what closers were credited. The gap is said, never hidden.
- **Quiet closers:** closers with no calls, past calls, deals or payments in the range fold into one 40px footer line, "N more phone closers had no calls or payments this week", with a Show them card link (`aria-expanded`); shown, they join the end of the table and the line reads "The last N had no calls or payments this week" with Hide them. When every closer is quiet the card says "No calls or payments for phone closers this week." over the same footer.
- **Partial:** when attendance counts are partial, the same ruled "**Partial.**" line sits above the rows (`OverviewPartialNote`), the proof lines carry "(partial)" and the fold's counts line ends "counts partial".
- **The fold:** below `@3xl/closers` each closer is two lines, 10px by 16px: the semibold name with its revenue at 15px condensed on the right (slate at zero), then one short 13px slate counts line that keeps each part whole ("8 booked · 6 held · 75% show · 33% close · 2 sales"). Each row is a native disclosure (`details`, a chevron that turns 180°): open, it lists every table figure in a two-column fact list with dashed rules, then the results line with deals won. The Total keeps the muted fill and puts the uncredited amount on a third line.

### The Top Posts Row
Top posts & reels (`top-origins-overview-section.tsx`), a `DetailCard` with "By submissions" as meta: ruled rows, 8px by 16px, hover 60% muted. Each row: a 44px thumbnail (7px radius, muted fill, cover-cropped), the caption in semibold, truncated, as a link stretched over the row that opens the post in a new tab, a 13px slate line "@handle · Reel · Oct 21" (the year only outside the business day's year), and on the right the submissions in 20px condensed over "31 people" in 13px slate. Previews come from the stored Instagram previews (`convex/leadGen/originPreviews.ts`). A post without a ready preview falls back to the readable URL as its title, the link's host in place of the handle, no date, and a muted tile with a film (reel) or image icon in place of the thumbnail. Empty: "No submissions came from a post or reel today."

**By team** on Lead Gen (`top-posts-by-team.tsx`): the same rows (`TopPostsList`, exported from the Overview section) in a 24rem `DetailCard` with "N teams · by submissions" as meta, one team at a time. Team tabs sit under the title row on the white card: 40px, 13px condensed semibold uppercase at 0.12em in slate, the active team in ink over a 2px ink underline (lime stays off the paper), 18px apart, scrolling sideways without a scrollbar, arrow keys moving between them. The busiest team is chosen first and stays chosen until it drops out of the range; with one team the tabs go and the meta names it. Five rows show; the footer counts the team's submissions from posts and reels (the figure in 15px condensed ink) and "Show top 10" opens the rest in place at the same height (`useExpandInPlace`, `ScrollMoreHint`). A new team starts collapsed.

### The Conversion Strip
Lead Gen's lead card (`prospect-conversion-section.tsx`): a `DetailCard` titled "Prospect conversion" with its scope as meta ("People first captured this week · all sources"), its own container (`@container/conv`). Under the title row, one cell per stage, PROSPECTS, IN CONVERSATION, QUALIFIED, BOOKED, SHOWED, CUSTOMER, then a DEALS cell, in a grid ruled by 1px gaps. A stage cell is white, 12px by 16px: an 11px condensed slate label, a 30px condensed figure, a 13px slate line ("40% of prospects"; "First captured" under Prospects) and a 6px round share bar on a muted track, slate filled to the stage's share (3px at least above zero), ink and full under Prospects. The Deals cell sits on a 40% muted fill with no bar ("The capture was the person's first touch"). These are funnel stages, not deal stages: they never take the stage scale. Two cells per row, three from `@lg/conv`, six stages plus Deals (at 0.9 of a stage) from `@4xl/conv`; when the row is not full, Deals spans it.
- **By specialist** in the footer, a card link with a chevron (beside "N specialists captured someone this week"), opens the same counts per person in place on a 200ms `grid-template-rows` transition (none with reduced motion), and "Hide by specialist" closes it. From `@2xl/conv` it is a table: SPECIALIST with avatar and name, a column per stage (short heads, "IN CONV.") with the count in 15px condensed and its share of the row's prospects in 13px slate beside it, Deals, zeros in slate, then the Total row on a 40% muted fill. Narrower, each specialist is a two-line row with the counts in words ("**61** prospects · **28** in conversation · …").
- **Partial reads** sit above the strip as one ruled 13px line led by a medium "Partial." in ink. A range where nobody was first captured shows one `SectionEmpty` line ("Nobody was first captured today.").

### The Team-Grouped Table
Specialists on Lead Gen (`specialists-section.tsx`): a `DetailCard` titled "Specialists", "Grouped by team" as meta (adding "· the funnel counts every source" when one source is chosen), its own container (`@container/spec`).
- **Heads:** SPECIALIST, SUBMISSIONS, PER HOUR, PROSPECTS · QUALIFIED · CUSTOMERS, in the Label style, bottom-aligned, right over figures.
- **Team rows:** 28px on a 40% muted fill, the team in the Label style with its size ("SALES TEAM · 4 SPECIALISTS"), its submissions in 14px condensed and its rate. The busiest team comes first; No team goes last.
- **Person rows:** ruled; a 24px avatar, the name in medium (an 11px condensed bold INACTIVE in slate beside it when the specialist is inactive) over a 13px slate line ("36 h scheduled", or "No schedule"); submissions in 15px condensed; the rate per scheduled hour at two decimals with a 13px medium slate "/h", or "No schedule".
- **The funnel bar:** how far the specialist's first captures went, as three nested fills on one 8px by 96px round muted track: prospects in slate at 50%, qualified in slate, customers in ink, each against the busiest specialist's prospects so rows compare. Beside it the three counts in 14px condensed ("61 · 20 · 3", the dots in slate), said in words to screen readers. "No first captures" in 13px slate when there are none. The bar joins the conversion rows by specialist; the full counts stay in the Conversion Strip's By specialist table.
- **Total row:** last, on a 40% muted fill: "Total" with "N specialists" in 13px slate, the submissions and the overall rate.
- **The folds:** from `@xl/spec` all four columns; the bar itself from `@2xl/spec`, the counts alone below that. From `@md/spec` without the funnel column. Narrower, no heads: the rate rides the person's meta line ("36 h scheduled · 1.69/h") and each figure carries a 13px slate "submissions" under it.

### The Respark Table
Respark on Lead Gen (`respark-section.tsx`): a `DetailCard` with its definition as meta ("Entries = raw leads + resparks"), its own container (`@container/respark`). From `@2xl/respark` a fixed table: SPECIALIST (26%, avatar and name), RAW LEADS, RESPARKS, ENTRIES, NOT A FIT, NOT A FIT SHARE, RESPARKED, THEN BOOKED, figures in 15px condensed, a zero or an unavailable "—" in slate in every column. **The words fold:** narrower, each specialist is a two-line row, the name in semibold over the figures in words ("**12** raw leads · **3** resparks · …"), figures in condensed ink, words in 13px slate. Caps sit above the rows as ruled 13px notes led by a medium word ("Raw leads unavailable.", "Partial.") that say what is missing and what to do. The footer states the scopes and definitions in one 13px paragraph at 75ch. The Quiet Day Rule holds: when nobody captured, resparked or ruled anyone out, the card shows one `SectionEmpty` line ("No raw leads or resparks today.") and no footer.

### The Folded Audit Card
Raw submissions on Lead Gen (`raw-submissions-card.tsx`): every capture in the range, voided ones included, at the foot of the page and folded until it is wanted. Folded, it is a lone 44px title row (its rule dropped) with "Every capture in this range, voided ones included" as meta from `@xl` and an extra-small outline Show with a chevron; nothing loads until it opens. Opened, it loads 25 rows, the meta counts them, and a 40px footer reads "Showing N" or "All N shown" with an outline "Show more".
- **Columns** from `@4xl/raw`: SUBMITTED (the day in 15px condensed over the time in 13px slate), PROSPECT (the @handle as a link to the profile with an external-link icon, the raw handle under it when it differs), SPECIALIST (name over team), ORIGIN (the readable link, then "Instagram · Reel" in 13px slate, the submission key from `@6xl/raw`), STATUS, then the void action. Rows are ruled, top-aligned; narrower, each capture stacks in one row with the time right of the handle.
- **Status:** ACTIVE in 13px condensed bold slate at 0.08em; VOIDED in danger ink with its day and time, the reason on a 13px slate line. A voided row keeps its place on a 30% muted fill and loses its void action.
- **Void:** a ghost icon button in danger ink with a ban icon and a 10% red hover, which opens the void dialog and its consequence text.

### The Split Desk
Operations › Qualifications as one desk: the goal in a report band, then the setters and what they brought as two panes of one card, so whether the team is on goal, who got it there and what they brought read on one screen. There is no lime on the paper; the band's Live dot is the page's only lime. Reference implementation: `app/workspace/operations/qualifications/_components/`: `qualifications-page-client.tsx` (the page), `qualifications-goal-row.tsx` (the goal row and `BAND_BUTTON_CLASS`), `setters-pane.tsx`, `submissions-pane.tsx`, `qualifications-format.ts` and `qualifications-page-skeleton.tsx`.
- **The band:** a `PageBand` with the report band's range line. The action slot holds Schedules and Export as board-tone band buttons, then the picker in its board tone.
- **Board-tone band buttons** (`BAND_BUTTON_CLASS`): the outline button at 34px, 7px radius, 12px sides and 13px text, with a board-raised fill, board text, a 15% light border and a 10% light hover. It keeps the same fill in dark, because the band scopes `dark`. The shared Export menu (`OperationsReportExportMenu`) takes the same look through a `display: contents` wrapper that sets its button with descendant selectors, so no shared file changed.
- **The goal row** sits in the band's children slot, under a board-line rule that runs edge to edge. It reads left to right:
  - a TEAM GOAL label (label style, board-muted);
  - "29 of 70" in 30px condensed semibold, with "of 70" at 17px board-muted;
  - the percent at 26px condensed;
  - a 14px bar (3px radius, board-raised track, 2px gaps) with one segment per setter who has leads, alternating 80% and 55% board text, plus a 40% segment for leads that name no setter;
  - the quota words ("70 a day × 1 business day") in 13px board-muted, "Goal reached" in medium board text from 100%, and an Edit goal link (13px semibold board text, 40% underline).

  The bar is hidden from screen readers; a screen-reader line says "29 of 70 qualified, 41% of the team goal". While a setter is selected, its segment stays full and the others drop to 35% opacity (200ms). Past the goal, the bar scales to the count and a 2px goal marker in the board colour stands where the goal was. Below `@3xl` the bar takes its own line under the figures. **No goal:** "29 qualified · no goal set", with a board-tone "Set goal" button (pencil icon) pushed right.
- **The split card:** one `Card` with no padding and overflow hidden. From `@4xl` it is a grid with a 360px left pane (`minmax(16rem, 22.5rem)`) and the rest on the right, at a fixed height of `clamp(30rem, 100dvh − 18rem, 60rem)` so the desk fills the viewport under the band. Each pane is a column whose list scrolls on its own (`overscroll-contain`). Below `@4xl` the panes stack with a rule between them, and the left one is capped at 22rem and scrolls. Each pane opens with a 44px title row (15px semibold): the left one reads "Setters", with "Qualified · per scheduled hour" as meta.
- **Filter rows (left pane):** every row is an `aria-pressed` button, 10px by 16px, ruled, with a 60% muted hover. Pressed, it takes an 80% muted fill and a 3px inset ink bar on its left edge. "All setters" comes first, with the team total at 20px condensed and "4 of 6 setters qualified a lead" under it. Each setter row has a 24px avatar, the semibold name and the count at 20px condensed. Under the name, indented 34px, an 8px share bar (2px radius, 25% ink, 80% when pressed, scaled to the top setter) sits beside the rate line: "1.7/h" with the figure in 15px condensed ink, or "No schedule", then " · 4:44 PM" for the last event. Setters with no leads fold into one 13px slate line, "No leads from Ana, Bo", with the names in medium ink. A pressed setter with zero keeps its row and shows its zero. A setter the new range doesn't list stops filtering. Pressing the pressed row clears it. A setter and a stage never filter together: choosing one clears the other.
- **The right pane** is titled with the selection ("All setters" or the setter's name), over the meta line "N qualified · newest first" ("{Stage} only · newest first" under a stage filter). The search and the stage select sit together on the right, both 30px with 13px text. The search has an icon and the placeholder "Lead, handle or program", waits 300ms after typing, needs two characters, and Escape clears it. Below `@2xl` of the pane the pair takes the full width.
- **Ruled column rows:** label-style column heads at least 28px tall (QUALIFIED, LEAD, SETTER, PROGRAM, STAGE; SETTER only under All setters) over ruled rows at least 48px tall, with 8px by 16px padding:
  - the time in 15px condensed (the clock on today's business day; date and clock before it);
  - the lead's name in semibold over "handle · Platform" in 13px slate;
  - the setter with a small avatar;
  - the program, or "Unmapped" in slate;
  - the stage word in its stage ink, or NOT LINKED in condensed slate;
  - a chevron.

  Below `@2xl` of the pane a row folds to two lines: the name, then time · handle · setter · program, with the stage on the right. The whole row is a button with `aria-expanded` and `aria-controls`, and it opens in place: the details grow on a `grid-template-rows` 0fr→1fr transition (200ms ease-out), the chevron turns 180° and the open row takes a 40% accent fill. The details are `inert` while closed and stay mounted until the close finishes. They form a fact list on a 30% muted fill, with a 7.5rem slate label column, two columns from `@2xl` and three from `@5xl`: Qualified by, Qualified at, Result, Booked program, Sold program, First meeting, DM team, DM closer and Closer, with times in 15px condensed. Under them, a 40px ruled foot holds the Open deal and Open person card links.
- **Auto-fill:** the Convex queue query returns one row per page to bound each read, so the pane calls `loadMore` until it holds 25 rows or the query runs out. The 40px ruled footer reads "25 shown", plus " · loading more…" while filling or ", all loaded" when the query is exhausted. "Show 25 more" (outline, 28px) raises the target by 25. Search reads its own query and returns up to 50 matches ("50 matches, the first 50").
- **Kept rows:** a new filter keeps the last rows on screen at 60% (`aria-busy`) until its own fill reaches the target, rather than showing a list that grows a row at a time. The first load and "Show 25 more" fill in place. The page keeps its last dashboard by a content signature (the range and the data, serialized), not by object identity, so a source that hands back equal data as new objects can't reset it on every render. The band's range words name the kept range until the new one lands. Nothing is kept through a snapshot job or a failed read.
- **Failure:** when a read fails with nothing kept, each area says so in place of its skeleton: "Progress can't show until the report loads." under TEAM GOAL, then "Setters can't show until the report loads." and "Submissions can't show until the report loads." in 14px slate. The failure alert under the band says why.
- **Empty:** a `SectionEmpty` line that names the filter and the range ("Ana has no submissions today.", "No submissions match “ana” this week."), with Clear filters when anything is filtered, otherwise "Leads appear here as setters qualify them in Slack."
- **Loading:** the page skeleton draws the band, the goal row (in board-tone bones) and both panes at their real heights: 62px setter rows and 48px submission rows.

**The Filter Row Rule.** A row that filters the pane beside it is an `aria-pressed` button. Pressed, it shows an 80% muted fill and a 3px inset ink bar, never lime on the paper. Pressing it again clears the filter.

### Team Goal Rings and Pace
Booked Calls (`app/workspace/operations/booked-calls/`) reads each DM team against its own goal. **Team goals** is a `DetailCard` of ruled tiles, one per team: a 64px ring (7px stroke on a muted track) filled to the share of the goal, the percent in 17px condensed inside (the booked count when the team has no goal), then the team name, "**14** of 15", the pace word and a 13px slate basis line ("12 due by yesterday · 1 to go"). **Pace** (`lib/operations-reports/booking-pace.ts`) is measured against finished days only, so Today never reads behind: Goal met in lime (`stage-won`), Ahead and On pace in teal (`stage-follow-up`), Behind in amber (`warning`), Missed in red (`stage-lost` fill, `danger-ink` word), No goal in slate (`stage-held`). The pace colour is the only colour on the ring, the team's header dot and its closers' bars. **DM closers by team** ranks closers inside their team: a muted team header (dot, name, pace word, "21 of 20 booked"), then ranks restarting at 1, each row an avatar, name, hours line, a booked bar on one scale across all teams, and the per-hour rate. Closers with no team rank under "No team" with no pace word and no goal tile. **No DM closer:** bookings through a team's link that name no DM closer count toward the team (D9), so each team section ends with a dashed, 25% muted "No DM closer" row (a dashed avatar ring, a slate bar on the same scale) and, under it, one 13px line per UTM combination ("medium `masterclass` · campaign `ads` · source `dm_team_brian`", values in mono) with its count; the closers plus that row add up to the team's figure. The goal tile adds "**21** with no DM closer", and Bookings lists those bookings with "No DM closer (masterclass)" and a No DM closer filter.

### The Programs Card
Sales calls' programs (`programs-card.tsx`), a `DetailCard` titled "Programs" whose meta slot holds the view switch: Bars · Pie · Table, a 30px segmented toggle on the muted track (7px radius, 5px segments, 13px words in slate; the active segment card white with ink text and the segment lift). It is its own container (`@container/programs`). Bars and the pie measure revenue in the table currency, largest first.
- **Bars:** ruled rows, 8px by 16px: the program in medium ink over "N calls · N held · N payment sales" in 13px slate, an 8px bar (3px radius) at 75% ink on a muted track scaled to the largest program, and the measure at 15px condensed on the right (slate at zero). From `@lg/programs` the three sit on one line (a 13rem name column); narrower the bar takes its own line under them.
- **Pie:** a 176px donut in the chart tokens (`--chart-1` to `--chart-5`, card-coloured strokes between slices) beside its ruled legend from `@lg/programs`, above it narrower. Each legend row has a 10px swatch, the program, its share in 15px condensed slate and its measure in 15px condensed ink.
- **Table:** PROGRAM, CALLS, HELD, CLOSE RATE, PAYMENT SALES, REVENUE in the label-style heads, with "N of M deals won" under the program. Below `@lg/programs` Held and Payment sales drop, and a 13px slate line under the program carries them.
- **Measured by calls:** when no program has revenue in the range, bars and the pie measure calls instead, and a 13px ruled line above them says so: "No payments this week, so programs are measured by calls."
- There is no lime on the paper: bars are ink, the pie is categorical.

### Meetings That Open in Place
Sales calls' meeting list (`meetings-card.tsx`), a `DetailCard` titled "Meetings" with the count as meta ("25 meetings", "3 meetings found"). Under the title row, a ruled tool row: a 32px search field ("Search by name", a search icon, a clear button, Escape clears, 300ms wait, two characters to search) and a 32px "All phone closers" select, wrapping on a narrow card. The list is its own container (`@container/meetings`).
- **Rows:** ruled buttons with `aria-expanded` and `aria-controls`, 8px by 16px, 44px tall from `@2xl/meetings`, a 60% muted hover and an inset focus ring. From `@2xl/meetings`, one line: the lead's name in semibold, the phone closer in 13px slate, the day and time in 15px condensed (the time medium slate), the status word, a chevron. Below `@2xl/meetings`, two lines: the name, then "closer · day · time" in 13px slate, with the status word and chevron at the right across both lines.
- **The status word:** 13px condensed bold uppercase at 0.08em in its ink: Scheduled in ink, Held and Canceled in slate, No-show in danger ink, Not recorded in amber ink (`warning-ink`). The labels come from `status-config`; its palette colours are not used.
- **Opening:** the Split Desk's grammar. The details grow on a `grid-template-rows` 0fr→1fr transition (200ms, none under reduced motion), stay `inert` while closed, the chevron turns 180° and the open row takes a 40% accent fill. One row is open at a time. The details are a fact list on a 30% muted fill with a 6rem slate label column, two columns from `@2xl/meetings`: Scheduled (15px condensed, with its length in minutes), Phone closer, Deal stage (the stage chip), Booked for, Sold, DM team, DM closer and Setter, a slate dash for none. Under a rule, the Open deal and Open person card links.
- **Footer:** 40px, ruled: "Showing 25 meetings" with an outline "Show more", "All N meetings this week" once the list is exhausted, or "N meetings matching “ana”" while searching.
- **Empty:** a `SectionEmpty` line that names the filter and the range ("No meetings match “ana” today.", "No meetings for Bo Lin this week.", "No meetings in this range."), with Clear filters when anything is filtered.

### The Definitions Card
Sales calls ends with "How these are counted" (`definitions-card.tsx`), a `DetailCard` of ruled term rows in place of help-icon tooltips: the term in 13px semibold, the definition in 13px slate at 75ch at most, side by side from `@3xl` with a 9rem term column, stacked narrower. It defines every band figure and both tables, including why the closers' Total revenue can be lower than Cash collected.

**The Worded Zero Rule.** A figure with no base reads a dash, and its proof line says why in words: "No past calls yet", "No deals had a first held call", "No payments yet", "No payment sales to average". Never "0 of 0" or a bare zero rate.

### Form and Settings Cards
New side deal and Profile each sit in one ruled card on the 640px measure, under a `PageBand` with a back link.
- **Sections:** 44px title rows (15px semibold) with room on the right for a control or meta: the Existing / New segmented toggle (the segment lift), or "Optional" in slate.
- **Rows:** `Field` rows ruled between, 12px by 16px, with a 13px slate label in a 120px column beside the control from `@lg`, over it narrower. A row whose section title already names it drops its label to screen readers and takes the full width. Descriptions are 13px slate; errors are 13px danger ink. The phone input sets its figures in 15px condensed.
- **Footer:** a paper band, ruled above, with the outline Cancel and the lime submit on the right.
- **Profile** uses the person card's dense rows instead: a 96px slate label column, about 32px each, in groups split by a rule. The picture row carries the avatar with outline Upload or Replace and a ghost Remove.

### Action Dialogs
The dialogs behind the main actions (payment, lost, no-show, follow-up, the task outcomes, lifecycle, enrollment, void, delete, and the Team and Booking setup forms) share one frame, `app/workspace/_components/action-dialog.tsx`, the correction dialog's.
- **Frame:** a card-white `Dialog` with no padding. The header is ruled below: a 17px semibold title that names the record ("Close Ana García's deal as lost?", "Mark Priya Shah unavailable") and one 13px line under it.
- **Rows:** `FormRow` is the form card's `Field` row (12px by 16px, a 13px slate label in a 120px column from `@lg`, the description and a 13px danger-ink error under the control). The rows scroll inside the dialog when they run long. A submit failure is one ruled danger-ink line above them.
- **Footer:** the paper band, the outline Cancel (or Back) and the action on the right. The action says what happens ("Send invite", "Set reminder"). It is lime, or danger for what can't be undone.
- **Risky actions** (payment, lost, no-show, void, delete) follow the tenant delete dialog. The title names the record, and dense facts identify it where that helps. What happens comes next: one danger-ink header line for a single consequence, or ruled numbered steps in the order the server applies them. The danger action comes last. Payment dialogs validate the form first, then switch to a confirm step (amount, program, type, proof file, what happens) whose "Record $1,500.00 payment" is the only button that records.
- Shared bodies: `payment-dialog-form.tsx` (the four payment dialogs), `outcome-dialog-parts.tsx` (the four lost dialogs), `follow-up-dialog-parts.tsx` (the closer and admin follow-up dialogs and the task's try-again rows) and `team/_components/team-dialog-parts.tsx` (the role choices).

### Kept Data While Reloading
When a month, tab, filter or search changes, the section keeps its previous data at 60% opacity (a 200ms fade, `aria-busy`) until the new data arrives, instead of flashing a skeleton. Skeletons appear only on first load. The book panel, the lookup and the directory all follow this.

On Lead Gen each section keeps its own (`useKeptWhileLoading`): the band's totals, the conversion strip, Specialists, Top posts and Respark dim separately as their reports arrive, and the range phrase is kept with the data, so an empty line still names the range it was loaded for. Raw submissions pages instead of reloading.

On Sales calls the band's figures and the cards below dim together, and the kept dashboard keeps its own range, so the band's range words and every empty line still name the range the numbers came from until the new ones land.

### `SectionEmpty` and `SectionError`
Each section reports its own state in place, inside its card. **Empty:** one medium line saying what is absent ("No calls today."), with a slate hint when it helps ("Calls appear here as people book through Calendly."). **Error:** a red alert-circle icon and "Couldn't load {what}. Reload the page to try again." **Loading:** skeleton rows at the real row heights, labelled for screen readers.

## Do's and Don'ts

### Do:
- **Do** give each record one condensed status word and change it in place as time and outcomes move.
- **Do** put the page's next action in lime and only that: one lime button group, the Boarding row, or the outcome panel.
- **Do** set navy text on lime and use lime ink for lime-coloured text on light surfaces.
- **Do** colour deal stages from the stage scale only, in fill or ink as the surface needs, and use the `-dark` inks on the board.
- **Do** use amber for what the closer owes and red for what is lost or overdue.
- **Do** set times, counts, amounts, phone numbers and status words in Barlow Condensed with tabular figures.
- **Do** state a choice's consequence on the choice itself before it is confirmed.
- **Do** build cards as `DetailCard`: 44px title row, 1px rules, 16px padding, edge-to-edge ruled rows.
- **Do** make a list row's primary text a real link stretched over the row, with a visible inset focus ring.
- **Do** write copy with the person's first name or "the lead"; never assume pronouns.
- **Do** keep each currency's money separate and lead with the currency that has the most payments.
- **Do** keep the previous data on screen, dimmed, while a section reloads for new arguments.
- **Do** keep targets at 24px or more and every text pair at 4.5:1 in both themes.
- **Do** write dates as business days, with the year only outside this year.
- **Do** use the shared `DealStageTrack`, `DealCreditLine` and `SetNextStepButton` wherever a deal shows its stage, credit or missing step.
- **Do** head a page that has no strip with `PageBand`, and put its search and filters inside the band.
- **Do** choose a dashboard range with the shared `DateRangePicker`, and name the range in words in empty states ("today", "this week", "in this range").
- **Do** say a report's scope, caps and definitions in words inside its card (the meta, a ruled note above the rows, or the footer), never in a tooltip.

### Don't:
- **Don't** put a small uppercase label above a heading to restate it. Condensed labels name columns, days and groups only.
- **Don't** use lime as decoration on the paper, or leave a lime button on a finished record.
- **Don't** set lime text on white or paper.
- **Don't** show a deal's stage or a call's attendance as a raw palette badge (emerald, indigo, violet). Use the stage scale and the status word.
- **Don't** lift cards with drop shadows; separate surfaces by tone and rule.
- **Don't** lay out a record page as a grid of equal-weight cards with a row of peer action buttons. The question leads.
- **Don't** add, net or compare amounts across currencies, or choose the main currency by amount.
- **Don't** use amber on My Pipeline for anything but an open deal with no next step or a call that passed with no outcome recorded.
- **Don't** write he, she, his or her for a person in UI copy.

## Migration Status

The system above is complete on five closer surfaces (Today, the meeting page, the task page, My Pipeline, and the person page with its deal modal), on Leads & Customers, New side deal and Profile, on the admin Overview, and on the shell. Admins use the same person page and deal modal, as they use the meeting and task pages. My Pipeline (commit 56ce0ae) replaced the old stage-tab table; its `opportunities-table`, `pipeline-filters`, `time-period-filter` and `closer-empty-state` components were removed. My Pipeline's second design (Nov 2026) replaced the program cards and the money strip with the book panel and one Open deals list, and removed `program-card.tsx` and `money-strip.tsx`, after a real closer's book showed 298 of its 316 open deals with calls never recorded, as identical amber rows across six cards. The person page replaced the old header metrics, the grid of Programs, Opportunities, Meetings, Portal Notes, Payments and Timeline cards and the six-card rail; the right-hand Opportunity Detail sheet became the deal modal, and the `entity-*` section components and the sheet's body were removed. A second pass (the at-a-glance layout) put each deal's calls in its card, folded Source and Record into one person card and collapsed closed deals. Leads & Customers replaced the seven-column entity browser; its `entity-browser-results`, `entity-browser-results-loading`, `entity-browser-toolbar`, `entity-result-row`, `entity-result-mobile-card`, `entity-result-formatters` and `entity-ui-tooltips` components were removed. New side deal moved from `FormItem` to `Field` rows and Profile to the person card's dense rows, both under `PageBand`. Overview (Nov 2026) replaced the green-accent header with its ISO date, the three icon-tiled shadcn ranking cards with help tooltips and the two sideways-scrolling tables with `PageBand`, the Ranking Card, the Phone Closers Table and the Top Posts Row; it removed `lead-gen-overview-card`, `top-qualifiers-card`, `top-dm-closers-card`, `overview-expandable-leaderboard`, `overview-top-cards`, `phone-closer-operations-table` and `overview-scheduled-hours-label`, and the `stats-row`, `pipeline-summary` and `system-health` skeletons. The shared freshness line (`analytics-freshness.tsx`) now splits into words and an alert, and its Live dot moved from a raw emerald to lime (`bg-primary`) on every page that shows it. Operations › Qualifications (Nov 2026) is migrated to the Departures Board as the Split Desk: the goal moved into a `PageBand` with the board-tone picker and band buttons, and the setters and submissions became two panes of one card. It removed `setter-contributions-table` and `qualification-submissions-list`. Booked Calls and its Attribution page (Nov 2026) moved to `PageBand` with the team goal rings, closers ranked by team and an expanding Bookings list; Attribution's tabs moved into the band and its cards, tables and badges to `DetailCard`, ruled tables and status words. Booked Calls removed `dm-closer-contributions-table`. Sales calls (Nov 2026) moved its five figures into a `PageBand` as the report band with figures, ranked the Phone Closers Table by revenue with its quiet closers folded, and gave Programs and Meetings ruled `DetailCard`s, with a definitions card in place of help tooltips. It removed `sales-calls-stat-cards`, `per-program-stat-card`, `phone-closer-table` and `sales-calls-details-list`. The rest of the app predates it and is not part of the system yet. `.impeccable/audit/drift.md` and `.impeccable/audit/backlog.md` map that work:

- **Legacy status colours.** `lib/status-config.ts` still maps deal positions and meeting attendance to raw Tailwind palettes (cyan, blue, indigo, violet, emerald, orange, amber), and about 365 palette utilities in 42 files bypass the tokens. The `--status-*` aliases in `app/globals.css` point at the stage tokens only until that file moves over. The new surfaces read `status-config` for attendance logic and labels only, not colours.
- **Type scale.** About 50 page headers range from `text-base` to `text-5xl`, with 96 arbitrary text sizes and KPI figures in mono. `PageBand` is the header they move to.
- **Layout.** 216 arbitrary layout values, nested page padding and 59 card padding overrides.
- **Forms.** No form uses `FormItem` any more: the 25 action dialogs moved to `Field` rows in the Action Dialogs frame (Nov 2026), so `components/ui/form.tsx` has no users left.
- **Charts.** The chart tokens are now categorical (blue, teal, lime, amber, slate). The report pages read them through `report-ui.tsx`: categorical series in blue, teal, ink, amber, slate (ink stands in for lime on the paper), one measure in ink at 75%, and deal stages and call results from the stage scale. Chart modules elsewhere have not been reviewed against them.
- **Date range.** Lead Gen activity (My activity) no longer uses `DashboardDateRangeFilter`: the board-tone picker sits in its band, and the Operations pages set it in their bands too. The report pages still use their own `report-date-controls`, now styled as the picker's board tone with their browser-day behaviour unchanged, and move to the picker later; No-shows & Cancellations now sets the picker in its band.
- **Admin twins.** The admin meeting and task pages and the person page share these components; the other admin, report and settings screens have not been migrated.

**Lead Gen** (Operations › Lead Gen, Nov 2026) joined the system on Overview's skeleton: the old header with its green accent bar, "Lead Gen Ops" title and lime Settings button, the four icon-tiled summary cards with help tooltips, the free-floating source toggle with "Showing: …" and five shadcn table cards (two scrolling sideways) became the report band with totals and source tabs, the Conversion Strip, the Team-Grouped Table, Top posts by team, the Respark Table and the Folded Audit Card. It removed `lead-gen-summary-cards`, `lead-gen-filter-bar`, `top-origins-table`, `specialist-performance-table`, `prospect-conversion-table`, `respark-performance-table` and `raw-submissions-table`, and no longer uses `DashboardDateRangeFilter`: the picker sits in the band. Overview's `TopPostsList` is now exported (an optional label, the row's source widened to a string) so both pages share the Top Posts Row, and the void dialog's compact trigger moved from a red-filled button to a ghost icon button in danger ink.

**Settings** (Nov 2026) moved from the old 3xl header, shadcn Tabs and plain shadcn cards to a `PageBand` with the tab row, ruled integration cards with one status word each (CONNECTED in ink; NOT CONNECTED, NEEDS RECONNECT, PICK CHANNELS and NO WEBHOOK in amber ink; TOKEN EXPIRED, SYNC FAILED and CHANNEL ERROR in danger ink), and Form cards for the business day, lead gen capture rules and Respark. The Slack card's alert boxes became 13px lines under the channel they concern, the API keys table became ruled rows with condensed dates and a slate status word, and the channel picker moved from `FormItem` to `Field` rows. It removed `slack-integration-card-skeleton.tsx`.

**No-shows & Cancellations and Booking Reviews** (Operations, Nov 2026) were the last two Operations tabs in the old look. No-shows & Cancellations moved from the plain header, `ReportDateControls`, a kind select and a shadcn table to a `PageBand` with the board-tone picker and Export, four figure zones, and one Deals card of ruled column rows that fold before they stack, with NO-SHOW in danger ink and CANCELED in slate. Its range now runs on business-day boundaries. Booking Reviews moved from a shadcn table with badges to ruled link rows with one status word, and the review page from stacked shadcn cards, an alert and colored badges (emerald and amber palette borders) to a band with the summary, fact-list cards with condensed comparison chips and stage words, and a Decide panel in the Outcome Panel's grammar. The review page's merge, keep-separate, close and retry actions, their toasts and the confirm dialog are unchanged; `DealStageBadge` is no longer used there. A compact pass put the booking and its people in one comparison table and replaced `booking-review-cards.tsx` with `booking-review-compare.tsx`; the held review with three people went from about 1,600px to 720px at 1440.

**Billing** (Nov 2026) moved from the plain header, a five-select filter grid, a scrolling shadcn table with badges and a "Load more" button to a `PageBand` with status tabs and one ruled Payments card with one status word per row (NEEDS REVIEW in amber ink, REVIEWED in slate, DISPUTED in danger ink). The payment page's 5xl brand-font amount, raw emerald, amber and rose status dot and dashed definition grid became the band's figure zones and fact-list cards; the history and Slack timelines became ruled rows, and the correction dialog moved from `FormItem` to `Field` rows. `BillingUnavailable` and not-found are a band and one `SectionEmpty` line. It removed `billing-queue-table` and `billing-payment-summary`.

**Respark** (the setter's page, Nov 2026) moved from a plain header, bordered bucket rows in raw emerald, orange, blue and amber, a "Today:" caption and a centred "25 / 25" summary with three metric tiles to a `PageBand` with today's zones and the lime Get my batch, one ruled Next batch card in the chart tokens, and one done line. The batch's header with a lime progress bar and text key hints became the band with five zones, a board-tone bar and `Kbd` chips; its cards lost the `Alert`, the emerald Entry badge and the captions under the buttons, moved from `md:` breakpoints to the card's own container, and mark the card being worked with an ink bar instead of the default ring; worked people became ruled 40px lines that share a card. The person sheet's badges became status words and its rows dense facts and dated ruled rows. The batch logic is unchanged: the Not a fit Undo, the keys and their guards, focus moving to the next card and the in-flight guard. The fresh 25-person batch went from about 6,500px to 5,200px at 1440.

**Capture and My activity** (the setter's pages, Nov 2026) moved from plain headers, icon metric tiles, a free-floating source toggle, outline badges and a shadcn table to a `PageBand` each with figure zones. On Capture the `DayDefinition` line moved into TODAY's `HelpTip`, the source toggle became band tabs, the captioned Instagram origin box became the Origin card that collapses to one row once chosen, the capture form now shows (disabled) before an origin is chosen instead of hiding, and the last capture's box with its Duplicate, Unique and Retry Ignored badges became one ruled line led by a status word; `captureConfirmation` moved to `lib/lead-gen/` and now returns a `kind` for that word, with its own tests. On My activity the picker left `DashboardDateRangeFilter` for the band, the five tiles became zones ("N/A" now "—"), and the table with its Respark pool badges became ruled rows that fold to two lines. The capture flow is unchanged: the origin reducer, Enter and refocus, the keyed submission, the toasts and the business-day skips.

**Onboarding** (Nov 2026) moved from a dot-grid canvas with a "MAGNUS CRM" header and a "Secured by WorkOS" footer to `StandaloneShell`, and from centred shadcn cards floating mid-screen to one 560px column near the top. The pulsing lime dots became a slate spinner in a one-line card. The invite errors lost their red top border, icon tiles, uppercase detail line and two stacked full-width buttons for a title row with one status word, one line, a company fact and a footer. The connect card's initial avatar, lime top border, tinted Connected, error and Already Linked boxes and icon-tiled permission rows became a `PageBand`, three step rows with status words, one error line and three plain rows; its outline Sign out moved to the bar. It removed `PulsingDots`. The token handling, redirects, sign-up and sign-in URLs, the redeem call and its guards, and the Calendly error codes are unchanged.

**System admin** (Nov 2026) moved from a dot-grid canvas with a "MAGNUS CRM" header, an uppercase SYSTEM ADMIN over "Tenant Control Console", four stat tiles and two shadcn tables with badges to `StandaloneShell`, a `PageBand` with status tabs in place of the status select, and ruled one-line rows with one status word each. The stat tiles were dropped: they counted only the loaded page, and the tabs filter by status. The tinted invite banner with its tenant id became the invite link card, which now names the company; the support table's wrapped five columns became two-line rows whose message opens in place. The delete dialog lost its icon tile, tinted warning box and badge for dense facts and five ruled steps, and its toasts now name the company. It removed `invite-banner`, `support-tickets-section` and `tenantStatusConfig` from `lib/status-config.ts`. Every server call, the system admin guard, the type-to-confirm delete, the validation rules, the error toasts and PostHog identify are unchanged; at 1440 the main page went from about 1,980px to 1,390px.

**Public pages** (Nov 2026): the landing, privacy and support pages moved from a dot-grid canvas with their own "MAGNUS CRM" headers to `StandaloneShell` through a new `PublicShell`. The landing hero's large wordmark, Title Case headline, numbered lime circles, slide-in animations and three competing buttons (outline Sign In, lime Create Account, lime Get Started) became a `PageBand` with one lime Sign in, a ruled steps card and one line. Privacy's 5xl heading and lime "Effective" label became a band; the policy text is unchanged. Support's life-buoy tile, the email said three times, three "What to include" cards, the Basics section and the two-column form with tinted alerts became a band, one form card with the email once in its footer, and three fact rows. The form's fields, honeypot, validation, submit call and feedback are unchanged; the form now sets `noValidate` so its own messages show instead of the browser's. It removed `lib/dot-grid.ts` and the `--dot-grid` token, which nothing else used. At 1440 privacy went from 1,976px to 1,764px and support from 1,496px to 989px.

**Reports** (the seven admin report pages, Nov 2026) moved from plain headers, a row of outline quick-pick buttons over a `DayDefinition` line, icon-tiled `StatsCard`s and shadcn KPI cards, stacked shadcn cards with long descriptions, `Alert` notices, sideways-scrolling shadcn tables, badges and palette-coloured charts to a `ReportBand` with figure zones and filters, ruled `ReportCard`s, `BarList` rows, ruled tables and `ReportNote` lines. Activity Feed's rows no longer take colours from `lib/status-config`: each carries one status word coloured by meaning. Reminders' amber truncation alert became a Capped. note, and its outcome cards and funnel, which repeated each other, became one outcomes strip. Every report-engine call, PostHog event, page title and filter is unchanged. It removed `stats-card`, the per-page KPI card, chart and skeleton components, and `status-badge` from the Pipeline Health list. At 1440 Team Performance went from 3,234px tall and 1,587px wide to 1,453px, and Revenue from 4,060px to 2,507px.
