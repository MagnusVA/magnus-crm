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
  money-strip:
    backgroundColor: "{colors.board}"
    textColor: "{colors.board-foreground}"
    rounded: "{rounded.surface}"
    padding: "14px 18px"
  money-strip-cash:
    textColor: "{colors.lime}"
    typography: "{typography.figure-money}"
  program-card-row:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    height: "40px"
    padding: "6px 16px"
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
---

# Design System: Magnus CRM

## Overview

**Creative North Star: "The Departures Board"**

The closer's day reads like an airport departures board set inside a calm, ordinary CRM. One navy surface carries what is moving: today's calls, or the single call or task the page is about, each with one condensed status word that changes in place (On time, Boarding, Not recorded, Held; Due 4:15 PM, Due now, Overdue, Done). Around it the CRM stays quiet: cool paper ground, white cards divided by one-pixel rules, plain Barlow text. Lime marks the one thing to do next. When a page has no next action, it has no lime.

Density is that of a second screen beside a live video call. Rows are 44px, card title rows 44 to 46px, text 14px with 13px meta lines, and every number sits in Barlow Condensed with tabular figures so times and amounts line up down a column. The navy shell and lime are the brand speaking loudly, as PRODUCT.md commits. On the paper, lime is not decoration; it is the button.

The world was built and reviewed on five closer surfaces: Today (`app/workspace/closer/page.tsx`), the meeting page, the task page, My Pipeline, and the person page with its deal modal. Leads & Customers, New side deal and Profile followed, shared by closers and admins. The rest of the app has not migrated yet (see Migration Status at the end).

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
- **Magnus Lime** (lime): the next action and nothing else on the paper. On navy it also sets the money strip's cash figure and the person strip's CUSTOMER word; nothing else on a board is lime text. The page band's primary button is lime, and the active directory tab carries a 2px lime underline. Primary buttons, Set next step on a deal with none, the Boarding row, the Won choice, the outcome panel's 2px border and its step chip, the Call or Text button on an open task, the open task's inset marker in the queue. In the navy shell it is identity: the mark, the active nav item's tint and icon. It is also the text selection colour. Lime is a fill only; never set lime text on white.
- **Navy on Lime** (on-lime): the only text colour on a lime fill (6.9:1).
- **Lime Ink** (lime-ink): lime as text on light surfaces (5.7:1 on white): link buttons, the caret, the light-theme focus ring. In dark it lifts to lime-ink-dark.

### Secondary
- **Magnus Navy** (navy-shell, board): the sidebar shell, the Today board and the page strips. Navy in both themes. Its raised tone (board-raised, shell-raised) is for buttons on the board and the shell's hover.
- **Board text** (board-foreground, board-muted): primary and secondary text on navy. Board rules are hairlines of board-line.
- **Board Danger** (board-danger): Overdue on navy, light enough to read on it.

