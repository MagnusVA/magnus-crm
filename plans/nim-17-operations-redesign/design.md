# NIM-17 — Operations Redesign (sidebar reorg + operations pages)

Linear: [NIM-17](https://linear.app/nimbusdev/issue/NIM-17/reorganize-sidebar-menu) with sub-issues
[NIM-15](https://linear.app/nimbusdev/issue/NIM-15) (Lead Gen tweaks),
[NIM-18](https://linear.app/nimbusdev/issue/NIM-18) (Qualifications),
[NIM-19](https://linear.app/nimbusdev/issue/NIM-19) (Booked Calls),
[NIM-20](https://linear.app/nimbusdev/issue/NIM-20) (Sales Calls).

Scope: admin (tenant_master / tenant_admin) workspace only. The Overview page (`/workspace`) is done and untouched —
it is the design reference for everything else.

## Target information architecture

Sidebar (admin):

- Overview → `/workspace` (unchanged)
- **Operations** (collapsible submenu — new)
  - Lead Gen → `/workspace/operations/lead-gen`
  - Qualifications → `/workspace/operations/qualifications`
  - Booked Calls → `/workspace/operations/booked-calls`
  - Sales Calls → `/workspace/operations/sales-calls`
- Everything else stays exactly as it is today (Billing, Leads & Customers, Team, Settings, Reports group).

The sidebar mockup on NIM-17 is outdated in its other details: **there is no Reviews feature** (ignore the
Reviews + badge item), and Leads & Customers is **not** being split into separate Leads/Customers/Opportunities
items. The only sidebar change is introducing the Operations submenu.

Routing decisions:

- The current tabbed hub `/workspace/operations?tab=...` (`operations-page-client.tsx`) is split into real sub-routes.
  `/workspace/operations` redirects to `/workspace/operations/qualifications`; old `?tab=` URLs redirect to the matching sub-route.
- `/workspace/lead-gen` moves to `/workspace/operations/lead-gen` with a `redirect()` left behind
  (`lead-gen/capture`, `lead-gen/my-activity`, `lead-gen/settings` keep their URLs — they are lead_generator-facing, not admin ops).
- The old "Scheduling" tab's content is absorbed by the new Booked Calls page; the "Phone Sales" tab by Sales Calls.

Sidebar implementation: `workspace-shell-client.tsx` nav items get an optional `children: NavItem[]`;
render with the shadcn `SidebarMenuSub*` primitives inside a `Collapsible` (auto-open when `pathname.startsWith("/workspace/operations")`).

## Shared foundation (build first)

### 1. Standardized Day / Week / Month / Custom range filter

`DashboardDateRangeFilter` (`app/workspace/_components/dashboard-date-range-filter.tsx`) is already the exact control
in the mockups. Standardization work:

- Extract a `useDashboardRange()` hook wrapping the `range` / committed `queryRange` state currently inlined in
  `dashboard-page-client.tsx`, with optional URL-sync (`?range=` search param) so ops pages are shareable/refreshable.
  Overview keeps working as-is (can adopt the hook without behavior change).
- Backend convention: **every new/updated ops query takes `overviewRangeValidator`**
  (`convex/dashboard/overviewRange.ts` — preset `today|this_week|this_month` or custom business-date strings,
  Honduras business-day semantics, 120-day cap). No new epoch-ms date args.
- Lead Gen's divergent filter (raw date inputs + inline business-day helpers in `lead-gen-admin-page-client.tsx:31-57`)
  is replaced by this. A small adapter converts a derived range to the `startDayKey`/`endDayKey` args the existing
  `leadGen/reporting.ts` queries take (or those queries gain a `range` arg — preferred, keeping dayKey args during transition).
- Extra page-specific filters (e.g. Lead Gen's Source) render in the same row, styled like the "Custom" pill.

### 2. Radial goal progress component

No circular progress exists (`components/ui/progress.tsx` is linear only). Build `GoalProgressRing` once, based on
the **shadcn radial charts** (https://ui.shadcn.com/charts/radial — "Radial Chart - Shape" / "- Text" variants:
recharts `RadialBarChart` + `PolarRadiusAxis` with a centered label, via `ChartContainer`), with `goal`, `progress`,
center label, and an edit affordance when the viewer can set the goal. Used by Qualifications and Booked Calls.

### 3. Per-person bar chart

Reusable bar chart card ("per opener", "per D-Closer") styled after the shadcn bar chart blocks
(https://ui.shadcn.com/charts/bar), on recharts via `components/ui/chart.tsx`. One component, two consumers.

### Chart & polish rules (all phases)

- All charts use the shadcn chart blocks as the visual baseline (radial for goals, bar for per-person,
  pie/bar for per-program) with `ChartTooltip`/`ChartTooltipContent` on every chart — no chart ships without a tooltip.
- Non-chart surfaces get `Tooltip` generously: stat-card definitions (how a rate is computed), truncated cells,
  icon buttons, goal math ("goal × business days in range"). Follow `overview-help-tooltip.tsx` precedent.
- Consistent chart theming through CSS variables in `ChartConfig` so light/dark both work.

### 4. Collapsible detail list with search

Pattern: search input (debounced, `use-debounced-value.ts`) + `Collapsible` rows, modeled on
`overview-expandable-leaderboard.tsx` (lazy-load rows on expand — keeps queries bounded). Used by
Qualifications (submissions), Booked Calls (bookings details), Sales Calls (view list).

## Phase plan (one PR each)

### Phase 0 — Foundation + sidebar (NIM-17)

- Sidebar submenu support + Operations group; route scaffolding `/workspace/operations/{lead-gen,qualifications,booked-calls,sales-calls}`
  (thin RSC pages per repo pattern, `requireRole(["tenant_master","tenant_admin"])`), redirects from old URLs.
  No other sidebar changes.
- `useDashboardRange` hook + `GoalProgressRing` + shared bar-chart card + tooltip conventions.
- Initially the qualifications/sales-calls routes mount the existing tab content unmodified (so nav ships without waiting on redesigns).

### Phase 1 — Lead Gen tweaks (NIM-15) — mostly frontend

At `/workspace/operations/lead-gen`, reworking the existing `lead-gen/_components/*`:

- Rename every user-facing "Worker" → **"Lead Gen Specialist"** (filter label, table headers, card copy).
  `leadGenWorkers` table/API names stay (no schema rename needed).
- Filter bar → standardized range filter + Source select restyled to match; drop the separate Worker/Team selects
  (team grouping in the table supersedes them; keep if trivial).
- Performance table: remove **Unique/Dupes columns visually** (logic untouched; totals remain raw `submissions` —
  already true: `submissions` counts raw rows). Group rows **by team** with team header rows and a grand-total row;
  add `MemberAvatar` (rows already carry `avatar: MemberAvatarIdentity`). Grouping is client-side —
  `listWorkerPerformance` rows already have `teamId`; backend just needs to include team display name if missing.
- Top Posts & Reels: replace `top-origins-table.tsx` usage with the Overview's `top-origins-overview-table.tsx`
  presentation (extract its table to accept a plain rows prop so both pages share it).
- **Delete the "Top Posts by Team" section** (`top-origins-by-team-table.tsx`) — redundant per issue.
- Summary cards lose the duplicates/unique framing; keep raw submissions + L/Hr.

### Phase 2 — Qualifications page (NIM-18) — frontend + one consolidated query

Layout per wireframe: title "Qualified Leads" + range filter → bar chart per opener + goal ring →
setter contributions table (Setter, Qualified, **LP/H**, Last event) → collapsible submissions.

- Data all exists: `reporting/slackQualifications.ts#getQualificationReport` (per-setter contributions, goal attainment),
  `buildQualifierEfficiencyRows` (qualified/hr from `slackQualifierSchedules`), `operations/qualifications.ts`
  (`listQualificationQueue` / `searchQualificationQueue`) for the collapsible submissions list.
- New `convex/operations/qualificationsDashboard.ts` query taking `range` (overviewRangeValidator) returning
  { perOpenerBars, goal: { target, progress }, setterRows } in one round trip; submissions list stays a separate
  paginated/searchable query.
- Goal ring uses `tenants.slackQualificationDailyTeamQuota` scaled by business days in range (same math as
  `expectedTeamCount` in the qualification report); reuse `team-goal-dialog.tsx` for editing.
- Simplify/retire the old qualification tab components that the new page supersedes.

### Phase 3 — Booked Calls page (NIM-19) — needs schema additions

Layout: title "Booked Calls — DM Closer Operations" + range filter → bar chart per D-Closer + goal ring →
contributions table (DM Closer, Booked, **LP/H** i.e. booked/hr) → searchable collapsible bookings details.

Existing data: per-DM-closer booked counts + booked/hr already computed
(`dashboard/overviewOperations.ts`, `buildDmCloserEfficiencyRows`, `dmCloserSchedules`, `operationsMeetingDailyStats`).

Net-new backend (all additive/optional — widen-only, use `convex-migration-helper`):

1. **Booking goal — per team** (decided): `attributionTeams.bookingDailyQuota: v.optional(v.number())` (additive
   field on the existing teams registry) + set-mutation guarded by admin roles. Display: the goal ring shows the
   aggregate (sum of active teams' quotas × business days in range) with a per-team breakdown — per-team mini rings
   or a legend with tooltips showing each team's goal vs. progress. Progress per team comes from
   `operationsMeetingDailyStats` (already dimensioned by `attributionTeamId`).
2. **DM closer hourly contract**: `dmClosers.hourlyRateMinor: v.optional(v.number())` (+ currency if needed),
   editable in this page's config. This is the "per dm closer per hour contract".
3. **Initial Source lives on the lead, not the meeting**: `leads.initialSource?: v.union(v.literal("cta"),
   v.literal("inbound"), v.literal("wechat"))` — manual classification, set by DM closers in the link portal
   (Phase 5). Booked Calls shows it in the collapsible booking rows via the meeting → opportunity → lead join
   (denormalize onto `leadCustomerSearchRows` / booking detail payload as needed).
4. **Income lives on the lead too**: `leads.selfReportedIncome?: v.number()` — the lead's **self-reported income**,
   a plain numeric field. Entered by DM closers in the portal (Phase 5, same card as Initial Source), shown on the
   workspace lead detail pages and inside the Booked Calls collapsible booking rows (same lead join as Initial
   Source). Not related to `paymentRecords` / cash collected.

UI moves:

- **Attribution menu relocates here**: `settings/_components/attribution-tab.tsx` (DM Teams + DM Closers registry)
  moves into a "Configuration" section/sheet on this page, extended with the hourly-rate field; Settings keeps a
  pointer link for one release.
- Optional feature flag (issue is tentative): gate the page behind `tenants.billingOpsEnabled`-style boolean only if
  we actually need to hide it from the test tenant; otherwise skip.
- Bookings details list: new query over `meetings` by tenant + scheduledAt range (indexed), paginated, searchable
  (lead name via existing search projections), collapsible per-row detail with income + initial source.

### Phase 4 — Sales Calls page (NIM-20) — frontend + consolidated queries

Layout: title "Phone Sales Ops" + range filter → stat cards (Total Calls, Show-up Rate, Cash Collected, Close Rate,
Avg Cash Collected = payment revenue / payment sales count) → Per-Program statistic card with bar/pie/table toggle →
phone-closer table with **Team Total** row → search bar + collapsible view list.

- Stats: `operations/phoneSales.ts#getPhoneSalesStats` (scheduled/completed/show rate) + payment aggregates
  (`paymentSums`, `reporting/revenue.ts`). Add cash-collected / close-rate / avg-deal to a single
  `getSalesCallsDashboard(range)` query rather than stitching three legacy epoch-ms queries client-side.
- Per-program: program dimensions already on `meetings`/`operationsMeetingDailyStats` + program-scoped payment
  indexes; new breakdown section in the same query, rendered as bar chart / pie / table toggle (recharts,
  patterned on `reports/pipeline/_components/status-distribution-chart.tsx`).
- Closer table: extend `phone-sales-table.tsx` columns (Booked, Canceled, No Shows, Showed, Show-Up Rate,
  Payment Sales, Payment Revenue, Payment Close Rate, Avg Payment Deal) + Team Total footer row —
  per-closer revenue join exists in `reporting/teamPerformance.ts`.
- View list: `listPhoneSalesMeetings` + search + collapsible rows (shared component from foundation).

### Phase 5 — DM closer portal: lead search, Initial Source, notes (new scope, no Linear issue yet)

The DM closer link portal (`app/dm-links/[portalSlug]/`, password-gated, **not** CRM-authenticated — closers pick
their identity from a `dmClosers` dropdown) gains a second surface next to the link-builder wizard: a simple
**lead search page** where a DM closer can

1. search leads (backed by the existing `search_leads` search index on `leads.searchText`),
2. set the lead's **Initial Source** via dropdown (CTA / Inbound / WeChat → `leads.initialSource`),
3. enter the lead's **self-reported income** (numeric input → `leads.selfReportedIncome`),
4. leave **notes** on the lead.

Backend:

- **New `leadNotes` table**: `{ tenantId, leadId, content, createdAt, editedAt?, deletedAt?, authorKind:
  v.union(v.literal("dm_closer"), v.literal("user")), dmCloserId?, userId? }`, indexes `by_tenantId_and_leadId`
  and `by_tenantId_and_createdAt`. `authorKind: "user"` keeps the door open for workspace-side notes later;
  workspace lead detail pages (`/workspace/leads/[leadId]`, `/workspace/leads-customers/[leadId]`) render these
  notes alongside the existing meeting-comment aggregation.
- Portal functions follow the established pattern exactly (`convex/linkPortal/portalActions.ts`): `"use node"`
  action verifies the signed session token → internal query/mutation; **tenant always from the token, never from
  args**; `dmCloserId` validated as belonging to the tenant (same trust level as `recordCopyEvent`).
- New functions: `searchPortalLeads` (bounded, e.g. `.take(20)`), `setLeadInitialSource`, `addLeadNote`,
  `listLeadNotes` (bounded).

Security/PII constraints (portal is a shared-password surface):

- Search results return a **minimal projection** (name, social handles, initialSource, note count) — no email/phone
  unless explicitly decided otherwise.
- Require a minimum query length (≥ 2–3 chars) so the endpoint can't be used to enumerate the lead book, and
  rate-limit writes via the existing `linkPortalAuthAttempts`/rate-limit machinery pattern.
- Notes/initial-source writes are audited (author dmCloserId + session hash, like `linkPortalCopyEvents`).

UI: one new step/tab in `dm-link-portal-client.tsx` ("Leads") — search input, result list, per-lead expandable
card with the Initial Source select, income input, and a notes thread (textarea + list). Deliberately simple,
mobile-friendly.

## Backend ground rules

- All new queries: `requireTenantUser(ctx, ["tenant_master","tenant_admin"])`, args validators, `.withIndex()` only,
  bounded reads (`.take`/`.paginate`), read `convex/_generated/ai/guidelines.md` before writing.
- Prefer the existing rollup tables (`leadGenDailyStats`, `operationsMeetingDailyStats`) and registered aggregates
  (`meetingsByStatus`, `paymentSums`) over scanning raw tables.
- Schema changes are additive optional fields only (production tenant live) — no narrowing, no backfill required
  except defaulting UI display.

## Decisions made (2026-07-07)

- Charts: shadcn chart blocks (radial for goals, bar/pie where they fit), tooltips everywhere. Make it beautiful.
- Sidebar: **only** the Operations submenu changes. The mockup's Reviews item and the Leads/Customers/Opportunities
  split are outdated — Reviews is not part of the application; Leads & Customers stays as-is.
- `/workspace/lead-gen` URL move: just do it (redirect left behind).
- **Initial Source (CTA/Inbound/WeChat)**: manual, per **lead**, entered by DM closers in the link portal (Phase 5).
- **Income**: lead's self-reported income (`leads.selfReportedIncome`), portal-entered, shown on lead detail +
  Booked Calls booking rows. Unrelated to `paymentRecords`.
- **Booking goals are per-team** (`attributionTeams.bookingDailyQuota`), aggregate ring + per-team breakdown.
- **Portal PII**: minimal projection (name/handles/source/income/notes — no email/phone), min query length,
  bounded results, rate-limited + audited writes.
- **New scope**: DM closer portal lead search page (Initial Source, income, notes) — Phase 5.
- Feature flag on Booked Calls: skipped unless a need to hide the page in prod emerges (default).

## Remaining loose ends (non-blocking)

- Create a Linear sub-issue under NIM-17 for Phase 5 (portal lead search / income / source / notes).

## Suggested order & sizing

| PR | Issue | Size | Depends on |
|----|-------|------|-----------|
| 0. Foundation + sidebar + routes | NIM-17 | M | — |
| 1. Lead Gen tweaks | NIM-15 | M | 0 |
| 2. Qualifications page | NIM-18 | M | 0 |
| 3. Booked Calls page (+schema) | NIM-19 | L | 0 (schema early) |
| 4. Sales Calls page | NIM-20 | L | 0 |
| 5. DM portal lead search + Initial Source + notes | (new issue) | M–L | schema from 3 (`leads.initialSource`) |

Phases 1, 2 and 4 are independent after Phase 0. Phase 3/5 share the `leads.initialSource` schema addition —
land it early (widen-only) so data capture starts before the UIs ship.
