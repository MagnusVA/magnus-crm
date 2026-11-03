---
version: 1
slug: "app-workspace-operations-booked-calls-page-tsx"
primary_target: "app/workspace/operations/booked-calls/page.tsx"
related_targets: ["app/workspace/operations/booked-calls/attribution/page.tsx"]
---

# Booked calls (`/workspace/operations/booked-calls`, admin Operations)

Mode: Operate. Eighth surface in the Departures Board world (tokens and recipes in `DESIGN.md`); one of four Operations pages redesigned in parallel (Lead Gen, Qualifications, Sales Calls), all on the Overview skeleton: PageBand with range words, freshness and the board-tone picker; sections as DetailCards. The Attribution sub-page (`attribution/`, reached from Configuration) moves under the same PageBand, its tabs in the band.

## Scope
Audience: owners and admins (`tenant_master`, `tenant_admin`). They open it to see whether each DM team is booking enough calls for its goal, which DM closers inside each team are booking, and to look up a booking.
User decisions (2026-11-02): same content and data, new design; round 1 (goal in band, closers open in place, bookings lead) rejected as not visual enough; steer: more visual, colour as feedback, DM closers ranked separately per team (same table allowed, clearly separated by team). Locked structure: Team rings (`.impeccable/mocks/decision/booked-team-rings.html`).
Untouched: every number and its definition (booked = new-classification meetings attributed to a DM closer; goal = team daily quota × days in range; booked per scheduled hour; hourly contract rate), the live/ClickHouse/snapshot-job split, export, schedules and goals dialogs, the bookings list query, search and closer filter, admin-only access. No Convex or ClickHouse changes.

## Direction contract
THESIS: The page answers "is each DM team on pace for its goal, and who inside it is booking" in one look: one goal ring per team coloured by pace, then the DM closers ranked within their team, beside the bookings. Refuses the old bar chart plus one total goal ring plus a flat closers table that mixes teams.
OWN-WORLD: Departures Board as on Overview: navy PageBand, paper ground, white ruled DetailCards with 44px title rows, Barlow and Barlow Condensed tabular figures. Pace is the page's colour feedback, drawn from the stage scale fills and urgency colours: lime fill for goal met, follow-up teal for on pace, owed amber for behind, lost red for missed, held slate for no goal. Pace words are condensed uppercase in the matching ink. Lime on the paper only as the goal-met fill (no lime buttons: the page has no next action). Bookings carry the attendance status word and the deal's stage chip from the stage scale.
STORY: The owner lands on Today, reads the range and the live line, scans five team rings (DmTeam3 amber "Behind · 3 short"), switches to This week, reads each team's closers ranked 1..n with booked bars in the team's pace colour, filters Bookings to one closer, opens a booking to its deal, edits a goal or schedules, exports.
FIRST VIEWPORT: Navy sidebar, white top bar. PageBand "Booked calls" with the 13px line (range words · freshness · business-day line); actions: Schedules, Configuration and Export as board buttons, then the board-tone picker. Under it a row of team tiles (one per team with a goal or bookings): a 64px ring in the pace colour with the percent inside, team name, "12 of 21" in condensed, the pace word ("Ahead · +3", "Behind · 3 short", "Goal met", "No goal"), a 13px slate line ("9 expected by today" or "3 a day"); Edit goals as a card link at the row's end. Below, from @5xl, two columns at 1.25 to 1: "DM closers by team" (team section rows with a pace dot, the pace word and "12 of 21"; closers ranked within team: rank, avatar, name, booked with an inline bar in the team's pace colour, per hour, rate) and "Bookings" (search, DM closer select; ruled rows: person, "closer · program · call day", the attendance word and the stage chip; rows open in place to their details and links).
FORM: Team rings, dealt lead of the re-roll hand (position 6 of my ordered list). seed:58a3d1357eaa39a9
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Pace rules
- Goal per team = daily quota × days in range (server). Presets run through today, so the goal grows with the range.
- Expected by now = daily quota × days in range before today (completed days); a range that has ended expects the whole goal.
- Goal met: booked ≥ goal (lime). On pace/Ahead: booked ≥ expected (teal; "Ahead · +N" when above). Behind: booked < expected while the range runs (amber, "Behind · N short"). Missed: range over and booked < goal (red, "Missed · N short"). No goal: no quota (slate, ring shows booked only).
- Today: expected is 0, so a team is On pace with "N to go" until it meets the goal.

## States
- Each section owns its state in its card (loading skeleton at real heights, empty in words naming the range, error). Snapshot job and freshness alerts render under the band. Range change keeps previous data dimmed (Kept Data While Reloading).
- Closers without a team go in a final "No team" section; teams with no closers but a goal still show a tile.
- Phones: tiles two per row then one, sections stack, closer rows fold to two lines, bookings stay rows.