### Tertiary: the stage scale
Each deal stage has a fill colour (bars, dots, track rings, 15% chip tints, the person timeline's 6px event dots) and an ink colour (text on light surfaces). Booked is blue, Held slate, Follow-up teal, Won lime, Lost red. Qualified borrows the Held slate. The scale is the only way a stage is coloured; the Deal card's track, the stage chip, the Performance bar and the board's held-call result all read from it.

### Urgency
- **Owed Amber** (warning, warning-ink, warning-surface): something the closer still owes. "Not recorded" on the board, "Due now" on the strip, the Needs outcome count, the sidebar's owed badge (amber fill, navy text). On My Pipeline amber is reserved for an open deal with no next step: the "No next step" flag (amber ink on the amber surface) and "N with no next step" on the money strip. On the person page it marks what the viewer owes on a deal: the strip's NO NEXT STEP and NOT RECORDED words, and the deal footer's "No next step" and "Not recorded" flags.
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
- **Figure Money** (Condensed 600, 30px, tabular): the money strip's figures; other currencies beside the cash sit at 17px.
- **Figure Large** (Condensed 600, 26px, tabular): the strip's time or due time, the person strip's paid figure in the main currency (other currencies at 17px), the Boarding row's time; the phone number on the reach card at 28px.
- **Figure** (Condensed 600, 20px, tabular): a board row's time, with its AM/PM at 12px in board-muted.
- **Board Title** (Condensed 600, 19px, 0.02em): the board's own heading.
- **Status Word** (Condensed 700, 15px on the board, 17px in the strip, 0.08em, uppercase): one per row, coloured by meaning. The person strip sets two: the lifecycle stage and the next step.
- **Stage Word** (Condensed 700, 13px, 0.08em, uppercase): a deal's stage as a word in its stage ink, in program card and lookup rows.
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
- **My Pipeline:** up to 1500px wide, one column with 14px gaps: the title row with the month switcher, the money strip, the program cards, then All deals. With two or more programs the cards sit two up from `xl`; a single program takes the full width.
- **Person page:** up to 1500px wide, laid out so a person with one or two deals fits one screen. The person strip spans the column; under it, from `@4xl`, a main column (open deal cards, then Closed deals, then Booking answers and Timeline side by side) and a 360px right column holding the one person card, 18px apart, 14px between cards. Narrower, it is one column: strip, deals, booking answers, timeline, person card.
- **Leads & Customers:** up to 1500px wide, one column with 14px gaps (12px on short screens): the page band, then the results card. The page root is the container the rows fold by.
- **New side deal and Profile:** a 640px measure centred in the page inset: the page band, then one ruled card, 14px apart.
- **Deal modal:** centred, up to 672px wide and 88% of the viewport tall (56rem at most). The header stays fixed and the sections scroll under it. On a phone it fills the screen but for an 8px margin.
- **The board** answers to its own width (`@container/board`): the full table from `@3xl` (48rem), the table without Gate from `@xl` (36rem), with narrower Time and Program columns and Join beside the person on the Boarding row (in place of the call's length), and below that two-line rows with the time on the left and the status word on the right.
- **The meeting strip** is one row from `@4xl`, two rows from `@lg` (time, person and status; then the program under the person and the gate under the status), and below that stacked cells that each carry a condensed label. The task strip and the person strip still go straight from one row to stacked cells in narrow containers.

### Responsive rules

Pages and components respond to the space they get, not to the screen: a half-screen window, an open sidebar or a zoomed-in browser all shrink the space without changing the viewport the way `md`/`xl` expect.

- **Make the page root a container** (`@container` on the page's outer element) and lay the page out with `@4xl:` and `@6xl:`. Viewport breakpoints (`sm:`, `lg:`) are for the shell only: the page inset, the sidebar, the task queue.
- **Make any card whose inside changes shape a container too** (the board, the strip, the outcome panel, Performance, Needs outcome), so it reflows by its own width in either column. Name it (`@container/board`) when an inner container could catch the query by mistake.
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
- **Top bar:** white, 52px, a bottom rule, breadcrumbs, and the search field on the right. Breadcrumbs stay on one line at every width: on phones only the parent and the page show, and the page truncates.
- **Command palette:** a closer's pages carry the sidebar's names and order (Today, My Pipeline, Leads & Customers).

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

### The Money Strip
My Pipeline's month on navy, the board's sibling for figures. Four figures under 11px condensed labels: Cash collected, Won, Open deals, Programs. Each figure is 30px condensed with a 13px line under it at 75% board text.
- **Cash:** the main currency's total in lime. Each other currency follows at 17px in board text with its own sum.
- **Change line:** the change against the same elapsed part of last month in the main currency, signed with a true minus ("−$2,000"); a fall reads in board danger. Then the payment count, or "No payments yet".
- **Open deals:** the count, then "Each has a next step" or, in amber, "N with no next step".
- **Partial reads** add "(partial)" or a "+" to the figure. They are never hidden.

**The Separate Currencies Rule.** Money is never added across currencies. Every currency keeps its own sum, in the strip, in a program header and in the lookup.

**The Main Currency Rule.** The main currency is the one with the most payments, never the one with the larger amount. Amounts in different currencies are never compared. A tie goes to last month's main currency, then US dollars.

### The Program Card
A `DetailCard` per program. The title row carries the program name, then its cash in the month (16px condensed, each currency separately, the program's own main currency first) and "N won this month". Under it, 28px condensed column labels (PERSON, STAGE, NEXT STEP) and the open deals as ruled 40px rows: the person as the row link, the stage word, the next step. Deals with no next step sort first. Five rows show when two cards sit side by side and eight when a card is alone, then a "Show N more" row. The footer reads "N open · N closed" with "All {program} deals", which opens the lookup filtered to that program. A card with no open deals keeps one quiet `SectionEmpty` line ("No open deals in {program}.") and sits at its own height rather than stretching to its neighbour.

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
"All deals" on a ruled card. The header row holds the title, a segmented toggle of All / Open / Won / Lost with counts, a program select and a person search (all 30px, 7px radius, 13px). The table has 32px condensed column heads (PERSON, PROGRAM, STAGE, LAST ACTIVITY, NEXT STEP, PAID) and 44px ruled rows. Last activity is in the due style, and Paid is right-aligned in 15px condensed. Below `md` it becomes two-line rows. The footer says "N deals" or "Showing N of M", names partial reads in words, and offers "Show N more". An empty result says what was searched and offers "Clear filters".

### `PageBand`
A page's header as a navy band, the strips' sibling (`app/workspace/_components/page-band.tsx`), used where a page has no strip: Leads & Customers, New side deal and Profile. A 9.8px board surface, 16px by 18px inside (14px by 16px in a narrow container), with the 10% light ring in dark; it scopes `dark` like the board. It holds the 26px display title as the page's `h1`, a 13px board-muted line under it saying what the page does, and an optional back link above the title (13px medium board-muted with a chevron, "Leads & Customers"). The page's one primary action sits right of the title as a lime button and wraps under it on a phone. Anything the page searches or filters by sits inside the band under the title.

**The directory band** fills that slot on Leads & Customers. The search field is the page's hero: 44px, board-raised fill, 7px radius, a 15% light border, a search icon and 16px text in board text, focused on load except on touch screens, `/` to return to it, Escape to clear; a `/` key hint shows until something is typed, then a clear button. Under a board-line rule that runs edge to edge, the lifecycle tabs (ALL, LEADS, CUSTOMERS, PROSPECTS) are 40px, 13px condensed semibold uppercase at 0.12em in board-muted; the active tab is board text over a 2px lime underline. Right of the tabs a 13px board-muted line says what the list shows: "Newest activity first" (hidden on phones), "Searching…", or "3 matches for “ana”".

### The Directory Row
Leads & Customers is one white ruled card of person rows (`person-row.tsx`), the tab's panel. A row reads left to right as who, their deal, what happens next and money, with no column heads:
- **Person:** the 15px semibold name as the row link; a 13px slate line with the phone in 14px condensed, then the email, else the handle.
- **Deal:** the person's current deal (the newest open deal, else the newest deal) as the program with its condensed stage word in stage ink; a 13px slate line "Your deal", "Deal of {closer}" or "No closer", plus "· +N open". "No deal yet" in slate when there is none.
- **Next step:** My Pipeline's resolver set as the person deal card's footer fact (verb in medium slate, then the 15px condensed figure). The amber "No next step" or "Not recorded · {day} call" flag only on a deal the viewer can act on; the same words in slate otherwise; "No open deal" for a closed deal. Under it, "Last activity {day}" in 13px slate.
- **Money:** right-aligned, the paid figure at 20px condensed, "Several currencies" in 13px slate when payments span currencies, or a slate dash when nothing is paid. Under it an 11px condensed lifecycle word: LEAD and PROSPECT in slate, CUSTOMER SINCE {DAY} in lime ink.

**The folds** (`person-row-grid.ts`, shared with the skeleton), by the page's width: from `@4xl` four columns (1.25, 1.2 and 1.1 fractions, then 10rem for money) on a 60px row with 18px sides; from `@xl` the person and money share the first line, with the deal and the next step side by side under them; narrower, the deal and the next step stack under the person while money stays at the right of the name. Rows are 10px top and bottom with 16px sides below `@4xl`.

A 40px footer counts what shows ("25 shown", "37 customers", "3 matches") with an outline "Show 25 more". No matches names what was searched, hints at a phone or email, and offers Clear search (and Search everyone on a narrower tab).

### Form and Settings Cards
New side deal and Profile each sit in one ruled card on the 640px measure, under a `PageBand` with a back link.
- **Sections:** 44px title rows (15px semibold) with room on the right for a control or meta: the Existing / New segmented toggle (the segment lift), or "Optional" in slate.
- **Rows:** `Field` rows ruled between, 12px by 16px, with a 13px slate label in a 120px column beside the control from `@lg`, over it narrower. A row whose section title already names it drops its label to screen readers and takes the full width. Descriptions are 13px slate; errors are 13px danger ink. The phone input sets its figures in 15px condensed.
- **Footer:** a paper band, ruled above, with the outline Cancel and the lime submit on the right.
- **Profile** uses the person card's dense rows instead: a 96px slate label column, about 32px each, in groups split by a rule. The picture row carries the avatar with outline Upload or Replace and a ghost Remove.

### Kept Data While Reloading
When a month, tab, filter or search changes, the section keeps its previous data at 60% opacity (a 200ms fade, `aria-busy`) until the new data arrives, instead of flashing a skeleton. Skeletons appear only on first load. The money strip, program cards, lookup and the directory all follow this.

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

### Don't:
- **Don't** put a small uppercase label above a heading to restate it. Condensed labels name columns, days and groups only.
- **Don't** use lime as decoration on the paper, or leave a lime button on a finished record.
- **Don't** set lime text on white or paper.
- **Don't** show a deal's stage or a call's attendance as a raw palette badge (emerald, indigo, violet). Use the stage scale and the status word.
- **Don't** lift cards with drop shadows; separate surfaces by tone and rule.
- **Don't** lay out a record page as a grid of equal-weight cards with a row of peer action buttons. The question leads.
- **Don't** add, net or compare amounts across currencies, or choose the main currency by amount.
- **Don't** use amber on My Pipeline for anything but an open deal with no next step.
- **Don't** write he, she, his or her for a person in UI copy.

## Migration Status

The system above is complete on five closer surfaces (Today, the meeting page, the task page, My Pipeline, and the person page with its deal modal), on Leads & Customers, New side deal and Profile, and on the shell. Admins use the same person page and deal modal, as they use the meeting and task pages. My Pipeline (commit 56ce0ae) replaced the old stage-tab table; its `opportunities-table`, `pipeline-filters`, `time-period-filter` and `closer-empty-state` components were removed. The person page replaced the old header metrics, the grid of Programs, Opportunities, Meetings, Portal Notes, Payments and Timeline cards and the six-card rail; the right-hand Opportunity Detail sheet became the deal modal, and the `entity-*` section components and the sheet's body were removed. A second pass (the at-a-glance layout) put each deal's calls in its card, folded Source and Record into one person card and collapsed closed deals. Leads & Customers replaced the seven-column entity browser; its `entity-browser-results`, `entity-browser-results-loading`, `entity-browser-toolbar`, `entity-result-row`, `entity-result-mobile-card`, `entity-result-formatters` and `entity-ui-tooltips` components were removed. New side deal moved from `FormItem` to `Field` rows and Profile to the person card's dense rows, both under `PageBand`. The rest of the app predates it and is not part of the system yet. `.impeccable/audit/drift.md` and `.impeccable/audit/backlog.md` map that work:

- **Legacy status colours.** `lib/status-config.ts` still maps deal positions and meeting attendance to raw Tailwind palettes (cyan, blue, indigo, violet, emerald, orange, amber), and about 365 palette utilities in 42 files bypass the tokens. The `--status-*` aliases in `app/globals.css` point at the stage tokens only until that file moves over. The new surfaces read `status-config` for attendance logic and labels only, not colours.
- **Type scale.** About 50 page headers range from `text-base` to `text-5xl`, with 96 arbitrary text sizes and KPI figures in mono. `PageBand` is the header they move to.
- **Layout.** 216 arbitrary layout values, nested page padding and 59 card padding overrides.
- **Forms.** 21 form files still use `FormItem` instead of `Field`/`FieldGroup`. Seven of them open from the person page and deal modal: the lifecycle, enrolment-status, mark-lost, delete, side-deal payment, add payment and void payment dialogs.
- **Charts.** The chart tokens are now categorical (blue, teal, lime, amber, slate); chart modules have not been reviewed against them.
- **Admin twins.** The admin meeting and task pages and the person page share these components; the other admin, report and settings screens have not been migrated.
