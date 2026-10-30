# Ranked summary

1. **Status and feedback colours bypass theme tokens**. Count **365**. Example `lib/status-config.ts:54`. 42 files carry palette utilities; a theme swap cannot control these colours.
2. **Payment statuses disagree across screens**. Count **2**. Example `app/workspace/billing/_components/billing-payment-summary.tsx:53`. Two direct hue conflicts: recorded amber/blue, disputed rose/red. Four payment presentations need one contract.
3. **Page headers have no single hierarchy**. Count **50**. Example `app/workspace/_components/dashboard-header.tsx:17`. 50 h1 instances range from text-base to responsive text-5xl and mix bold, semibold, and brand type.
4. **Compact type uses local pixel/rem decisions**. Count **96**. Example `app/workspace/billing/_components/billing-event-history.tsx:208`. 96 arbitrary size classes include 9.6px, 10px, 11px and 13px text.
5. **Layout dimensions and responsive recipes are scattered**. Count **216**. Example `app/workspace/leads-customers/[leadId]/_components/entity-detail-layout.tsx:17`. 216 arbitrary layout values; nested page padding and several unrelated width caps.
6. **Feature panels duplicate the card language**. Count **113**. Example `app/workspace/lead-gen/_components/lead-gen-capture-page-client.tsx:483`. 113 rounded bordered/card-background markup candidates across 75 files need recipe triage.
7. **Forms retain the older composition**. Count **21**. Example `app/workspace/closer/meetings/_components/mark-lost-dialog.tsx:137`. 21 form files have no FieldGroup and still use FormField/FormItem.
8. **Card density overrides defeat the updated baseline**. Count **59**. Example `app/workspace/reports/leads/_components/conversion-kpi-cards.tsx:25`. 59 literal card padding overrides across 40 files mix p-0, p-4, pb-2, pb-3, pt-6.
9. **Menus and selects omit required group components**. Count **17**. Example `app/workspace/closer/_components/program-select.tsx:84`. 14 SelectItem files lack SelectGroup; 3 DropdownMenuItem files lack DropdownMenuGroup.
10. **Legacy colour conversion breaks theme consumers**. Count **3**. Example `app/workspace/reports/team/_components/meeting-outcome-distribution-chart.tsx:32`. Three locations use hsl(var(...)) on complete OKLCH values: chart fill, shimmer, table-header shadow.

## Scope and counting

[independent] Read-only source audit of **581 files** in `app/`, `components/`, `hooks/`, and `lib/`. `components/ui/` is explicitly excluded from drift counts and treated as the updated radix-nova baseline. Sources were discovered with `rg --files app components hooks lib`, filtered to `.ts`, `.tsx`, `.css`, with an explicit path exclusion. Theme declarations in `app/globals.css` are intentional foundations, not hard-coded-colour violations. Tests and comments are in search scope; false positives are called out below.

All counts are source occurrences or files, never estimated runtime instances. Pattern-register searches ran through `rg --json --pcre2 -U -e PATTERN <explicit corpus files>`; counts sum JSON `submatches`, so multiline matches count once. Tables and grouped line inventories below allow exact reproduction. Compound counts state their filters. Standard weights, responsive dimensions, accessible native controls, and legitimate decoration are inventory items, not automatically defects. No browser, screenshot, contrast measurement, runtime testing, or visual severity claim is included. No external/vendor research was required; findings are [independent] repository observations with local source references.

Conventions reviewed: `.agents/skills/shadcn/rules/styling.md:31` through the styling rules, `.agents/skills/shadcn/rules/composition.md:1`, and `.agents/skills/shadcn/SKILL.md:1`. Project style is `radix-nova`, `components.json:3`; Lucide is configured at `components.json:15`.

## 1. Color drift

Count: **365 matches in 42 files**. Search `palette` in the pattern register below.
A further 1 raw palette CSS-variable reference appears in the team outcome chart. Palette utilities include dark and hover variants as separate occurrences.

### Meanings and token boundaries

- Status and feedback: deal, attendance, lead, enrollment, payment, connection, urgency, operational load, respark result, successful revenue, merge safety and warning banners dominate palette use. The complete per-file palette inventory follows.
- Charts: all 13 Recharts modules use chart tokens, with one mixed-status chart retaining a raw amber variable and invalid destructive conversion. Chart slots currently all occupy a yellow/orange/brown family in both themes, `app/globals.css:71` and `app/globals.css:117`.
- Brand: semantic primary/sidebar-primary tokens already exist, `app/globals.css:59`, `app/globals.css:79`. No additional feature hex brand colour was found. Exported PDF output has a separate brand palette at `lib/operations-reports/pdf.ts:13` to absorb into an export theme.
- Decoration: calendar current-time markers are red in `app/workspace/closer/_components/day-view.tsx:55` and `week-view.tsx:68`; image scrims deliberately use black/white at `app/workspace/billing/_components/billing-proof-preview.tsx:121` and `app/workspace/closer/meetings/_components/deal-won-card.tsx:225`. These need explicit decorative roles, not status inference.

### Status-to-colour mappings

Each row names a distinct definition or visual contract. Repeated consumers of `lib/status-config.ts` inherit its mapping. Chart slots are mapped separately because their status hues differ from badges.

| Domain and definition | Mappings | Evidence |
|---|---|---|
| Deal positions, 6 | qualified cyan; booked blue; call_held indigo; follow_up violet; won emerald; lost red. Badge tint 500/10, text 700 light / 400 dark, border 200 light / 900 dark; solid 500 dots. | `lib/status-config.ts:51` |
| Meeting attendance, 5 | scheduled blue; held emerald; canceled muted with struck text; no_show orange; not_recorded amber. Blocks 500/10, left borders 500, text 700 / dark 300, badge text 700 / dark 400. | `lib/status-config.ts:106` |
| Tenant, 7 | pending_signup outline; pending_calendly and provisioning_webhooks secondary; active default/primary; calendly_disconnected and invite_expired destructive; suspended ghost. | `lib/status-config.ts:159` |
| Connection, 4 | connected emerald; expiring amber; expired and disconnected destructive. | `lib/status-config.ts:181` |
| Legacy lead, 3 | active emerald; converted blue; merged muted. | `app/workspace/leads/_components/lead-status-badge.tsx:8` |
| Enrollment, 3 | active green 500/15 with 700/400 text; paused yellow; churned red, 500/25 borders. | `app/workspace/leads-customers/[leadId]/_components/enrollment-status-badge.tsx:11` |
| Payment billing summary, 3 | recorded / Needs review amber; verified / Reviewed emerald; disputed rose. Dots 500; text 700/400; ring 500/25. | `app/workspace/billing/_components/billing-payment-summary.tsx:53` |
| Payment deal-won card, 3 | recorded blue; verified emerald; disputed red. Same 500/10, 700/400, 200/900 badge recipe as other status badges. | `app/workspace/closer/meetings/_components/deal-won-card.tsx:59` |
| Payment billing queue, 3 | verified secondary; disputed destructive; recorded outline. | `app/workspace/billing/_components/billing-queue-table.tsx:60` |
| Payment opportunity list, 3 | recorded, verified, disputed all secondary. | `app/workspace/opportunities/[opportunityId]/_components/opportunity-payments-list.tsx:134` |
| Reminder urgency, 3 | normal / Upcoming blue badge but neutral border elsewhere; amber / Due now amber; red / Overdue red. | `app/workspace/closer/reminders/[followUpId]/_components/reminder-metadata-card.tsx:41`; `app/workspace/closer/_components/reminder-urgency.ts:28`; `reminders-section.tsx:136` in that same folder |
| Initial source, 3 duplicated mappings | cta sky, inbound violet, wechat emerald; 500/10 fill, 500/30 border, 700/300 text. | `app/workspace/_components/initial-source-badge.tsx:17`; `app/dm-links/[portalSlug]/_components/portal-leads-panel.tsx:54` |
| Opportunity source, 3 | slack_qualified outline; side_deal secondary; calendly outline. | `app/workspace/opportunities/_components/opportunity-source-badge.tsx:10` |
| Respark result, 3 | resparked emerald border/text; not_a_fit baseline outline; skipped muted text. | `app/workspace/lead-gen/_components/respark-batch.tsx:40` |
| Respark bucket, 4 | 1 emerald-500; 2 orange-500; 3 blue-600; 4 amber-500. | `app/workspace/lead-gen/_components/respark-format.ts:11` |
| Activity event families, 5 | payment/customer/enrollment emerald; meeting/followUp blue; opportunity violet; lead captured/portal/slack-qualified amber; other primary. | `app/workspace/leads-customers/[leadId]/_components/entity-activity-section.tsx:20` |
| Closer capacity, 3 | zero meetings emerald-100/800; 1-3 amber-100/800; >3 red-100/800; dark uses 950/300. | `app/workspace/team/redistribute/[unavailabilityId]/_components/redistribute-wizard-page-client.tsx:724` |
| Featured meeting timing, 2 | ongoing amber; next scheduled emerald. | `app/workspace/closer/_components/featured-meeting-card.tsx:115` |
| Review state, 2 | resolved emerald border/text; unresolved amber. | `app/workspace/operations/booking-reviews/[reviewId]/_components/booking-review-page-client.tsx:317` |
| KPI feedback, 6 variants | default baseline; primary primary; muted muted; success emerald; warning amber; destructive destructive. | `app/workspace/_components/stats-card.tsx:32` |
| Lifecycle | stage badge uses default/primary; disposition badge uses amber outline. | `app/workspace/leads-customers/[leadId]/_components/entity-lifecycle-section.tsx:57` |
| Pipeline chart positions, 4 | qualified chart-1; booked chart-2; call_held chart-3; follow_up chart-4. | `app/workspace/reports/pipeline/_components/stage-distribution-chart.tsx:24` |
| Team outcomes, 10 | sold chart-1; lost chart-2; no_show invalid hsl(destructive); canceled muted-foreground; rescheduled chart-3; dq chart-5; follow_up chart-4; not_recorded raw amber-500; upcoming and scheduled chart-5. | `app/workspace/reports/team/_components/meeting-outcome-distribution-chart.tsx:29` |
| Reminder report outcomes, 5 | payment_received chart-4; lost chart-5; no_response_rescheduled chart-1; no_response_given_up chart-2; no_response_close_only chart-3. | `app/workspace/reports/reminders/_components/reminders-report-config.ts:19` |

Conflicts to resolve: two payment hue conflicts plus differing semantic variants across four payment presentations; lead/tenant/enrollment "active" use emerald/primary/green respectively, a cross-domain naming inconsistency rather than necessarily the same state. Pipeline stages use categorical chart slots rather than their cyan/blue/indigo/violet UI roles. Lost uses red in deal badges, chart-2 in team outcomes and chart-5 in reminders. No-show is orange in attendance, amber in its action banner and destructive in the outcome chart. Choose whether charts must preserve status semantics before assigning a new palette.

The seven `--status-*` declarations at `app/globals.css:88` are not referenced by feature code. `rg -n -- "--status-" app components hooks lib` finds only these definitions. `--status-in-progress` and `--status-follow-up` are legacy names, and there is no held/not-recorded token, so the existing set is not a complete attendance contract.

### Palette evidence, complete inventory

- `app/dm-links/[portalSlug]/_components/portal-leads-panel.tsx:58`: L58 `border-sky-500/30`; L58 `bg-sky-500/10`; L58 `text-sky-700`; L58 `text-sky-300`; L63 `border-violet-500/30`; L63 `bg-violet-500/10`; L63 `text-violet-700`; L63 `text-violet-300`; L68 `border-emerald-500/30`; L68 `bg-emerald-500/10`; L68 `text-emerald-700`; L68 `text-emerald-300`
- `app/workspace/_components/initial-source-badge.tsx:23`: L23 `border-sky-500/30`; L23 `bg-sky-500/10`; L23 `text-sky-700`; L23 `text-sky-300`; L28 `border-violet-500/30`; L28 `bg-violet-500/10`; L28 `text-violet-700`; L28 `text-violet-300`; L33 `border-emerald-500/30`; L33 `bg-emerald-500/10`; L33 `text-emerald-700`; L33 `text-emerald-300`
- `app/workspace/_components/stats-card.tsx:36`: L36 `border-emerald-500/20`; L36 `bg-emerald-500/5`; L37 `border-amber-500/20`; L37 `bg-amber-500/5`
- `app/workspace/_components/analytics/analytics-freshness.tsx:34`: L34 `bg-emerald-500`
- `app/workspace/billing/_components/billing-payment-summary.tsx:59`: L59 `bg-amber-500`; L60 `text-amber-700`; L60 `text-amber-400`; L61 `ring-amber-500/25`; L65 `bg-emerald-500`; L66 `text-emerald-700`; L66 `text-emerald-400`; L67 `ring-emerald-500/25`; L71 `bg-rose-500`; L72 `text-rose-700`; L72 `text-rose-400`; L73 `ring-rose-500/25`
- `app/workspace/closer/_components/day-view.tsx:55`: L55 `bg-red-500`; L56 `bg-red-500`
- `app/workspace/closer/_components/featured-meeting-card.tsx:79`: L79 `border-l-emerald-500`; L81 `border-l-amber-500`; L118 `bg-amber-500/15`; L118 `text-amber-700`; L118 `text-amber-400`; L120 `bg-emerald-500/15`; L120 `text-emerald-700`; L120 `text-emerald-400`
- `app/workspace/closer/_components/week-view.tsx:68`: L68 `bg-red-500`; L69 `bg-red-500`
- `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx:148`: L148 `border-emerald-200`; L148 `bg-emerald-50/50`; L148 `text-emerald-700`; L148 `bg-emerald-100/80`; L148 `border-emerald-900`; L148 `bg-emerald-950/30`; L148 `text-emerald-400`
- `app/workspace/closer/_components/reminder-urgency.ts:33`: L33 `border-amber-500`; L33 `bg-amber-50`; L33 `bg-amber-950/20`; L35 `border-red-500`; L35 `bg-red-50`; L35 `bg-red-950/20`
- `app/workspace/closer/meetings/_components/fathom-link-field.tsx:240`: L240 `text-emerald-700`; L240 `text-emerald-400`
- `app/workspace/closer/_components/pipeline-strip.tsx:334`: L334 `border-emerald-500/30`; L334 `bg-emerald-500/6`; L334 `border-emerald-900/60`; L343 `text-emerald-600`; L343 `text-emerald-400`; L354 `text-emerald-700`; L354 `text-emerald-300`
- `app/workspace/closer/meetings/_components/no-show-action-bar.tsx:91`: L91 `border-amber-200`; L91 `bg-amber-50`; L91 `border-amber-800/40`; L91 `bg-amber-950/20`; L94 `text-amber-600`; L94 `text-amber-400`; L96 `text-amber-900`; L96 `text-amber-100`; L99 `text-amber-700`; L99 `text-amber-300`
- `app/workspace/closer/meetings/_components/deal-won-card.tsx:63`: L63 `bg-blue-500/10`; L63 `text-blue-700`; L63 `border-blue-200`; L63 `text-blue-400`; L63 `border-blue-900`; L68 `bg-emerald-500/10`; L68 `text-emerald-700`; L68 `border-emerald-200`; L68 `text-emerald-400`; L68 `border-emerald-900`; L73 `bg-red-500/10`; L73 `text-red-700`; L73 `border-red-200`; L73 `text-red-400`; L73 `border-red-900`; L89 `border-emerald-200`; L89 `bg-emerald-50/50`; L89 `border-emerald-900`; L89 `bg-emerald-950/30`; L92 `text-emerald-600`; L92 `text-emerald-400`; L231 `text-blue-600`; L231 `text-blue-400`
- `app/workspace/closer/_components/reminders-section.tsx:136`: L136 `bg-red-50`; L136 `bg-red-950/20`; L137 `bg-amber-50`; L137 `bg-amber-950/20`; L145 `bg-red-500`; L146 `bg-amber-500`
- `app/workspace/closer/meetings/_components/meeting-overview-card.tsx:186`: L186 `bg-amber-500/10`; L187 `text-amber-600`; L187 `text-amber-400`; L188 `text-amber-700`; L188 `text-amber-400`
- `app/workspace/closer/meetings/_components/potential-duplicate-banner.tsx:61`: L61 `border-amber-500`; L61 `bg-amber-50`; L61 `bg-amber-950/20`; L65 `text-amber-600`; L65 `text-amber-400`; L67 `text-amber-800`; L67 `text-amber-200`; L70 `text-amber-700`; L70 `text-amber-300`; L101 `border-amber-400`; L101 `text-amber-800`; L101 `bg-amber-100`; L101 `border-amber-600`; L101 `text-amber-200`; L101 `bg-amber-900/30`; L110 `border-amber-400`; L110 `text-amber-800`; L110 `bg-amber-100`; L110 `border-amber-600`; L110 `text-amber-200`; L110 `bg-amber-900/30`
- `app/workspace/closer/meetings/_components/reschedule-link-display.tsx:34`: L34 `border-blue-200`; L34 `bg-blue-50`; L34 `border-blue-800/40`; L34 `bg-blue-950/20`; L64 `text-green-600`; L83 `border-blue-200`; L83 `bg-blue-50`; L83 `border-blue-800/40`; L83 `bg-blue-950/20`; L84 `text-blue-600`; L84 `text-blue-400`; L85 `text-blue-900`; L85 `text-blue-100`
- `app/workspace/closer/meetings/_components/meeting-info-panel.tsx:139`: L139 `bg-amber-500/10`; L140 `text-amber-600`; L140 `text-amber-400`; L141 `text-amber-700`; L141 `text-amber-400`
- `app/workspace/leads-customers/[leadId]/_components/entity-activity-section.tsx:25`: L25 `bg-emerald-500`; L28 `bg-blue-500`; L31 `bg-violet-500`; L38 `bg-amber-500`
- `app/workspace/closer/reminders/[followUpId]/_components/reminder-metadata-card.tsx:48`: L48 `bg-blue-500/10`; L48 `text-blue-700`; L48 `border-blue-200`; L48 `text-blue-400`; L48 `border-blue-900`; L53 `bg-amber-500/10`; L53 `text-amber-700`; L53 `border-amber-200`; L53 `text-amber-400`; L53 `border-amber-900`; L58 `bg-red-500/10`; L58 `text-red-700`; L58 `border-red-200`; L58 `text-red-400`; L58 `border-red-900`
- `app/workspace/leads-customers/[leadId]/_components/entity-header-section.tsx:145`: L145 `text-emerald-600`; L145 `text-emerald-400`
- `app/workspace/leads-customers/[leadId]/_components/enrollment-status-badge.tsx:12`: L12 `bg-green-500/15`; L12 `text-green-700`; L12 `text-green-400`; L12 `border-green-500/25`; L13 `bg-yellow-500/15`; L13 `text-yellow-700`; L13 `text-yellow-400`; L13 `border-yellow-500/25`; L14 `bg-red-500/15`; L14 `text-red-700`; L14 `text-red-400`; L14 `border-red-500/25`
- `app/workspace/lead-gen/_components/respark-format.ts:12`: L12 `bg-emerald-500`; L13 `bg-orange-500`; L14 `bg-blue-600`; L15 `bg-amber-500`
- `app/workspace/leads-customers/[leadId]/_components/entity-lifecycle-section.tsx:65`: L65 `border-amber-500/50`; L65 `text-amber-700`; L65 `text-amber-400`
- `app/workspace/leads-customers/[leadId]/_components/entity-detail-ui.tsx:106`: L106 `text-emerald-600`; L106 `text-emerald-400`
- `app/workspace/leads-customers/[leadId]/_components/entity-payments-section.tsx:37`: L37 `text-emerald-600`; L37 `text-emerald-400`
- `app/workspace/lead-gen/_components/respark-batch.tsx:44`: L44 `border-emerald-500/50`; L44 `text-emerald-700`; L44 `text-emerald-400`
- `app/workspace/leads-customers/[leadId]/_components/entity-opportunity-row.tsx:61`: L61 `bg-emerald-500/10`; L61 `text-emerald-700`; L61 `text-emerald-400`; L66 `bg-emerald-500/10`; L66 `text-emerald-700`; L66 `text-emerald-400`
- `app/workspace/leads-customers/[leadId]/_components/entity-programs-section.tsx:114`: L114 `text-emerald-600`; L114 `text-emerald-400`
- `app/workspace/leads/_components/lead-status-badge.tsx:12`: L12 `bg-emerald-500/10`; L12 `text-emerald-700`; L12 `border-emerald-200`; L12 `text-emerald-400`; L12 `border-emerald-900`; L17 `bg-blue-500/10`; L17 `text-blue-700`; L17 `border-blue-200`; L17 `text-blue-400`; L17 `border-blue-900`
- `app/workspace/leads-customers/[leadId]/_components/opportunity-sheet-summary.tsx:175`: L175 `text-emerald-600`; L175 `text-emerald-400`
- `app/workspace/leads/[leadId]/merge/_components/merge-preview.tsx:76`: L76 `border-red-300`; L76 `border-red-700`; L77 `border-green-300`; L77 `border-green-700`; L96 `bg-green-100`; L96 `text-green-800`; L96 `bg-green-900/30`; L96 `text-green-300`
- `app/workspace/operations/booked-calls/attribution/_components/portal-event-type-readiness-card.tsx:426`: L426 `bg-emerald-500`
- `app/workspace/operations/booked-calls/attribution/_components/portal-access-card.tsx:204`: L204 `border-emerald-500/30`; L204 `bg-emerald-500/5`; L212 `bg-emerald-500`
- `app/workspace/operations/booking-reviews/[reviewId]/_components/booking-review-page-client.tsx:317`: L317 `border-emerald-300`; L317 `text-emerald-700`; L317 `border-emerald-900`; L317 `text-emerald-400`; L318 `border-amber-300`; L318 `text-amber-700`; L318 `border-amber-900`; L318 `text-amber-400`
- `app/workspace/reports/reminders/_components/reminders-report-page-client.tsx:132`: L132 `text-amber-600`
- `app/workspace/team/_components/team-members-table.tsx:236`: L236 `text-amber-600`; L236 `text-amber-400`; L237 `text-amber-600`; L237 `text-amber-400`; L253 `text-amber-600`; L253 `text-amber-400`
- `app/workspace/settings/_components/programs-tab.tsx:114`: L114 `bg-amber-500/10`; L115 `text-amber-600`; L115 `text-amber-400`
- `components/slack-connection-guard.tsx:121`: L121 `border-amber-500/30`; L121 `bg-amber-50`; L121 `text-amber-950`; L121 `border-amber-700/50`; L121 `bg-amber-950/30`; L121 `text-amber-100`; L124 `text-amber-900/90`; L124 `text-amber-100/85`
- `app/workspace/team/redistribute/[unavailabilityId]/_components/redistribute-wizard-page-client.tsx:726`: L726 `bg-emerald-100`; L726 `text-emerald-800`; L726 `bg-emerald-950`; L726 `text-emerald-300`; L728 `bg-amber-100`; L728 `text-amber-800`; L728 `bg-amber-950`; L728 `text-amber-300`; L729 `bg-red-100`; L729 `text-red-800`; L729 `bg-red-950`; L729 `text-red-300`; L965 `bg-emerald-100`; L965 `bg-emerald-950`; L966 `text-emerald-600`; L966 `text-emerald-400`
- `lib/status-config.ts:54`: L54 `bg-cyan-500/10`; L54 `text-cyan-700`; L54 `border-cyan-200`; L54 `text-cyan-400`; L54 `border-cyan-900`; L55 `bg-cyan-500`; L59 `bg-blue-500/10`; L59 `text-blue-700`; L59 `border-blue-200`; L59 `text-blue-400`; L59 `border-blue-900`; L60 `bg-blue-500`; L64 `bg-indigo-500/10`; L64 `text-indigo-700`; L64 `border-indigo-200`; L64 `text-indigo-400`; L64 `border-indigo-900`; L65 `bg-indigo-500`; L69 `bg-violet-500/10`; L69 `text-violet-700`; L69 `border-violet-200`; L69 `text-violet-400`; L69 `border-violet-900`; L70 `bg-violet-500`; L74 `bg-emerald-500/10`; L74 `text-emerald-700`; L74 `border-emerald-200`; L74 `text-emerald-400`; L74 `border-emerald-900`; L75 `bg-emerald-500`; L79 `bg-red-500/10`; L79 `text-red-700`; L79 `border-red-200`; L79 `text-red-400`; L79 `border-red-900`; L80 `bg-red-500`; L109 `bg-blue-500/10`; L109 `border-l-blue-500`; L110 `text-blue-700`; L110 `text-blue-300`; L111 `bg-blue-500/10`; L111 `text-blue-700`; L111 `border-blue-200`; L111 `text-blue-400`; L111 `border-blue-900`; L112 `bg-blue-500`; L116 `bg-emerald-500/10`; L116 `border-l-emerald-500`; L117 `text-emerald-700`; L117 `text-emerald-300`; L118 `bg-emerald-500/10`; L118 `text-emerald-700`; L118 `border-emerald-200`; L118 `text-emerald-400`; L118 `border-emerald-900`; L119 `bg-emerald-500`; L130 `bg-orange-500/10`; L130 `border-l-orange-500`; L131 `text-orange-700`; L131 `text-orange-300`; L132 `bg-orange-500/10`; L132 `text-orange-700`; L132 `border-orange-200`; L132 `text-orange-400`; L132 `border-orange-900`; L133 `bg-orange-500`; L137 `bg-amber-500/10`; L137 `border-l-amber-500/60`; L138 `text-amber-700`; L138 `text-amber-300`; L139 `bg-amber-500/10`; L139 `text-amber-700`; L139 `border-amber-200`; L139 `text-amber-400`; L139 `border-amber-900`; L140 `bg-amber-500/60`; L184 `text-emerald-600`; L184 `text-emerald-400`; L186 `bg-emerald-500/10`; L186 `text-emerald-700`; L186 `text-emerald-400`; L190 `text-amber-600`; L190 `text-amber-400`; L192 `bg-amber-500/10`; L192 `text-amber-700`; L192 `text-amber-400`

### Raw CSS literals

Search `literal` includes intentional theme definitions and three false-positive React error-number strings: `lib/observability/client-exceptions.ts:45`, `:46`, and `lib/observability/convex-log-stream.test.ts:496`. Excluding those and globals leaves **8 matches in 4 files**: five PDF hex colours, two hsl(var(...)) consumers, and one OKLCH shadow literal. The PDF colours are an export-specific theme, not browser dark-mode defects.

- `app/workspace/leads-customers/[leadId]/_components/entity-detail-ui.tsx:13`: `oklch(0_0_0/0.04)`
- `app/workspace/reports/team/_components/meeting-outcome-distribution-chart.tsx:32`: `hsl(var(--destructive)`
- `app/workspace/settings/_components/event-type-config-list.tsx:216`: `hsl(var(--border)`
- `lib/operations-reports/pdf.ts:13`: `#17252b`
- `lib/operations-reports/pdf.ts:14`: `#62747b`
- `lib/operations-reports/pdf.ts:15`: `#13834a`
- `lib/operations-reports/pdf.ts:165`: `#eaf3ef`
- `lib/operations-reports/pdf.ts:187`: `#dfe7e9`

## 2. Typography drift

Count: **96 matches in 46 files**. Search `size` in the pattern register below.
Sizes are numeric-only so `text-[CanvasText]` would not be mistaken for typography.

Arbitrary size vocabulary: `text-[10px]` × 37, `text-[11px]` × 33, `text-[0.68rem]` × 10, `text-[0.625rem]` × 6, `text-[0.6rem]` × 3, `text-[0.65rem]` × 3, `text-[0.72rem]` × 2, `text-[13px]` × 1, `text-[1.08em]` × 1.

Count: **579 matches in 190 files**. Search `weight` in the pattern register below. Count: **125 matches in 74 files**. Search `tracking` in the pattern register below. Of tracking occurrences, 24 are arbitrary values. Standard weight/spacing utilities are legal Tailwind; the drift is that every feature selects its own hierarchy instead of a heading/label/metric role.

Weight vocabulary: `font-medium` × 287, `font-semibold` × 215, `font-bold` × 59, `font-normal` × 15, `font-light` × 3.

Fonts are Geist sans, JetBrains Mono, and Aceh Light 300 at `app/layout.tsx:12`, `:17`, `:22`. CSS aliases are `app/globals.css:10`. **4 rendered font-brand uses**, plus the CSS alias matched by the broader brand search: the shared wordmark, landing copy, billing amount, and person header. The last two extend Aceh beyond a wordmark and must be deliberate system roles.

- `app/page.tsx:145`: L145 `font-brand`
- `app/globals.css:13`: L13 `font-brand`
- `app/workspace/leads-customers/[leadId]/_components/entity-header-section.tsx:51`: L51 `font-brand`
- `app/workspace/billing/_components/billing-payment-summary.tsx:207`: L207 `font-brand`
- `components/magnus-brand.tsx:62`: L62 `font-brand`

### Every h1 / page-header definition

Count: **50 matches in 46 files**. Search `h1` in the pattern register below.
This includes error, onboarding and conditional header branches; two branches in one file are two definitions, not two routes. Responsive utilities are preserved. Pages without their own h1 often compose a client component; no missing-heading defect is inferred solely from the route file.

- `app/page.tsx:140`: L140 `<h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl text-balance">`
- `app/onboarding/connect/page.tsx:193`: L193 `<h1 className="text-lg font-semibold tracking-tight text-card-foreground">`; L223 `<h1 className="text-base font-semibold text-card-foreground">`; L309 `<h1 className="mt-5 text-xl font-semibold tracking-tight text-card-foreground text-pretty">`
- `app/admin/_components/admin-page-client.tsx:160`: L160 `<h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl text-balance">`
- `app/dm-links/[portalSlug]/_components/dm-link-portal-client.tsx:775`: L775 `<h1 className="truncate text-2xl font-semibold text-pretty">`
- `app/global-error.tsx:33`: L33 `<h1 className="text-lg font-semibold">`
- `app/support/page.tsx:62`: L62 `<h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">`
- `app/workspace/billing/_components/billing-unavailable.tsx:12`: L12 `<h1 className="text-2xl font-semibold tracking-tight">`
- `app/workspace/closer/_components/closer-dashboard-header.tsx:27`: L27 `<h1 className="text-2xl font-bold tracking-tight text-pretty">`
- `app/workspace/closer/_components/closer-dashboard-page-client.tsx:196`: L196 `<h1 className="text-2xl font-semibold text-pretty">`
- `app/error.tsx:33`: L33 `<h1 className="text-lg font-semibold">`
- `app/workspace/closer/pipeline/_components/closer-pipeline-page-client.tsx:141`: L141 `<h1 className="text-3xl font-bold tracking-tight">`
- `app/workspace/leads/[leadId]/merge/_components/merge-page-client.tsx:159`: L159 `<h1 className="text-2xl font-semibold tracking-tight">`
- `app/workspace/lead-gen/_components/respark-batch.tsx:154`: L154 `<h1 className="text-2xl font-semibold tracking-normal text-pretty">`
- `app/onboarding/page.tsx:198`: L198 `<h1 className="text-lg font-semibold tracking-tight text-card-foreground">`; L246 `<h1 className="text-base font-semibold text-card-foreground">`
- `app/privacy/page.tsx:100`: L100 `<h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">`
- `app/workspace/_components/dashboard-header.tsx:17`: L17 `<h1 className="text-3xl font-bold tracking-tight">`
- `app/workspace/_components/dashboard-page-client.tsx:103`: L103 `<h1 className="text-2xl font-semibold tracking-tight">`
- `app/workspace/lead-gen/_components/lead-gen-settings-page-client.tsx:287`: L287 `<h1 className="text-2xl font-semibold tracking-normal">`
- `app/workspace/operations/booked-calls/_components/booked-calls-page-client.tsx:209`: L209 `<h1 className="text-2xl font-semibold tracking-tight">`
- `app/workspace/billing/_components/billing-page-client.tsx:108`: L108 `<h1 className="text-2xl font-semibold tracking-tight">`
- `app/workspace/lead-gen/_components/lead-gen-activity-page-client.tsx:109`: L109 `<h1 className="text-2xl font-semibold tracking-normal text-pretty">`
- `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx:131`: L131 `<h1 className="min-w-0 truncate text-base font-semibold" title={lead.fullName ?? undefined}>`
- `app/workspace/lead-gen/_components/lead-gen-capture-page-client.tsx:345`: L345 `<h1 className="text-2xl font-semibold tracking-normal text-pretty">`
- `app/workspace/operations/missed-meetings/_components/missed-meetings-page-client.tsx:129`: L129 `<h1 className="text-2xl font-semibold tracking-tight">`
- `app/workspace/lead-gen/_components/lead-gen-respark-page-client.tsx:107`: L107 `<h1 className="text-2xl font-semibold tracking-normal text-pretty">`
- `app/workspace/operations/booking-reviews/[reviewId]/_components/booking-review-page-client.tsx:112`: L112 `<h1 className="text-2xl font-semibold tracking-tight">`
- `app/workspace/leads-customers/[leadId]/_components/entity-header-section.tsx:50`: L50 `<h1 className="min-w-0 truncate font-brand text-3xl leading-none font-light tracking-tight text-pretty" translate="no" >`
- `app/workspace/profile/_components/profile-page-client.tsx:78`: L78 `<h1 className="text-2xl font-bold tracking-tight">`
- `app/workspace/leads-customers/_components/entity-browser-toolbar.tsx:45`: L45 `<h1 className="text-2xl font-semibold tracking-tight text-pretty">`
- `app/workspace/reports/pipeline/_components/pipeline-report-page-client.tsx:142`: L142 `<h1 className="text-2xl font-semibold tracking-tight">`
- `app/workspace/reports/activity/_components/activity-feed-page-client.tsx:98`: L98 `<h1 className="text-2xl font-semibold tracking-tight">`; L114 `<h1 className="text-2xl font-semibold tracking-tight">`
- `app/workspace/operations/booked-calls/attribution/_components/attribution-page-client.tsx:59`: L59 `<h1 className="text-2xl font-semibold tracking-tight">`
- `app/workspace/leads/_components/leads-page-content.tsx:66`: L66 `<h1 className="text-2xl font-semibold tracking-tight">`
- `app/workspace/reports/slack-qualifications/_components/slack-qualification-report-page-client.tsx:109`: L109 `<h1 className="text-2xl font-semibold tracking-tight">`
- `app/workspace/reports/team/_components/team-report-page-client.tsx:213`: L213 `<h1 className="text-2xl font-semibold tracking-tight">`
- `app/workspace/operations/booking-reviews/_components/booking-reviews-page-client.tsx:46`: L46 `<h1 className="text-2xl font-semibold tracking-tight">`
- `app/workspace/operations/sales-calls/_components/sales-calls-page-client.tsx:177`: L177 `<h1 className="text-2xl font-semibold tracking-tight">`
- `app/workspace/operations/lead-gen/_components/lead-gen-admin-page-client.tsx:178`: L178 `<h1 className="text-2xl font-semibold tracking-tight">`
- `app/workspace/settings/_components/settings-page-client.tsx:69`: L69 `<h1 className="text-3xl font-bold tracking-tight">`
- `app/workspace/team/redistribute/[unavailabilityId]/_components/redistribute-wizard-page-client.tsx:393`: L393 `<h1 className="text-2xl font-bold tracking-tight">`
- `app/workspace/team/_components/team-page-client.tsx:209`: L209 `<h1 className="text-3xl font-bold tracking-tight">`
- `app/workspace/operations/qualifications/_components/qualifications-page-client.tsx:164`: L164 `<h1 className="text-2xl font-semibold tracking-tight">`
- `app/workspace/opportunities/new/_components/create-opportunity-page-client.tsx:243`: L243 `<h1 className="text-2xl font-semibold tracking-tight">`
- `app/workspace/reports/leads/_components/leads-report-page-client.tsx:83`: L83 `<h1 className="text-2xl font-semibold tracking-tight">`
- `app/workspace/reports/reminders/_components/reminders-report-page-client.tsx:88`: L88 `<h1 className="text-2xl font-semibold tracking-tight">`
- `app/workspace/reports/revenue/_components/revenue-report-page-client.tsx:159`: L159 `<h1 className="text-2xl font-semibold tracking-tight">`

### All arbitrary type and tracking evidence

- `app/onboarding/page.tsx:263`: L263 `text-[11px]`
- `app/workspace/_components/top-qualifiers-card.tsx:94`: L94 `text-[10px]`; L102 `text-[10px]`
- `app/workspace/billing/_components/billing-event-history.tsx:97`: L97 `text-[0.68rem]`; L138 `text-[0.625rem]`; L163 `text-[0.625rem]`; L168 `text-[0.68rem]`; L191 `text-[0.68rem]`; L208 `text-[0.6rem]`; L214 `text-[0.68rem]`; L227 `text-[0.68rem]`
- `app/onboarding/connect/page.tsx:220`: L220 `text-[11px]`; L406 `text-[11px]`
- `app/admin/_components/invite-banner.tsx:64`: L64 `text-[11px]`
- `app/admin/_components/reset-tenant-dialog.tsx:227`: L227 `text-[11px]`
- `app/workspace/closer/meetings/_components/meeting-overview-card.tsx:109`: L109 `text-[10px]`; L227 `text-[10px]`; L316 `text-[10px]`; L338 `text-[10px]`
- `app/onboarding/_components/onboarding-shell.tsx:43`: L43 `text-[11px]`
- `app/dm-links/[portalSlug]/_components/dm-link-portal-client.tsx:349`: L349 `text-[13px]`; L358 `text-[11px]`; L384 `text-[0.65rem]`
- `app/workspace/leads-customers/[leadId]/_components/entity-activity-section.tsx:108`: L108 `text-[11px]`
- `app/workspace/_components/lead-gen-overview-card.tsx:72`: L72 `text-[10px]`; L82 `text-[10px]`
- `app/workspace/leads-customers/[leadId]/_components/entity-snapshot-aside.tsx:68`: L68 `text-[11px]`
- `app/workspace/_components/top-dm-closers-card.tsx:70`: L70 `text-[10px]`; L75 `text-[10px]`
- `app/workspace/closer/_components/pipeline-strip.tsx:237`: L237 `text-[10px]`; L359 `text-[11px]`
- `app/workspace/closer/meetings/_components/comment-entry.tsx:103`: L103 `text-[10px]`; L111 `text-[10px]`
- `app/workspace/closer/meetings/_components/meeting-history-timeline.tsx:72`: L72 `text-[10px]`
- `app/workspace/closer/meetings/_components/meeting-history-card.tsx:119`: L119 `text-[10px]`; L127 `text-[10px]`
- `app/workspace/leads-customers/[leadId]/_components/entity-portal-notes-section.tsx:48`: L48 `text-[10px]`; L52 `text-[11px]`
- `app/workspace/closer/meetings/_components/meeting-info-panel.tsx:164`: L164 `text-[10px]`
- `app/workspace/leads-customers/[leadId]/_components/entity-opportunity-row.tsx:117`: L117 `text-[11px]`; L130 `text-[11px]`
- `app/workspace/leads-customers/[leadId]/_components/entity-payments-section.tsx:78`: L78 `text-[11px]`
- `app/admin/_components/admin-page-client.tsx:157`: L157 `text-[11px]`; L191 `text-[11px]`; L452 `text-[11px]`
- `app/workspace/leads-customers/[leadId]/_components/entity-programs-section.tsx:99`: L99 `text-[11px]`; L117 `text-[11px]`
- `app/workspace/leads/[leadId]/merge/_components/merge-preview.tsx:122`: L122 `text-[10px]`
- `app/workspace/_components/workspace-shell-client.tsx:444`: L444 `text-[10px]`
- `app/workspace/billing/_components/billing-proof-preview.tsx:66`: L66 `text-[0.625rem]`; L91 `text-[0.625rem]`; L96 `text-[0.68rem]`; L143 `text-[0.68rem]`
- `app/workspace/closer/_components/meeting-block.tsx:112`: L112 `text-[10px]`; L233 `text-[11px]`
- `app/page.tsx:145`: L145 `text-[1.08em]`; L201 `text-[11px]`
- `app/workspace/_components/pipeline/pipeline-filters.tsx:90`: L90 `text-[10px]`
- `app/workspace/_components/overview-expandable-leaderboard.tsx:134`: L134 `text-[10px]`; L144 `text-[10px]`; L186 `text-[10px]`; L192 `text-[10px]`; L236 `text-[10px]`; L241 `text-[10px]`
- `app/workspace/billing/_components/slack-contributor-timeline.tsx:54`: L54 `text-[0.625rem]`; L79 `text-[0.625rem]`; L84 `text-[0.68rem]`; L103 `text-[0.68rem]`; L123 `text-[0.6rem]`; L130 `text-[0.65rem]`
- `app/workspace/closer/_components/day-view.tsx:88`: L88 `text-[11px]`
- `app/workspace/billing/_components/billing-payment-summary.tsx:93`: L93 `text-[0.65rem]`; L108 `text-[0.6rem]`; L135 `text-[0.72rem]`; L202 `text-[0.68rem]`; L235 `text-[0.72rem]`
- `app/workspace/leads-customers/[leadId]/_components/entity-comments-list.tsx:32`: L32 `text-[11px]`; L51 `text-[11px]`
- `app/workspace/closer/_components/week-view.tsx:126`: L126 `text-[11px]`; L152 `text-[11px]`
- `app/workspace/closer/_components/featured-meeting-card.tsx:91`: L91 `text-[11px]`
- `app/workspace/reports/activity/_components/activity-summary-cards.tsx:199`: L199 `text-[11px]`
- `app/workspace/leads-customers/[leadId]/_components/entity-detail-ui.tsx:53`: L53 `text-[11px]`; L59 `text-[11px]`; L77 `text-[10px]`; L113 `text-[11px]`
- `app/workspace/leads-customers/[leadId]/_components/entity-attribution-grid.tsx:12`: L12 `text-[10px]`
- `app/workspace/leads-customers/[leadId]/_components/entity-lifecycle-section.tsx:101`: L101 `text-[10px]`
- `components/notification-center.tsx:49`: L49 `text-[10px]`; L81 `text-[10px]`
- `app/workspace/closer/_components/month-view.tsx:68`: L68 `text-[11px]`; L126 `text-[10px]`
- `app/workspace/leads-customers/[leadId]/_components/opportunity-sheet-body.tsx:153`: L153 `text-[10px]`
- `components/command-palette.tsx:141`: L141 `text-[10px]`
- `app/workspace/reports/team/_components/closer-performance-table.tsx:161`: L161 `text-[11px]`
- `components/command-palette-trigger.tsx:28`: L28 `text-[10px]`

- `app/admin/_components/reset-tenant-dialog.tsx:227`: L227 `tracking-[0.2em]`
- `app/onboarding/page.tsx:249`: L249 `tracking-[0.15em]`; L263 `tracking-[0.2em]`
- `app/admin/_components/admin-page-client.tsx:157`: L157 `tracking-[0.25em]`; L191 `tracking-[0.2em]`
- `app/onboarding/connect/page.tsx:220`: L220 `tracking-[0.2em]`; L406 `tracking-[0.2em]`
- `app/workspace/billing/_components/billing-event-history.tsx:138`: L138 `tracking-[0.22em]`; L163 `tracking-[0.22em]`
- `app/workspace/billing/_components/billing-proof-preview.tsx:66`: L66 `tracking-[0.22em]`; L91 `tracking-[0.22em]`
- `app/workspace/billing/_components/billing-payment-summary.tsx:93`: L93 `tracking-[0.14em]`; L108 `tracking-[0.18em]`; L207 `tracking-[-0.02em]`
- `app/workspace/leads-customers/[leadId]/_components/opportunity-sheet-body.tsx:153`: L153 `tracking-[0.09em]`
- `app/workspace/billing/_components/slack-contributor-timeline.tsx:54`: L54 `tracking-[0.22em]`; L79 `tracking-[0.22em]`
- `app/workspace/leads-customers/[leadId]/_components/entity-attribution-grid.tsx:12`: L12 `tracking-[0.09em]`
- `app/workspace/leads-customers/[leadId]/_components/entity-lifecycle-section.tsx:101`: L101 `tracking-[0.09em]`
- `app/workspace/leads-customers/[leadId]/_components/entity-detail-ui.tsx:77`: L77 `tracking-[0.09em]`
- `app/workspace/reports/reminders/_components/reminder-funnel-chart.tsx:41`: L41 `tracking-[0.24em]`
- `app/workspace/reports/reminders/_components/reminder-outcome-card-grid.tsx:44`: L44 `tracking-[0.22em]`
- `app/workspace/reports/reminders/_components/reminder-driven-revenue-card.tsx:44`: L44 `tracking-[0.22em]`; L66 `tracking-[0.22em]`

## 3. Spacing and layout drift

Count: **216 matches in 112 files**. Search `layout` in the pattern register below.
These are inventory candidates; calculated grids, responsive overlays, and calendar geometry may be valid. They still need named system recipes before redesign.

Count: **27 matches in 14 files**. Search `space` in the pattern register below.
The styling rules explicitly require gap instead of space-x/y.

- `app/admin/_components/reset-tenant-dialog.tsx:138`: L138 `space-y-2`; L142 `space-y-1`
- `app/dm-links/[portalSlug]/_components/dm-link-portal-client.tsx:887`: L887 `space-y-3`; L930 `space-y-4`; L1011 `space-y-4`; L1058 `space-y-4`; L1075 `space-y-3`; L1083 `space-y-2`
- `app/workspace/closer/meetings/_components/reschedule-link-display.tsx:49`: L49 `space-y-2`
- `app/workspace/customers/[customerId]/loading.tsx:7`: L7 `space-y-2`
- `app/workspace/operations/_components/pipeline-recovery-panel.tsx:72`: L72 `space-y-5`; L142 `space-y-3`
- `app/workspace/reports/leads/_components/field-answer-distribution.tsx:48`: L48 `space-y-3`
- `app/workspace/operations/booked-calls/attribution/_components/attribution-page-client.tsx:92`: L92 `space-y-4`
- `app/workspace/team/redistribute/[unavailabilityId]/_components/redistribute-wizard-page-client.tsx:382`: L382 `space-y-1`; L525 `space-y-2`
- `app/workspace/settings/_components/event-type-config-dialog.tsx:367`: L367 `space-y-1`
- `app/workspace/reports/leads/_components/conversion-kpi-cards.tsx:25`: L25 `space-y-0`; L38 `space-y-0`; L53 `space-y-0`
- `app/workspace/customers/loading.tsx:8`: L8 `space-y-2`; L18 `space-y-2`
- `app/workspace/reports/leads/_components/form-response-analytics-section.tsx:53`: L53 `space-y-3`; L63 `space-y-4`; L81 `space-y-3`
- `app/workspace/team/redistribute/[unavailabilityId]/loading.tsx:6`: L6 `space-y-2`
- `app/workspace/pipeline/reminders/[followUpId]/_components/admin-reminder-outcome-action-bar.tsx:120`: L120 `space-y-2`

### Page geometry

- Workspace shell applies `p-6` at `app/workspace/_components/workspace-shell-client.tsx:523`. Most reports and settings inherit it. The entity browser adds `px-4 py-4 sm:px-6 lg:px-8` inside that shell, `app/workspace/leads-customers/_components/leads-customers-page-client.tsx:26`; detail adds `px-4 py-5 sm:px-6 lg:px-8`, `app/workspace/leads-customers/[leadId]/_components/entity-detail-layout.tsx:17`. This creates a second gutter on those routes.
- **10 explicit page/layout wrapper definitions**, using **7 distinct max-width tokens**. Search: width-bearing lines in `*page-client*`, `page.tsx`, or `*layout*` containing `mx-auto`, then retain `<div` wrappers. This excludes centered paragraphs. Different widths can remain as named container modes.

- `app/admin/_components/admin-page-client.tsx:149`: `<div className="mx-auto flex w-full max-w-6xl flex-col gap-6">`
- `app/privacy/page.tsx:79`: `<div className="mx-auto flex w-full max-w-3xl flex-col gap-10">`
- `app/support/page.tsx:41`: `<div className="mx-auto flex w-full max-w-3xl flex-col gap-10">`
- `app/workspace/_components/dashboard-page-client.tsx:98`: `<div className="mx-auto flex w-full max-w-[1500px] flex-col gap-6 pb-6">`
- `app/workspace/closer/_components/closer-dashboard-page-client.tsx:191`: `<div className="mx-auto flex w-full max-w-[1500px] flex-col gap-4 pb-6">`
- `app/workspace/lead-gen/_components/lead-gen-capture-page-client.tsx:342`: `<div className="mx-auto flex w-full max-w-xl flex-col gap-5">`
- `app/workspace/leads-customers/[leadId]/_components/entity-detail-layout.tsx:17`: `<div className="mx-auto flex w-full max-w-352 flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8">`
- `app/workspace/leads-customers/_components/leads-customers-page-client.tsx:26`: `<div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">`
- `app/workspace/opportunities/new/_components/create-opportunity-page-client.tsx:232`: `<div className="mx-auto flex w-full max-w-3xl flex-col gap-6">`
- `app/workspace/profile/_components/profile-page-client.tsx:76`: `<div className="mx-auto flex max-w-2xl flex-col gap-6">`

### Card padding

Count: **59 matches in 40 files**. Search `card-padding` in the pattern register below.
The search counts literal className padding overrides on Card/CardHeader/CardContent/CardFooter, including multiline opening tags. Conditional padding is additional, for example StatsCard at `app/workspace/_components/stats-card.tsx:56`. Use density variants instead of rebuilding the padding contract in each feature.

- `app/workspace/_components/phone-closer-operations-section.tsx:28`: L28 `<CardHeader className="pb-`
- `app/workspace/_components/pipeline/pipeline-filters.tsx:75`: L75 `<CardContent className="pt-`
- `app/workspace/_components/skeletons/stats-row-skeleton.tsx:27`: L27 `<CardHeader className="pb-`
- `app/workspace/_components/top-origins-overview-section.tsx:28`: L28 `<CardHeader className="pb-`
- `app/workspace/_components/system-health.tsx:144`: L144 `<CardContent className="pt-`
- `app/workspace/closer/meetings/_components/lead-notes-card.tsx:34`: L34 `<CardHeader className="pb-`
- `app/workspace/billing/_components/billing-review-page-client.tsx:45`: L45 `<CardHeader className="pb-`
- `app/workspace/closer/meetings/_components/payment-links-panel.tsx:29`: L29 `<CardHeader className="pb-`
- `app/workspace/closer/pipeline/_components/closer-pipeline-page-client.tsx:260`: L260 `<CardContent className="pt-`
- `app/workspace/closer/meetings/_components/attribution-card.tsx:66`: L66 `<CardHeader className="pb-`
- `app/workspace/closer/_components/reminders-section.tsx:60`: L60 `<CardHeader className="pb-`; L69 `<CardContent className="flex-1 p-`
- `app/workspace/closer/meetings/_components/deal-won-card.tsx:90`: L90 `<CardHeader className="pb-`
- `app/workspace/closer/meetings/_components/meeting-history-card.tsx:79`: L79 `<CardContent className="pt-`
- `app/workspace/closer/_components/featured-meeting-card.tsx:85`: L85 `<CardHeader className="pb-`
- `app/workspace/closer/meetings/_components/meeting-info-panel.tsx:67`: L67 `<CardHeader className="pb-`; L101 `<CardContent className="pt-`
- `app/workspace/closer/meetings/_components/booking-answers-card.tsx:44`: L44 `<CardHeader className="pb-`
- `app/workspace/closer/meetings/_components/follow-up-dialog.tsx:179`: L179 `<CardHeader className="pb-`; L203 `<CardHeader className="pb-`
- `app/workspace/closer/meetings/_components/reschedule-link-display.tsx:35`: L35 `<CardHeader className="flex flex-row items-center justify-between pb-`
- `app/workspace/closer/meetings/_components/lead-info-panel.tsx:43`: L43 `<CardHeader className="pb-`; L95 `<CardHeader className="pb-`
- `app/workspace/operations/booking-reviews/_components/booking-reviews-page-client.tsx:66`: L66 `<Card className="py-`; L67 `<CardContent className="px-`
- `app/workspace/leads/[leadId]/merge/loading.tsx:29`: L29 `<Card className="p-`; L40 `<Card className="p-`
- `app/workspace/leads/[leadId]/merge/_components/merge-page-client.tsx:174`: L174 `<CardHeader className="pb-`
- `app/workspace/leads/_components/skeletons/leads-skeleton.tsx:29`: L29 `<Card className="p-`
- `app/workspace/leads/_components/leads-page-content.tsx:82`: L82 `<Card className="p-`
- `app/workspace/leads/[leadId]/merge/_components/merge-preview.tsx:80`: L80 `<CardHeader className="pb-`; L155 `<CardHeader className="pb-`; L248 `<CardHeader className="pb-`
- `app/workspace/operations/missed-meetings/_components/missed-meetings-page-client.tsx:221`: L221 `<Card className="py-`; L222 `<CardContent className="px-`
- `app/workspace/operations/lead-gen/_components/lead-gen-summary-cards.tsx:87`: L87 `<CardHeader className="flex flex-row items-center justify-between gap-2 pb-`; L95 `<CardContent className="pt-`
- `app/workspace/operations/sales-calls/_components/sales-calls-stat-cards.tsx:101`: L101 `<CardHeader className="flex flex-row items-center justify-between gap-2 pb-`; L109 `<CardContent className="pt-`; L123 `<CardHeader className="flex flex-row items-center justify-between gap-2 pb-`; L134 `<CardContent className="pt-`
- `app/workspace/pipeline/meetings/_components/admin-follow-up-dialog.tsx:160`: L160 `<CardHeader className="pb-`; L184 `<CardHeader className="pb-`
- `app/workspace/pipeline/loading.tsx:21`: L21 `<CardContent className="pt-`
- `app/workspace/opportunities/_components/skeletons/opportunities-page-skeleton.tsx:22`: L22 `<Card className="p-`
- `app/workspace/reports/reminders/_components/reminder-funnel-chart.tsx:69`: L69 `<CardContent className="pt-`
- `app/workspace/reports/leads/_components/conversion-kpi-cards.tsx:25`: L25 `<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-`; L38 `<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-`; L53 `<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-`
- `app/workspace/reports/revenue/_components/revenue-kpi-cards.tsx:22`: L22 `<CardHeader className="pb-`
- `app/workspace/team/_components/team-page-client.tsx:57`: L57 `<CardContent className="pt-`
- `app/workspace/settings/_components/program-row.tsx:114`: L114 `<CardContent className="flex items-start justify-between gap-4 py-`
- `app/workspace/settings/_components/event-type-config-list.tsx:188`: L188 `<CardHeader className="gap-4 pb-`; L208 `<CardContent className="p-`
- `app/workspace/settings/_components/programs-tab.tsx:92`: L92 `<CardContent className="flex flex-col items-center gap-4 py-`; L113 `<CardContent className="flex flex-col items-center gap-4 py-`
- `app/workspace/team/redistribute/[unavailabilityId]/_components/redistribute-wizard-page-client.tsx:845`: L845 `<CardContent className="py-`; L964 `<CardContent className="flex flex-col items-center gap-4 py-`
- `app/workspace/team/loading.tsx:21`: L21 `<CardContent className="pt-`

### Arbitrary layout values, complete inventory

- `app/workspace/_components/dashboard-page-client.tsx:98`: L98 `max-w-[1500px]`; L101 `mt-[3px]`; L101 `w-[3px]`; L144 `h-[320px]`; L145 `h-[360px]`
- `app/workspace/_components/ops-searchable-list.tsx:120`: L120 `min-h-[160px]`; L130 `max-h-[520px]`
- `app/workspace/_components/dashboard-date-range-filter.tsx:117`: L117 `w-[calc(100vw-2rem)]`
- `app/workspace/_components/lead-gen-overview-card.tsx:94`: L94 `grid-cols-[1.25rem_auto_minmax(0,1fr)_auto]`
- `app/workspace/_components/ops-bar-chart-card.tsx:117`: L117 `min-h-[160px]`
- `app/workspace/_components/phone-closer-operations-table.tsx:33`: L33 `min-w-[52rem]`
- `app/workspace/closer/_components/closer-dashboard-page-client.tsx:191`: L191 `max-w-[1500px]`; L194 `mt-[3px]`; L194 `w-[3px]`; L229 `grid-cols-[repeat(auto-fit,minmax(min(100%,340px),1fr))]`
- `app/workspace/billing/_components/slack-contributor-timeline.tsx:99`: L99 `grid-cols-[5.5rem_0.75rem_1fr]`
- `app/workspace/_components/top-origins-overview-table.tsx:33`: L33 `min-w-[44rem]`; L36 `w-[48%]`
- `app/workspace/closer/meetings/_components/comment-entry.tsx:165`: L165 `min-h-[60px]`
- `app/workspace/closer/_components/day-view.tsx:81`: L81 `h-[calc(100dvh-20rem)]`; L81 `min-h-[400px]`; L88 `h-[60px]`; L99 `h-[60px]`
- `app/workspace/_components/top-qualifiers-card.tsx:94`: L94 `grid-cols-[1.25rem_minmax(0,1fr)_auto]`; L114 `grid-cols-[1.25rem_auto_minmax(0,1fr)_auto]`
- `app/workspace/closer/_components/week-view.tsx:111`: L111 `h-[calc(100dvh-20rem)]`; L111 `min-h-[400px]`; L112 `min-w-[700px]`; L114 `grid-cols-[4rem_repeat(7,1fr)]`; L144 `grid-cols-[4rem_repeat(7,1fr)]`; L152 `h-[60px]`; L176 `h-[60px]`
- `app/workspace/billing/_components/billing-review-page-client.tsx:141`: L141 `grid-cols-[minmax(0,1fr)_minmax(0,1fr)]`
- `app/workspace/closer/_components/closer-dashboard-skeleton.tsx:6`: L6 `max-w-[1500px]`; L12 `mt-[3px]`; L12 `w-[3px]`; L21 `grid-cols-[repeat(auto-fit,minmax(min(100%,340px),1fr))]`; L22 `h-[180px]`; L23 `h-[180px]`; L33 `h-[78px]`; L34 `h-[78px]`; L35 `h-[78px]`; L57 `h-[400px]`
- `app/workspace/billing/_components/billing-page-skeleton.tsx:29`: L29 `h-[460px]`
- `app/workspace/_components/top-dm-closers-card.tsx:84`: L84 `grid-cols-[1.25rem_auto_minmax(0,1fr)_auto]`
- `app/workspace/billing/_components/billing-event-history.tsx:187`: L187 `grid-cols-[5.5rem_0.75rem_1fr]`
- `app/workspace/closer/_components/reminders-section.tsx:70`: L70 `max-h-[220px]`
- `app/workspace/closer/_components/calendar-view.tsx:125`: L125 `h-[72px]`; L134 `h-[52px]`
- `app/admin/_components/admin-page-client.tsx:230`: L230 `w-[180px]`
- `app/workspace/closer/meetings/_components/comment-input.tsx:109`: L109 `min-h-[72px]`; L135 `max-w-[200px]`
- `app/workspace/leads-customers/[leadId]/_components/entity-detail-layout.tsx:19`: L19 `grid-cols-[minmax(0,1fr)_21rem]`; L19 `grid-cols-[minmax(0,1fr)_23rem]`
- `app/workspace/closer/_components/pipeline-strip.tsx:260`: L260 `min-w-[3px]`
- `app/workspace/lead-gen/_components/lead-gen-activity-page-client.tsx:167`: L167 `h-[360px]`
- `app/workspace/_components/goal-progress-ring.tsx:99`: L99 `min-h-[200px]`; L248 `max-w-[250px]`
- `app/workspace/closer/meetings/_components/meeting-comments.tsx:140`: L140 `max-h-[80vh]`
- `app/workspace/operations/missed-meetings/_components/missed-meetings-page-client.tsx:202`: L202 `h-[480px]`
- `app/workspace/_components/skeletons/overview-dashboard-skeleton.tsx:7`: L7 `max-w-[1500px]`; L32 `h-[320px]`; L33 `h-[360px]`
- `app/workspace/leads-customers/_components/leads-customers-skeleton.tsx:27`: L27 `grid-cols-[minmax(0,1.6fr)_8rem_minmax(0,1fr)_8rem]`
- `app/workspace/lead-gen/_components/lead-gen-activity-skeleton.tsx:19`: L19 `h-[360px]`
- `app/workspace/operations/booked-calls/_components/dm-closer-contributions-table.tsx:80`: L80 `h-[280px]`; L95 `w-[34%]`; L103 `w-[20%]`; L126 `w-[18%]`
- `app/workspace/_components/deal-credit-list.tsx:85`: L85 `grid-cols-[5rem_minmax(0,1fr)_auto]`; L128 `grid-cols-[auto_minmax(0,1fr)]`
- `app/workspace/leads-customers/[leadId]/_components/entity-activity-section.tsx:82`: L82 `grid-cols-[auto_1fr]`; L87 `left-[3.5px]`
- `app/workspace/leads-customers/[leadId]/_components/entity-detail-skeleton.tsx:16`: L16 `grid-cols-[minmax(0,1fr)_21rem]`; L16 `grid-cols-[minmax(0,1fr)_23rem]`; L24 `w-[calc(100%-1.5rem)]`; L35 `w-[calc(100%-1.5rem)]`
- `app/workspace/billing/_components/billing-queue-table.tsx:78`: L78 `h-[440px]`
- `app/workspace/_components/overview-expandable-leaderboard.tsx:153`: L153 `grid-cols-[1.25rem_auto_minmax(0,1fr)_auto]`; L186 `grid-cols-[1.25rem_minmax(0,1fr)_auto]`; L201 `grid-cols-[1.25rem_auto_minmax(0,1fr)_auto]`; L250 `grid-cols-[1.25rem_auto_minmax(0,1fr)_auto]`
- `app/workspace/operations/booked-calls/attribution/_components/attribution-page-client.tsx:57`: L57 `mt-[3px]`; L57 `w-[3px]`; L108 `grid-cols-[minmax(0,1fr)_400px]`
- `app/workspace/operations/missed-meetings/_components/missed-meetings-page-skeleton.tsx:18`: L18 `w-[520px]`; L23 `h-[480px]`
- `app/workspace/closer/_components/calendar-section.tsx:21`: L21 `h-[400px]`
- `app/workspace/leads-customers/[leadId]/_components/entity-snapshot-aside.tsx:179`: L179 `left-[0.4rem]`
- `app/workspace/_components/slack-user-leaderboard-card.tsx:66`: L66 `grid-cols-[auto_1fr_auto]`
- `app/workspace/leads-customers/_components/entity-browser-results-loading.tsx:13`: L13 `grid-cols-[minmax(0,1.6fr)_8rem_minmax(0,1fr)_8rem]`
- `app/workspace/closer/_components/month-view.tsx:87`: L87 `min-h-[80px]`
- `app/workspace/lead-gen/_components/respark-batch.tsx:280`: L280 `grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_auto]`; L300 `grid-cols-[auto_1fr]`
- `app/workspace/billing/_components/billing-proof-preview.tsx:106`: L106 `h-[min(420px,52vh)]`; L106 `max-h-[min(420px,52vh)]`; L169 `max-w-[min(calc(100vw-2rem),1600px)]`; L169 `max-w-[min(calc(100vw-2rem),1600px)]`; L173 `max-h-[min(90vh,1200px)]`; L173 `max-w-[min(calc(100vw-2rem),1600px)]`
- `app/workspace/operations/sales-calls/_components/per-program-stat-card.tsx:136`: L136 `min-w-[10rem]`; L277 `h-[280px]`; L282 `min-h-[200px]`; L348 `max-h-[300px]`; L386 `w-[32%]`; L416 `w-[18%]`
- `app/workspace/billing/_components/billing-payment-summary.tsx:161`: L161 `grid-cols-[max-content_1fr]`
- `app/workspace/operations/lead-gen/_components/raw-submissions-table.tsx:196`: L196 `h-[420px]`; L215 `w-[18%]`; L216 `w-[20%]`
- `app/workspace/operations/_components/operations-page-skeleton.tsx:15`: L15 `h-[420px]`
- `app/workspace/operations/booked-calls/attribution/_components/attribution-page-skeleton.tsx:12`: L12 `mt-[3px]`; L12 `w-[3px]`
- `app/workspace/closer/meetings/_components/mark-lost-dialog.tsx:147`: L147 `min-h-[100px]`
- `app/workspace/leads-customers/[leadId]/_components/entity-opportunity-row.tsx:48`: L48 `w-[3px]`
- `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx:257`: L257 `max-h-[80vh]`
- `app/workspace/closer/reminders/[followUpId]/_components/reminder-mark-lost-dialog.tsx:156`: L156 `min-h-[100px]`
- `app/workspace/opportunities/[opportunityId]/_components/opportunity-detail-skeleton.tsx:19`: L19 `grid-cols-[1fr_20rem]`
- `app/workspace/reports/pipeline/_components/pipeline-report-skeleton.tsx:12`: L12 `h-[300px]`; L31 `h-[340px]`; L32 `h-[340px]`
- `app/workspace/operations/lead-gen/_components/respark-performance-table.tsx:68`: L68 `h-[240px]`
- `app/workspace/error.tsx:23`: L23 `min-h-[50vh]`
- `app/workspace/leads/[leadId]/merge/_components/merge-preview.tsx:225`: L225 `grid-cols-[1fr_auto_1fr]`
- `app/workspace/lead-gen/_components/lead-gen-settings-skeleton.tsx:15`: L15 `h-[360px]`
- `app/workspace/operations/lead-gen/_components/prospect-conversion-table.tsx:114`: L114 `h-[240px]`
- `app/workspace/lead-gen/_components/lead-gen-respark-page-client.tsx:170`: L170 `grid-cols-[0.75rem_1fr_auto]`
- `app/workspace/operations/_components/report-snapshot-table.tsx:114`: L114 `h-[280px]`
- `app/workspace/operations/sales-calls/_components/phone-closer-table.tsx:203`: L203 `h-[280px]`; L215 `min-w-[1080px]`
- `app/workspace/operations/booked-calls/_components/booked-calls-page-client.tsx:58`: L58 `max-w-[220px]`; L207 `mt-[3px]`; L207 `w-[3px]`
- `app/workspace/reports/_components/report-attribution-filters.tsx:63`: L63 `w-[200px]`; L90 `w-[200px]`
- `app/workspace/reports/leads/_components/form-response-analytics-section.tsx:54`: L54 `w-[300px]`; L68 `w-[300px]`
- `app/workspace/opportunities/[opportunityId]/_components/opportunity-activity-timeline.tsx:118`: L118 `grid-cols-[auto_1fr]`
- `app/workspace/reports/_components/report-date-controls.tsx:203`: L203 `w-[100px]`
- `app/workspace/operations/lead-gen/_components/top-origins-table.tsx:42`: L42 `h-[320px]`
- `app/workspace/reports/pipeline/_components/pipeline-report-page-client.tsx:157`: L157 `h-[300px]`; L236 `h-[340px]`; L245 `h-[340px]`
- `app/workspace/leads-customers/_components/entity-result-row.tsx:37`: L37 `max-w-[24rem]`
- `app/workspace/operations/qualifications/_components/qualifications-page-client.tsx:52`: L52 `max-w-[220px]`; L162 `mt-[3px]`; L162 `w-[3px]`
- `app/workspace/operations/booked-calls/_components/booked-calls-page-skeleton.tsx:22`: L22 `h-[340px]`; L23 `h-[340px]`; L25 `h-[300px]`; L26 `h-[260px]`
- `app/workspace/reports/reminders/_components/reminders-report-skeleton.tsx:13`: L13 `w-[32rem]`; L22 `grid-cols-[minmax(0,1.5fr)_minmax(18rem,0.5fr)]`; L23 `h-[420px]`; L24 `h-[420px]`; L33 `h-[340px]`; L34 `h-[320px]`
- `app/workspace/operations/sales-calls/_components/sales-calls-page-skeleton.tsx:27`: L27 `h-[340px]`; L28 `h-[320px]`; L29 `h-[260px]`
- `app/workspace/operations/qualifications/_components/setter-contributions-table.tsx:84`: L84 `h-[280px]`; L99 `w-[45%]`; L125 `w-[22%]`
- `app/workspace/reports/revenue/_components/revenue-trend-chart.tsx:73`: L73 `min-h-[260px]`; L81 `h-[300px]`
- `app/workspace/reports/revenue/_components/revenue-report-skeleton.tsx:17`: L17 `h-[260px]`
- `app/workspace/reports/slack-qualifications/_components/setter-qualification-trend.tsx:80`: L80 `min-h-[260px]`; L95 `h-[320px]`
- `app/workspace/reports/pipeline/_components/stage-distribution-chart.tsx:75`: L75 `h-[200px]`; L79 `max-h-[300px]`
- `app/workspace/settings/_components/event-type-config-dialog.tsx:274`: L274 `max-h-[85vh]`
- `app/workspace/opportunities/new/_components/lead-combobox.tsx:103`: L103 `w-[--radix-popover-trigger-width]`
- `app/workspace/reports/reminders/_components/reminders-report-page-client.tsx:111`: L111 `h-[360px]`; L141 `grid-cols-[minmax(0,1.5fr)_minmax(18rem,0.5fr)]`; L143 `min-h-[360px]`
- `app/workspace/team/redistribute/[unavailabilityId]/loading.tsx:18`: L18 `h-[400px]`
- `app/workspace/operations/lead-gen/_components/lead-gen-admin-skeleton.tsx:30`: L30 `h-[420px]`; L31 `h-[360px]`
- `app/workspace/reports/revenue/_components/booked-vs-sold-matrix.tsx:66`: L66 `min-w-[44rem]`
- `app/workspace/operations/lead-gen/_components/lead-gen-admin-page-client.tsx:176`: L176 `mt-[3px]`; L176 `w-[3px]`
- `app/workspace/reports/revenue/_components/revenue-by-origin-chart.tsx:156`: L156 `min-h-[260px]`; L162 `h-[260px]`
- `app/workspace/reports/activity/_components/activity-feed-filters.tsx:128`: L128 `w-[160px]`; L163 `w-[240px]`; L191 `w-[200px]`
- `app/workspace/reports/team/_components/closer-performance-table.tsx:95`: L95 `min-w-[76rem]`
- `app/workspace/reports/leads/_components/field-answer-distribution.tsx:60`: L60 `min-h-[250px]`
- `app/workspace/operations/qualifications/_components/qualifications-page-skeleton.tsx:21`: L21 `h-[340px]`; L22 `h-[340px]`; L24 `h-[300px]`; L25 `h-[260px]`
- `app/workspace/reports/reminders/_components/reminder-funnel-chart.tsx:70`: L70 `grid-cols-[minmax(0,0.9fr)_auto_minmax(0,0.9fr)_auto_minmax(0,1.35fr)]`
- `app/workspace/team/_components/team-members-table.tsx:249`: L249 `max-w-[200px]`
- `app/workspace/reports/reminders/_components/reminder-chain-length-histogram.tsx:55`: L55 `min-h-[280px]`
- `app/workspace/reports/revenue/_components/deal-size-distribution.tsx:53`: L53 `min-h-[250px]`; L59 `min-h-[250px]`
- `app/workspace/reports/team/_components/team-report-page-client.tsx:380`: L380 `min-w-[48rem]`
- `app/workspace/reports/slack-qualifications/_components/setter-contribution-table.tsx:54`: L54 `min-w-[56rem]`
- `app/workspace/reports/_components/report-program-filter.tsx:66`: L66 `w-[200px]`
- `app/workspace/team/redistribute/[unavailabilityId]/_components/redistribute-wizard-page-client.tsx:537`: L537 `h-[400px]`
- `app/workspace/reports/revenue/_components/revenue-report-page-client.tsx:200`: L200 `h-[300px]`; L203 `grid-cols-[minmax(0,1.4fr)_minmax(20rem,1fr)]`; L207 `h-[260px]`
- `app/workspace/reports/team/_components/meeting-outcome-distribution-chart.tsx:105`: L105 `grid-cols-[minmax(0,1fr)_18rem]`; L108 `max-h-[320px]`
- `app/workspace/operations/booked-calls/attribution/_components/attribution-registry.tsx:210`: L210 `grid-cols-[0.9fr_1.1fr]`
- `app/workspace/operations/booked-calls/attribution/_components/team-event-types-card.tsx:193`: L193 `w-[30%]`
- `app/workspace/pipeline/meetings/_components/admin-mark-lost-dialog.tsx:142`: L142 `min-h-[100px]`
- `app/workspace/settings/_components/event-type-config-list.tsx:214`: L214 `max-h-[min(68vh,720px)]`
- `app/workspace/reports/_components/report-payment-type-filter.tsx:52`: L52 `w-[180px]`
- `app/workspace/operations/lead-gen/_components/specialist-performance-table.tsx:148`: L148 `h-[320px]`; L163 `w-[55%]`
- `app/workspace/operations/sales-calls/_components/sales-calls-page-client.tsx:175`: L175 `mt-[3px]`; L175 `w-[3px]`
- `app/workspace/team/_components/mark-unavailable-dialog.tsx:358`: L358 `min-h-[80px]`

## 4. One-off components

Feature-specific composition is often appropriate. The following inventories identify visual recipes to share while retaining feature data and behaviour. Filename searches below are candidate inventories, not claims that every item should be merged into a universal component.

Rounded bordered/card-background custom markup: **113 matches in 75 files**, search `panel`. Some are list rows and callouts, not complete cards. Shared Empty is already used **57 times in 51 files**, search `empty`; preserve these rather than rewriting them.

### Variants and proposed shared recipes

| Kind | Variants with evidence | Absorb into |
|---|---|---|
| Badge/pill | shared deal `components/status-badge.tsx:17`; feature lead `app/workspace/leads/_components/lead-status-badge.tsx:38`; enrollment `app/workspace/leads-customers/[leadId]/_components/enrollment-status-badge.tsx:18`; source `app/workspace/_components/initial-source-badge.tsx:37`; opportunity-source `app/workspace/opportunities/_components/opportunity-source-badge.tsx:3`; custom cash/PIF spans `app/workspace/leads-customers/[leadId]/_components/entity-opportunity-row.tsx:61` and `:66`; count pill `entity-detail-ui.tsx:53` in that folder; navigation count `app/workspace/_components/workspace-shell-client.tsx:444`. | Shared StatusBadge with domain mappings, SourceBadge, count badge; all built on Badge. Keep status meaning separate from intensity/density. |
| Cards/panels | ordinary Card; local ENTITY_PANEL_CLASS `app/workspace/leads-customers/[leadId]/_components/entity-detail-ui.tsx:12`; captured lead section `app/workspace/lead-gen/_components/lead-gen-capture-page-client.tsx:483`; admin summary div `app/admin/_components/admin-page-client.tsx:189`; tinted won card `app/workspace/closer/meetings/_components/deal-won-card.tsx:89`; funnel stage `app/workspace/reports/reminders/_components/reminder-funnel-chart.tsx:38`. | Card density/emphasis variants plus SectionHeader and detail-panel recipe. Domain cards remain domain components. |
| KPI/stat tiles | StatsCard `app/workspace/_components/stats-card.tsx:41`; overview-top-cards; conversion-kpi-cards; revenue-kpi-cards; sales-calls-stat-cards; activity-summary-cards; lead-gen-summary-cards; setter-qualification-summary-cards. Exact paths/lines in filename inventory below. | Shared MetricCard with label/value/delta/help/loading, density and semantic tone; compose domain calculations outside it. |
| Empty states | OverviewEmptyState `app/workspace/_components/overview-section-state.tsx:11`; CloserEmptyState `app/workspace/closer/_components/closer-empty-state.tsx:1`; entity not-found `app/workspace/leads-customers/[leadId]/_components/entity-detail-empty-states.tsx:13`; report div empty states in revenue-trend `app/workspace/reports/revenue/_components/revenue-trend-chart.tsx:75`, stage-distribution `app/workspace/reports/pipeline/_components/stage-distribution-chart.tsx:76`, field answers `app/workspace/reports/leads/_components/field-answer-distribution.tsx:38`; settings programs `app/workspace/settings/_components/programs-tab.tsx:92`. | Empty recipe with full-page, section, compact-table, filtered, unavailable and no-data modes; keep failure distinct from no data. |
| Page headers | dashboard-header vs dashboard-page-client; closer-dashboard-header vs closer-dashboard-page-client; report clients; entity toolbar; profile/team/settings; full h1 inventory above. | PageHeader with title/description/actions/back/meta, title type role and density. Separate public/onboarding heading roles. |
| Tables and responsive lists | shared SortableHeader `components/sortable-header.tsx:12`; leads table, opportunities-table, billing-queue-table, team-members-table; report tables; entity-browser-results and entity-result-mobile-card; operations detail lists. Filename inventory below. | DataTableFrame, sort header, row actions, empty/loading/footer and mobile row recipes; retain domain columns and queries. |
| Filters and date pickers | time-period-filter, dashboard-date-range-filter, report-date-controls, calendar-header, pipeline-filters, activity-feed-filters, entity-browser-toolbar, lead-search-input. Filename inventory below. | FilterBar, search input, date-range control, period navigation, applied-filter summary. Keep date/business-day semantics in their existing logic. |

### Filename inventories and exact counts

**Badge/pill modules: 5 files.** Filename search: `rg --files app components hooks lib | rg '(?:badge|pill)\.tsx$'`, excluding `components/ui/`. Each listed file is a variant candidate, not a confirmed duplicate.

- `app/workspace/_components/initial-source-badge.tsx:17`
- `app/workspace/leads-customers/[leadId]/_components/enrollment-status-badge.tsx:18`
- `app/workspace/leads/_components/lead-status-badge.tsx:38`
- `app/workspace/opportunities/_components/opportunity-source-badge.tsx:3`
- `components/status-badge.tsx:21`

**KPI/stat modules: 11 files.** Filename search: `rg --files app components hooks lib | rg '(?:stats?-card|stat-cards|summary-cards|kpi-cards|overview-top-cards|metric-card)\.tsx$'`, excluding `components/ui/`. Each listed file is a variant candidate, not a confirmed duplicate.

- `app/workspace/_components/overview-top-cards.tsx:12`
- `app/workspace/_components/stats-card.tsx:41`
- `app/workspace/operations/lead-gen/_components/lead-gen-summary-cards.tsx:31`
- `app/workspace/operations/sales-calls/_components/per-program-stat-card.tsx:111`
- `app/workspace/operations/sales-calls/_components/sales-calls-stat-cards.tsx:35`
- `app/workspace/reports/activity/_components/activity-summary-cards.tsx:69`
- `app/workspace/reports/leads/_components/conversion-kpi-cards.tsx:17`
- `app/workspace/reports/pipeline/_components/velocity-metric-card.tsx:15`
- `app/workspace/reports/revenue/_components/revenue-kpi-cards.tsx:19`
- `app/workspace/reports/slack-qualifications/_components/setter-qualification-summary-cards.tsx:40`
- `app/workspace/reports/team/_components/team-kpi-summary-cards.tsx:36`

**Empty/state modules: 3 files.** Filename search: `rg --files app components hooks lib | rg '(?:empty-state|empty-states|overview-section-state)\.tsx$'`, excluding `components/ui/`. Each listed file is a variant candidate, not a confirmed duplicate.

- `app/workspace/_components/overview-section-state.tsx:10`
- `app/workspace/closer/_components/closer-empty-state.tsx:24`
- `app/workspace/leads-customers/[leadId]/_components/entity-detail-empty-states.tsx:12`

**Header modules: 5 files.** Filename search: `rg --files app components hooks lib | rg '(?:header|toolbar)\.tsx$'`, excluding `components/ui/`. Each listed file is a variant candidate, not a confirmed duplicate.

- `app/workspace/_components/dashboard-header.tsx:12`
- `app/workspace/closer/_components/calendar-header.tsx:24`
- `app/workspace/closer/_components/closer-dashboard-header.tsx:16`
- `app/workspace/leads-customers/_components/entity-browser-toolbar.tsx:34`
- `components/sortable-header.tsx:15`

**Table/list modules: 26 files.** Filename search: `rg --files app components hooks lib | rg '(?:table|details-list|mobile-card|browser-results)\.tsx$'`, excluding `components/ui/`. Each listed file is a variant candidate, not a confirmed duplicate.

- `app/workspace/_components/phone-closer-operations-table.tsx:20`
- `app/workspace/_components/pipeline/opportunities-table.tsx:62`
- `app/workspace/_components/top-origins-overview-table.tsx:26`
- `app/workspace/billing/_components/billing-queue-table.tsx:60`
- `app/workspace/leads-customers/_components/entity-browser-results.tsx:30`
- `app/workspace/leads-customers/_components/entity-result-mobile-card.tsx:20`
- `app/workspace/leads/_components/leads-table.tsx:53`
- `app/workspace/operations/_components/report-snapshot-table.tsx:51`
- `app/workspace/operations/booked-calls/_components/booked-calls-details-list.tsx:69`
- `app/workspace/operations/booked-calls/_components/dm-closer-contributions-table.tsx:50`
- `app/workspace/operations/lead-gen/_components/prospect-conversion-table.tsx:57`
- `app/workspace/operations/lead-gen/_components/raw-submissions-table.tsx:91`
- `app/workspace/operations/lead-gen/_components/respark-performance-table.tsx:41`
- `app/workspace/operations/lead-gen/_components/specialist-performance-table.tsx:69`
- `app/workspace/operations/lead-gen/_components/top-origins-table.tsx:19`
- `app/workspace/operations/qualifications/_components/setter-contributions-table.tsx:54`
- `app/workspace/operations/sales-calls/_components/phone-closer-table.tsx:48`
- `app/workspace/operations/sales-calls/_components/sales-calls-details-list.tsx:65`
- `app/workspace/reports/leads/_components/conversion-by-closer-table.tsx:31`
- `app/workspace/reports/pipeline/_components/pipeline-aging-table.tsx:39`
- `app/workspace/reports/reminders/_components/per-closer-reminder-conversion-table.tsx:31`
- `app/workspace/reports/revenue/_components/closer-revenue-table.tsx:36`
- `app/workspace/reports/revenue/_components/top-deals-table.tsx:43`
- `app/workspace/reports/slack-qualifications/_components/setter-contribution-table.tsx:33`
- `app/workspace/reports/team/_components/closer-performance-table.tsx:34`
- `app/workspace/team/_components/team-members-table.tsx:81`

**Filter/date modules: 12 files.** Filename search: `rg --files app components hooks lib | rg '(?:filter|filters|date-controls|calendar-header|toolbar|search-input)\.tsx$'`, excluding `components/ui/`. Each listed file is a variant candidate, not a confirmed duplicate.

- `app/workspace/_components/dashboard-date-range-filter.tsx:40`
- `app/workspace/_components/pipeline/pipeline-filters.tsx:39`
- `app/workspace/_components/time-period-filter.tsx:22`
- `app/workspace/closer/_components/calendar-header.tsx:24`
- `app/workspace/leads-customers/_components/entity-browser-toolbar.tsx:34`
- `app/workspace/leads/_components/lead-search-input.tsx:19`
- `app/workspace/reports/_components/report-attribution-filters.tsx:27`
- `app/workspace/reports/_components/report-date-controls.tsx:48`
- `app/workspace/reports/_components/report-payment-type-filter.tsx:34`
- `app/workspace/reports/_components/report-program-dimension-filter.tsx:17`
- `app/workspace/reports/_components/report-program-filter.tsx:32`
- `app/workspace/reports/activity/_components/activity-feed-filters.tsx:75`

### Custom panel evidence, complete candidate inventory

- `app/page.tsx:91`: L91 `<div className="flex items-center gap-3 rounded-full border border-border bg-card px-5 py-3 text-sm text-muted-foreground"`
- `app/workspace/_components/ops-searchable-list.tsx:174`: L174 `<div className="rounded-b-lg border-t bg-muted/30 px-3 py-3 text-sm"`
- `app/admin/_components/invite-banner.tsx:50`: L50 `<div className="rounded-lg border border-primary/25 bg-primary/5 p-5 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2 motion-safe:duration-400"`
- `app/admin/_components/support-tickets-section.tsx:37`: L37 `<section className="overflow-hidden rounded-lg border border-border bg-card shadow-sm"`
- `app/admin/_components/reset-tenant-dialog.tsx:112`: L112 `<div className="grid gap-3 rounded-lg border border-border bg-muted/20 p-4 sm:grid-cols-3"`; L133 `<div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4"`
- `app/admin/_components/admin-page-client.tsx:187`: L187 `<div key={label} className="rounded-lg border border-border bg-card p-4"`; L210 `<div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm"`
- `app/onboarding/page.tsx:195`: L195 `<div className="flex flex-col gap-6 rounded-lg border border-border bg-card p-8 text-center shadow-sm"`; L232 `<div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm"`; L262 `<div className="rounded-md border border-border bg-muted/30 px-4 py-3"`
- `app/dm-links/[portalSlug]/_components/dm-link-portal-client.tsx:1014`: L1014 `<div key={item.label} className="min-w-0 rounded-lg border bg-muted/30 p-3"`; L1026 `<div className="flex flex-col gap-3 rounded-lg border bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between"`; L1058 `<div className="space-y-4 rounded-lg border border-primary/30 bg-primary/5 p-3"`; L1081 `<div key={link.eventTypeConfigId} className="space-y-2 rounded-lg border bg-background/80 p-3"`; L1155 `<div className="flex min-h-24 items-center gap-3 rounded-lg border border-dashed bg-muted/20 p-3 text-sm text-muted-foreground"`
- `app/workspace/_components/section-error-boundary.tsx:52`: L52 `<div className="flex items-start gap-3 rounded-lg border border-destructive/50 bg-destructive/5 p-4"`
- `app/workspace/billing/_components/billing-queue-table.tsx:138`: L138 `<div className="overflow-hidden rounded-lg border bg-card"`
- `app/workspace/_components/pipeline/opportunities-table.tsx:165`: L165 `<div className="overflow-hidden rounded-lg border"`
- `app/workspace/closer/meetings/_components/no-show-action-bar.tsx:88`: L88 `<div role="region" aria-label="No-show actions" className="flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800/40 dark:bg-amber-950/20"`
- `app/workspace/closer/_components/meeting-block.tsx:169`: L169 `<div className="grid gap-2 rounded-lg border bg-muted/30 p-3"`
- `app/workspace/billing/_components/billing-proof-preview.tsx:133`: L133 `<div className="flex size-14 items-center justify-center rounded-sm border bg-muted/40"`
- `app/workspace/lead-gen/_components/lead-gen-capture-page-client.tsx:483`: L483 `<section className="flex flex-col gap-4 rounded-lg border bg-card p-4"`; L558 `<section className="flex min-w-0 items-center justify-between gap-3 rounded-lg border bg-muted/30 p-3"`; L560 `<div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground"`; L689 `<div className="flex min-h-20 min-w-0 flex-col justify-between rounded-lg border bg-card p-3"`; L705 `<div className="flex min-w-0 flex-col gap-2 rounded-lg border bg-muted/30 p-3"`
- `app/dm-links/[portalSlug]/_components/portal-leads-panel.tsx:269`: L269 `<div className="flex min-h-24 items-center justify-center gap-2 rounded-lg border border-dashed bg-muted/20 p-3 text-sm text-muted-foreground"`; L274 `<div className="flex min-h-24 items-center gap-3 rounded-lg border border-dashed bg-muted/20 p-3 text-sm text-muted-foreground"`; L279 `<div className="flex min-h-24 items-center gap-3 rounded-lg border border-dashed bg-muted/20 p-3 text-sm text-muted-foreground"`
- `app/support/page.tsx:59`: L59 `<div className="mb-5 flex size-11 items-center justify-center rounded-md border border-border bg-card text-primary"`
- `app/workspace/closer/_components/calendar-view.tsx:123`: L123 `<div className="grid grid-cols-7 gap-px rounded-lg border p-2"`; L132 `<div className="flex flex-col gap-1 rounded-lg border p-4"`
- `app/workspace/closer/meetings/_components/payment-links-panel.tsx:34`: L34 `<div key={index} className="flex items-center justify-between gap-3 rounded-lg border bg-card p-3 transition-colors hover:bg-accent/50"`
- `app/workspace/closer/_components/pipeline-strip.tsx:105`: L105 `<section aria-label="Performance summary" className="flex flex-col gap-3 rounded-xl bg-card p-3 ring-1 ring-foreground/10"`
- `app/onboarding/connect/page.tsx:190`: L190 `<div className="flex flex-col gap-6 rounded-lg border border-border bg-card p-8 text-center shadow-sm"`; L216 `<div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm"`; L297 `<div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm"`; L303 `<div className="mx-auto flex size-16 items-center justify-center rounded-full border-2 border-primary/25 bg-primary/10 text-2xl font-semibold text-primary"`; L321 `<div className="flex items-start gap-3 rounded-md border border-primary/20 bg-primary/10 p-3.5"`; L338 `<div className="flex flex-col gap-3 rounded-md border border-destructive/20 bg-destructive/5 p-3.5"`; L388 `<div className="flex items-start gap-3 rounded-md border border-border bg-muted/30 p-3.5"`
- `app/workspace/lead-gen/_components/lead-gen-capture-skeleton.tsx:20`: L20 `<div className="flex flex-col gap-4 rounded-lg border bg-card p-4"`
- `app/workspace/leads-customers/_components/entity-browser-results.tsx:81`: L81 `<div className="hidden overflow-hidden rounded-md border md:block"`
- `app/workspace/lead-gen/_components/lead-gen-respark-skeleton.tsx:14`: L14 `<div className="flex flex-col gap-4 rounded-lg border p-4"`
- `app/workspace/billing/_components/export-menu.tsx:172`: L172 `<div className="grid grid-cols-2 gap-2 rounded-md border p-2"`
- `app/workspace/_components/system-health.tsx:146`: L146 `<div className="rounded-lg border bg-background p-3"`
- `app/workspace/_components/phone-closer-operations-table.tsx:32`: L32 `<div className="overflow-x-auto rounded-md border"`
- `app/workspace/_components/top-origins-overview-table.tsx:32`: L32 `<div className="overflow-x-auto rounded-md border"`
- `app/workspace/leads-customers/_components/entity-browser-toolbar.tsx:62`: L62 `<div className="rounded-md border bg-card p-3"`
- `app/workspace/operations/lead-gen/_components/raw-submissions-table.tsx:210`: L210 `<div className="rounded-lg border"`
- `app/workspace/closer/_components/month-view.tsx:62`: L62 `<div className="rounded-lg border"`
- `app/workspace/lead-gen/_components/respark-batch.tsx:394`: L394 `<div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-4 py-2 text-sm"`; L407 `<div className="flex items-center justify-between gap-3 rounded-lg border border-dashed px-4 py-2 text-sm"`; L421 `<div className="flex items-center justify-between gap-3 rounded-lg border border-dashed px-4 py-2 text-sm"`
- `app/workspace/leads/_components/leads-table.tsx:106`: L106 `<div className="overflow-hidden rounded-lg border"`
- `app/workspace/operations/_components/report-snapshot-table.tsx:131`: L131 `<div className="overflow-x-auto rounded-lg border"`
- `app/workspace/operations/_components/pipeline-recovery-panel.tsx:142`: L142 `<div className="space-y-3 rounded-md border p-4 text-sm"`
- `app/workspace/closer/_components/closer-dashboard-skeleton.tsx:26`: L26 `<section className="flex flex-col gap-3 rounded-xl bg-card p-3 ring-1 ring-foreground/10"`
- `app/workspace/closer/meetings/_components/deal-won-card.tsx:211`: L211 `<div className="flex items-center gap-3 rounded-lg border bg-background p-3"`; L243 `<div className="flex size-16 shrink-0 items-center justify-center rounded-md border bg-muted"`
- `app/workspace/leads-customers/_components/leads-customers-skeleton.tsx:17`: L17 `<div className="rounded-md border p-3"`; L23 `<div className="rounded-md border"`
- `app/workspace/closer/reminders/[followUpId]/_components/reminder-no-response-dialog.tsx:325`: L325 `<div className="flex flex-col gap-3 rounded-lg border p-3"`
- `app/workspace/leads-customers/[leadId]/_components/opportunity-sheet-summary.tsx:132`: L132 `<div className="flex flex-col gap-1 rounded-lg border border-border/60 bg-muted/30 p-3 text-sm"`; L141 `<div className="flex flex-col gap-1 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"`
- `app/workspace/operations/lead-gen/_components/respark-performance-table.tsx:76`: L76 `<div className="overflow-x-auto rounded-lg border"`
- `app/workspace/leads-customers/[leadId]/_components/entity-detail-skeleton.tsx:10`: L10 `<div className="rounded-xl bg-card p-4 ring-1 ring-foreground/10 sm:p-5"`; L19 `<div key={index} className="rounded-xl bg-card ring-1 ring-foreground/10"`; L30 `<div key={index} className="rounded-xl bg-card ring-1 ring-foreground/10"`
- `app/workspace/lead-gen/_components/lead-gen-activity-page-client.tsx:188`: L188 `<div className="overflow-x-auto rounded-lg border"`; L256 `<div className="flex min-h-20 min-w-0 flex-col justify-between rounded-lg border bg-card p-3"`
- `app/workspace/operations/booking-reviews/[reviewId]/_components/booking-review-page-client.tsx:477`: L477 `<div className="flex flex-col gap-3 rounded-lg border p-4"`; L530 `<div className="flex flex-col gap-3 rounded-lg border p-4"`
- `app/workspace/leads-customers/_components/entity-browser-results-loading.tsx:5`: L5 `<div role="status" aria-label="Loading entity results" className="rounded-md border"`
- `app/workspace/leads/[leadId]/merge/_components/merge-page-client.tsx:237`: L237 `<div className="rounded-md border"`
- `app/workspace/opportunities/[opportunityId]/_components/add-opportunity-payment-dialog.tsx:297`: L297 `<div className="rounded-md border bg-muted/40 px-3 py-2 text-sm"`
- `app/workspace/leads/_components/skeletons/leads-skeleton.tsx:37`: L37 `<div className="overflow-hidden rounded-lg border"`
- `app/workspace/operations/qualifications/_components/setter-contributions-table.tsx:95`: L95 `<div className="rounded-lg border"`
- `app/workspace/customers/loading.tsx:18`: L18 `<div className="space-y-2 rounded-lg border p-4"`
- `app/workspace/operations/booked-calls/attribution/_components/portal-event-type-readiness-card.tsx:256`: L256 `<div className="overflow-hidden rounded-lg border"`
- `app/workspace/reports/team/_components/meeting-outcome-distribution-chart.tsx:133`: L133 `<div key={entry.key} className="flex items-center justify-between gap-3 rounded-lg border bg-muted/20 px-3 py-2"`
- `app/workspace/lead-gen/_components/lead-gen-respark-page-client.tsx:125`: L125 `<section className="flex flex-col gap-4 rounded-lg border bg-card p-4"`; L215 `<section className="flex flex-col items-center gap-4 rounded-lg border bg-card px-5 py-8 text-center"`; L247 `<div className="flex flex-col gap-1 rounded-lg border p-3"`
- `app/workspace/opportunities/_components/skeletons/opportunities-page-skeleton.tsx:34`: L34 `<div className="overflow-hidden rounded-lg border"`
- `app/workspace/operations/booked-calls/_components/dm-closer-contributions-table.tsx:91`: L91 `<div className="rounded-lg border"`
- `app/workspace/operations/lead-gen/_components/prospect-conversion-table.tsx:123`: L123 `<div className="overflow-x-auto rounded-lg border"`
- `app/workspace/leads-customers/[leadId]/_components/entity-attribution-grid.tsx:52`: L52 `<div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-muted/30 p-3 text-sm"`
- `app/workspace/reports/activity/_components/activity-event-row.tsx:143`: L143 `<div className="flex items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/50"`
- `app/workspace/operations/sales-calls/_components/phone-closer-table.tsx:214`: L214 `<div className="overflow-x-auto rounded-lg border"`
- `app/workspace/opportunities/[opportunityId]/_components/opportunity-activity-timeline.tsx:157`: L157 `<section className="rounded-md border"`
- `app/workspace/settings/_components/payment-link-editor.tsx:54`: L54 `<div key={index} className="flex flex-col gap-3 rounded-lg border p-3"`
- `app/workspace/reports/reminders/_components/reminder-funnel-chart.tsx:38`: L38 `<div className="flex h-full flex-col gap-4 rounded-2xl border bg-muted/30 p-4"`; L134 `<div key={entry.outcome} className="flex flex-col gap-2 rounded-xl border bg-background/80 p-3"`
- `app/workspace/reports/revenue/_components/booked-vs-sold-matrix.tsx:65`: L65 `<div className="overflow-x-auto rounded-md border"`
- `app/workspace/reports/reminders/_components/reminder-driven-revenue-card.tsx:42`: L42 `<div className="rounded-2xl border bg-background/80 p-4"`; L64 `<div className="rounded-2xl border bg-background/80 p-4"`
- `app/workspace/reports/pipeline/_components/pipeline-report-page-client.tsx:316`: L316 `<div className="rounded-md border bg-muted/20 p-3"`
- `app/workspace/operations/sales-calls/_components/per-program-stat-card.tsx:382`: L382 `<div className="rounded-lg border"`
- `app/workspace/reports/team/_components/team-report-page-client.tsx:379`: L379 `<div className="overflow-x-auto rounded-md border"`
- `app/workspace/reports/pipeline/_components/loss-attribution-chart.tsx:171`: L171 `<div key={actor.userId} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"`
- `app/workspace/team/_components/team-members-table.tsx:144`: L144 `<div className="overflow-hidden rounded-lg border"`
- `app/workspace/team/redistribute/[unavailabilityId]/_components/redistribute-wizard-page-client.tsx:864`: L864 `<div className="rounded-lg border bg-muted/30 p-4"`
- `app/workspace/reports/slack-qualifications/_components/setter-contribution-table.tsx:53`: L53 `<div className="overflow-x-auto rounded-md border"`
- `app/workspace/settings/_components/integrations/slack-integration-card.tsx:417`: L417 `<div className="min-w-0 rounded-lg border p-3"`; L425 `<div className="min-w-0 rounded-lg border p-3"`; L433 `<div className="min-w-0 rounded-lg border p-3"`; L441 `<div className="min-w-0 rounded-lg border p-3"`
- `app/workspace/opportunities/[opportunityId]/_components/opportunity-payments-list.tsx:186`: L186 `<section className="rounded-md border"`
- `app/workspace/operations/booked-calls/attribution/_components/team-event-types-card.tsx:173`: L173 `<div className="flex flex-col gap-1 rounded-lg border bg-muted/30 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3"`; L189 `<div className="overflow-hidden rounded-lg border"`
- `app/workspace/operations/lead-gen/_components/specialist-performance-table.tsx:159`: L159 `<div className="rounded-lg border"`

## 5. shadcn misuse

- **132 appearance-override candidates in 76 files**. Search JSX openings for Button, Badge, Card/CardTitle/CardDescription, Alert/AlertTitle/AlertDescription, Input and SelectTrigger with className, then retain bg/font/tracking/text-size/text-colour/rounded utilities. This excludes text-right alignment. Many are mild token-based overrides; heavy examples are the Slack warning banner, duplicate banner, won card and billing compact buttons. Shared variants should replace repeated appearances.
- **19 raw button openings**, **3 actual raw inputs**, **0 raw tables** outside the baseline. Search `raw` yields 23 matches, but one is a comment mentioning a native date input at `app/workspace/closer/reminders/[followUpId]/_components/reminder-no-response-dialog.tsx:240`. Actual raw inputs are specialized hidden/file inputs, not three ordinary text-field violations. The error-boundary button at `app/global-error.tsx:42` may intentionally avoid dependencies; retain that rationale. Calendar event buttons, table sorting, copy buttons and proof lightboxes need a shared Button treatment or an explicit approved interaction recipe.
- **21 form files with no FieldGroup**, found from `rg -l '<form\b'` minus `rg -l '<FieldGroup\b'` over the same corpus. All 21 use FormField/FormItem rather than the current Field composition. This is convention migration debt, not proof that validation/accessibility is broken. **36 forms in 35 files** overall, search `form`. Some migrated forms use FieldGroup plus local FormField wrappers; inspect those during migration too.
- **29 manually sized icon/spinner matches in paired Button blocks**, across 18 files. Search paired Button blocks, then icon-name openings matching size-/h-/w- classes. Icons with data-icon plus a manual size still count. This is a source heuristic, not a JSX AST parser; concrete inventory below.
- **14 files** with SelectItem and no SelectGroup; **3** with DropdownMenuItem and no DropdownMenuGroup. Verified direct nesting examples: `app/workspace/closer/_components/program-select.tsx:84`, `app/workspace/settings/_components/payment-link-editor.tsx:67`, and `app/workspace/settings/_components/program-row.tsx:146`.
- **3 manual template-literal className expressions** violate cn convention, all in redistribution wizard, search `conditional`. **44 adjacent equal h/w pairs** should use size, search `equal-dimensions`; non-adjacent class pairs are not counted.
- **3 confirmed custom content pills** should use Badge: two emerald cash/PIF spans at `app/workspace/leads-customers/[leadId]/_components/entity-opportunity-row.tsx:61` and `:66`; one count span at `entity-detail-ui.tsx:53` in the same folder. Dots, progress tracks and icon circles are excluded from that count.
- **2 hand-built warning callouts** repeat amber icon/title/description framing: `app/workspace/closer/meetings/_components/meeting-info-panel.tsx:139` and `meeting-overview-card.tsx:186` in the same folder. The no-show action panel at `no-show-action-bar.tsx:91` is another domain composite to build on an Alert/action recipe.
- **No file-level missing-title/fallback candidates**: searches for DialogContent without DialogTitle, SheetContent without SheetTitle, and AvatarImage without AvatarFallback return zero. This is a file-level check, not a proof that every conditional instance composes correctly. No raw hr or arbitrary z-index overrides were found in the app corpus. Existing Sonner imports follow the Radix toast convention.

### Appearance override evidence

- `app/workspace/_components/pipeline/pipeline-filters.tsx:88`: `<Badge variant="secondary" className="px-1.5 py-0 text-[10px]"`
- `app/dm-links/[portalSlug]/_components/dm-link-portal-client.tsx:872`: `<Card className="rounded-lg"`
- `app/dm-links/[portalSlug]/_components/dm-link-portal-client.tsx:1235`: `<Card className="rounded-lg"`
- `app/workspace/billing/_components/slack-contributor-timeline.tsx:122`: `<Badge className="h-4 px-1 text-[0.6rem] font-normal uppercase tracking-wide"`
- `app/dm-links/[portalSlug]/_components/portal-leads-panel.tsx:230`: `<Card className="rounded-lg"`
- `app/dm-links/[portalSlug]/_components/portal-leads-panel.tsx:368`: `<Badge key={`${handle.type}-${handle.handle}-${index}`} variant="secondary" className="max-w-full text-xs"`
- `app/workspace/_components/slack-qualified-total-card.tsx:26`: `<Card size="sm" className="h-full border-primary/20 bg-primary/5 ring-1 ring-primary/10"`
- `app/workspace/_components/entity-attribution-card.tsx:105`: `<CardTitle className="flex items-center gap-2 text-base"`
- `app/support/_components/support-request-form.tsx:110`: `<Alert className="mb-5 border-primary/30 bg-primary/5"`
- `app/workspace/billing/_components/billing-event-history.tsx:207`: `<Badge className="h-4 px-1 text-[0.6rem] font-normal uppercase tracking-wide"`
- `app/workspace/_components/stats-card.tsx:54`: `<CardTitle className="text-sm font-medium text-muted-foreground"`
- `app/workspace/billing/_components/billing-review-page-client.tsx:51`: `<CardTitle className="text-base"`
- `app/workspace/billing/_components/billing-payment-summary.tsx:244`: `<Button asChild className="group h-7 -ml-2 gap-1.5 px-2 text-xs"`
- `app/workspace/billing/_components/billing-payment-summary.tsx:261`: `<Button asChild className="group h-7 gap-1.5 px-2 text-xs"`
- `app/workspace/closer/meetings/_components/follow-up-dialog.tsx:167`: `<Card className="cursor-pointer transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"`
- `app/workspace/closer/meetings/_components/follow-up-dialog.tsx:181`: `<CardTitle className="text-base"`
- `app/workspace/closer/meetings/_components/follow-up-dialog.tsx:191`: `<Card className="cursor-pointer transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"`
- `app/workspace/closer/meetings/_components/follow-up-dialog.tsx:205`: `<CardTitle className="text-base"`
- `app/workspace/closer/meetings/_components/booking-answers-card.tsx:45`: `<CardTitle className="text-base"`
- `app/workspace/closer/_components/featured-meeting-card.tsx:94`: `<CardTitle className="truncate text-base"`
- `app/workspace/closer/_components/featured-meeting-card.tsx:111`: `<Badge variant={isStartingSoon || hasStarted ? "default" : "secondary"} aria-live="polite" className={cn( "font-mono tabular-nums", // Intentional raw color — urgency signal, not theme-dependent isStartingSoon && "bg-amber-500/15 text-amber-700 dark:text-amber-400", hasStarted && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400", )}`
- `app/workspace/closer/meetings/_components/deal-won-card.tsx:89`: `<Card className="border-emerald-200 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/30"`
- `app/workspace/closer/meetings/_components/deal-won-card.tsx:93`: `<CardTitle className="text-base"`
- `app/workspace/closer/meetings/_components/deal-won-card.tsx:177`: `<Badge variant="secondary" className={cn("text-xs", statusCfg.badgeClass)}`
- `app/workspace/closer/meetings/_components/meeting-comments.tsx:111`: `<CardTitle className="text-sm"`
- `app/onboarding/connect/page.tsx:362`: `<Button asChild size="sm" variant="outline" className="text-xs"`
- `app/onboarding/connect/page.tsx:378`: `<Button asChild size="sm" variant="outline" className="text-xs"`
- `app/onboarding/connect/page.tsx:447`: `<Button type="button" variant="outline" size="sm" className="w-full text-muted-foreground"`
- `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx:179`: `<AlertDescription className="text-sm"`
- `app/workspace/closer/meetings/_components/meeting-overview-card.tsx:107`: `<Badge variant="secondary" className={cn("mt-1 text-[10px]", statusCfg.badgeClass)}`
- `app/workspace/closer/meetings/_components/fathom-link-field.tsx:147`: `<CardTitle className="flex cursor-default items-center gap-2 text-sm"`
- `app/workspace/closer/meetings/_components/reschedule-link-display.tsx:34`: `<Card className="border-blue-200 bg-blue-50 dark:border-blue-800/40 dark:bg-blue-950/20"`
- `app/workspace/closer/meetings/_components/reschedule-link-display.tsx:36`: `<CardTitle className="flex items-center gap-2 text-base"`
- `app/workspace/closer/meetings/_components/reschedule-link-display.tsx:83`: `<Alert className="border-blue-200 bg-blue-50 dark:border-blue-800/40 dark:bg-blue-950/20"`
- `app/workspace/closer/meetings/_components/reschedule-link-display.tsx:85`: `<AlertDescription className="text-blue-900 dark:text-blue-100"`
- `app/workspace/billing/_components/billing-proof-preview.tsx:151`: `<Button asChild className="h-7 w-full text-xs"`
- `app/workspace/billing/_components/billing-proof-preview.tsx:177`: `<Button asChild className="h-7 text-xs"`
- `app/workspace/closer/meetings/_components/lead-info-panel.tsx:44`: `<CardTitle className="text-base"`
- `app/workspace/closer/meetings/_components/lead-info-panel.tsx:96`: `<CardTitle className="text-base"`
- `app/workspace/leads-customers/[leadId]/_components/entity-header-section.tsx:39`: `<Button asChild variant="ghost" size="sm" className="-ml-2 w-fit text-muted-foreground"`
- `app/workspace/closer/meetings/_components/potential-duplicate-banner.tsx:58`: `<Alert role="status" variant="default" className="border-amber-500 bg-amber-50 dark:bg-amber-950/20"`
- `app/workspace/closer/meetings/_components/potential-duplicate-banner.tsx:67`: `<AlertTitle className="text-amber-800 dark:text-amber-200"`
- `app/workspace/closer/meetings/_components/potential-duplicate-banner.tsx:70`: `<AlertDescription className="break-words text-amber-700 dark:text-amber-300"`
- `app/workspace/closer/meetings/_components/potential-duplicate-banner.tsx:96`: `<Button variant="outline" size="sm" onClick={handleDismiss} disabled={isDismissing} className="border-amber-400 text-amber-800 hover:bg-amber-100 dark:border-amber-600 dark:text-amber-200 dark:hover:bg-amber-900/30"`
- `app/workspace/closer/meetings/_components/potential-duplicate-banner.tsx:106`: `<Button variant="outline" size="sm" onClick={handleReviewMerge} className="border-amber-400 text-amber-800 hover:bg-amber-100 dark:border-amber-600 dark:text-amber-200 dark:hover:bg-amber-900/30"`
- `app/workspace/closer/meetings/_components/meeting-history-card.tsx:57`: `<CardTitle className="flex items-center justify-between gap-2 text-sm"`
- `app/workspace/closer/meetings/_components/meeting-history-card.tsx:117`: `<Badge variant="secondary" className={cn("shrink-0 text-[10px]", config.badgeClass)}`
- `app/workspace/closer/reminders/[followUpId]/_components/reminder-metadata-card.tsx:130`: `<CardTitle className="text-base"`
- `app/workspace/closer/reminders/[followUpId]/_components/reminder-history-panel.tsx:50`: `<CardTitle className="text-base"`
- `app/workspace/closer/meetings/_components/attribution-card.tsx:67`: `<CardTitle className="flex items-center gap-2 text-base"`
- `app/workspace/closer/meetings/_components/lead-notes-card.tsx:35`: `<CardTitle className="flex items-center gap-2 text-base"`
- `app/workspace/closer/meetings/_components/comment-entry.tsx:103`: `<Badge variant="outline" className="px-1.5 py-0 text-[10px]"`
- `app/workspace/closer/meetings/_components/meeting-info-panel.tsx:69`: `<CardTitle className="text-base"`
- `app/workspace/closer/meetings/_components/payment-links-panel.tsx:30`: `<CardTitle className="text-base"`
- `app/workspace/leads-customers/[leadId]/_components/entity-lifecycle-section.tsx:65`: `<Badge variant="outline" className="border-amber-500/50 text-amber-700 dark:text-amber-400"`
- `app/workspace/operations/lead-gen/_components/respark-performance-table.tsx:50`: `<CardDescription className="text-xs"`
- `app/workspace/leads/[leadId]/merge/_components/merge-preview.tsx:84`: `<CardTitle className="text-base"`
- `app/workspace/leads/[leadId]/merge/_components/merge-preview.tsx:91`: `<Badge variant={isSource ? "destructive" : "default"} className={ isSource ? "" : "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300" }`
- `app/workspace/leads/[leadId]/merge/_components/merge-preview.tsx:122`: `<Badge variant="outline" className="text-[10px] px-1.5 py-0"`
- `app/workspace/leads/[leadId]/merge/_components/merge-preview.tsx:158`: `<CardTitle className="text-base"`
- `app/workspace/leads/[leadId]/merge/_components/merge-preview.tsx:251`: `<CardTitle className="text-base"`
- `app/workspace/operations/booked-calls/attribution/_components/attribution-registry.tsx:114`: `<Button type="button" variant="ghost" size="sm" className="group/inline-edit -ml-2 h-8 gap-1.5 px-2 font-normal tabular-nums"`
- `app/workspace/operations/booked-calls/attribution/_components/attribution-registry.tsx:213`: `<CardTitle className="text-base"`
- `app/workspace/operations/booked-calls/attribution/_components/attribution-registry.tsx:311`: `<CardTitle className="text-base"`
- `app/workspace/leads-customers/[leadId]/_components/entity-portal-notes-section.tsx:48`: `<Badge variant="outline" className="text-[10px]"`
- `app/workspace/operations/booked-calls/attribution/_components/team-event-types-card.tsx:285`: `<SelectTrigger aria-label={label} className={cn( "w-full max-w-72 min-w-0", !route && "text-muted-foreground", )}`
- `app/workspace/operations/lead-gen/_components/prospect-conversion-table.tsx:103`: `<CardDescription className="text-xs"`
- `app/workspace/operations/booked-calls/attribution/_components/attribution-unmapped-panel.tsx:35`: `<CardTitle className="text-base"`
- `app/workspace/operations/lead-gen/_components/specialist-performance-table.tsx:142`: `<CardDescription className="text-xs"`
- `app/workspace/operations/booked-calls/attribution/_components/campaign-preset-dialog.tsx:166`: `<Input {...field} disabled={isSubmitting} className="font-mono"`
- `app/workspace/operations/booked-calls/_components/dm-closer-contributions-table.tsx:74`: `<CardDescription className="text-xs"`
- `app/workspace/operations/_components/report-snapshot-table.tsx:109`: `<CardDescription className="text-xs"`
- `app/workspace/operations/sales-calls/_components/phone-closer-table.tsx:196`: `<CardDescription className="text-xs"`
- `app/workspace/operations/booking-reviews/[reviewId]/_components/booking-review-page-client.tsx:303`: `<CardTitle className="text-lg"`
- `app/workspace/operations/booking-reviews/[reviewId]/_components/booking-review-page-client.tsx:313`: `<Badge variant="outline" className={cn( check.same ? "border-emerald-300 text-emerald-700 dark:border-emerald-900 dark:text-emerald-400" : "border-amber-300 text-amber-700 dark:border-amber-900 dark:text-amber-400", )}`
- `app/workspace/leads/[leadId]/merge/_components/merge-page-client.tsx:177`: `<CardTitle className="text-base"`
- `app/workspace/leads/[leadId]/merge/_components/merge-page-client.tsx:213`: `<CardTitle className="text-base"`
- `app/workspace/leads/[leadId]/merge/_components/merge-page-client.tsx:257`: `<Badge variant="outline" className="shrink-0 text-xs"`
- `app/workspace/operations/qualifications/_components/setter-contributions-table.tsx:78`: `<CardDescription className="text-xs"`
- `app/workspace/operations/lead-gen/_components/lead-gen-summary-cards.tsx:88`: `<CardTitle className="min-w-0 truncate text-xs font-medium text-muted-foreground"`
- `app/workspace/operations/lead-gen/_components/top-origins-table.tsx:35`: `<CardDescription className="text-xs"`
- `app/workspace/pipeline/meetings/_components/admin-follow-up-dialog.tsx:148`: `<Card className="cursor-pointer transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"`
- `app/workspace/pipeline/meetings/_components/admin-follow-up-dialog.tsx:162`: `<CardTitle className="text-base"`
- `app/workspace/pipeline/meetings/_components/admin-follow-up-dialog.tsx:172`: `<Card className="cursor-pointer transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"`
- `app/workspace/pipeline/meetings/_components/admin-follow-up-dialog.tsx:186`: `<CardTitle className="text-base"`
- `app/workspace/operations/sales-calls/_components/per-program-stat-card.tsx:244`: `<CardDescription className="text-xs"`
- `app/workspace/operations/booked-calls/attribution/_components/booking-link-matrix.tsx:41`: `<CardTitle className="text-base"`
- `app/workspace/operations/sales-calls/_components/sales-calls-stat-cards.tsx:102`: `<CardTitle className="min-w-0 truncate text-xs font-medium text-muted-foreground"`
- `app/workspace/operations/sales-calls/_components/sales-calls-stat-cards.tsx:124`: `<CardTitle className="min-w-0 truncate text-xs font-medium text-muted-foreground"`
- `app/workspace/operations/lead-gen/_components/raw-submissions-table.tsx:147`: `<CardDescription className="text-xs"`
- `app/workspace/reports/pipeline/_components/unresolved-reminders-card.tsx:32`: `<CardTitle className="flex items-center gap-2 text-muted-foreground"`
- `app/workspace/reports/leads/_components/avg-time-to-conversion-card.tsx:34`: `<CardTitle className="flex items-center gap-2 text-muted-foreground"`
- `app/workspace/opportunities/new/_components/create-opportunity-page-client.tsx:257`: `<CardTitle className="text-base"`
- `app/workspace/opportunities/new/_components/create-opportunity-page-client.tsx:479`: `<CardTitle className="text-base"`
- `app/workspace/reports/leads/_components/form-response-rate-card.tsx:25`: `<CardTitle className="flex items-center gap-2 text-muted-foreground"`
- `app/workspace/reports/leads/_components/conversion-kpi-cards.tsx:26`: `<CardTitle className="text-sm font-medium"`
- `app/workspace/reports/leads/_components/conversion-kpi-cards.tsx:39`: `<CardTitle className="text-sm font-medium"`
- `app/workspace/reports/leads/_components/conversion-kpi-cards.tsx:54`: `<CardTitle className="text-sm font-medium"`
- `app/workspace/reports/slack-qualifications/_components/setter-qualification-summary-cards.tsx:52`: `<CardTitle className="text-sm font-medium text-muted-foreground"`
- `app/workspace/reports/slack-qualifications/_components/setter-qualification-summary-cards.tsx:71`: `<CardTitle className="text-sm font-medium text-muted-foreground"`
- `app/workspace/reports/slack-qualifications/_components/setter-qualification-summary-cards.tsx:94`: `<CardTitle className="text-sm font-medium text-muted-foreground"`
- `app/workspace/reports/slack-qualifications/_components/setter-qualification-summary-cards.tsx:114`: `<CardTitle className="text-sm font-medium text-muted-foreground"`
- `app/workspace/reports/slack-qualifications/_components/setter-qualification-summary-cards.tsx:133`: `<CardTitle className="text-sm font-medium text-muted-foreground"`
- `app/workspace/reports/slack-qualifications/_components/setter-qualification-summary-cards.tsx:156`: `<CardTitle className="text-sm font-medium text-muted-foreground"`
- `app/workspace/reports/reminders/_components/reminder-driven-revenue-card.tsx:30`: `<Card className="bg-linear-to-br from-card via-card to-muted/40"`
- `app/workspace/settings/_components/integrations/api-keys-card.tsx:191`: `<Input id="api-key-value" readOnly value={newKey ?? ""} className="font-mono text-xs"`
- `app/workspace/reports/activity/_components/activity-summary-cards.tsx:162`: `<CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground"`
- `app/workspace/reports/activity/_components/activity-summary-cards.tsx:252`: `<CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground"`
- `app/workspace/reports/activity/_components/activity-summary-cards.tsx:276`: `<CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground"`
- `app/workspace/reports/leads/_components/avg-meetings-per-sale-card.tsx:25`: `<CardTitle className="flex items-center gap-2 text-muted-foreground"`
- `components/command-palette-trigger.tsx:14`: `<Button variant="outline" size="sm" className="hidden gap-2 text-muted-foreground sm:flex"`
- `components/calendly-connection-guard.tsx:34`: `<Alert variant="destructive" className="rounded-none border-x-0 border-t-0 animate-in fade-in slide-in-from-top-2 duration-300 motion-reduce:animate-none"`
- `components/theme-toggle.tsx:41`: `<Button variant="ghost" size="icon" className={cn( "group relative size-9 overflow-hidden transition-colors duration-200", "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground", )}`
- `app/workspace/team/redistribute/[unavailabilityId]/_components/redistribute-wizard-page-client.tsx:647`: `<Badge variant="secondary" className="text-xs"`
- `app/workspace/team/redistribute/[unavailabilityId]/_components/redistribute-wizard-page-client.tsx:764`: `<Badge variant="secondary" className={`text-xs ${meetingBadgeColor}`
- `app/workspace/team/redistribute/[unavailabilityId]/_components/redistribute-wizard-page-client.tsx:878`: `<Badge variant="outline" className="text-xs"`
- `app/workspace/settings/_components/integrations/slack-integration-card.tsx:230`: `<Button variant="ghost" className="text-destructive hover:text-destructive"`
- `app/workspace/team/_components/team-members-table.tsx:129`: `<Button variant="ghost" size="sm" onClick={onToggleShowInactive} className="text-xs text-muted-foreground"`
- `app/workspace/team/_components/team-members-table.tsx:212`: `<Badge variant="outline" className="text-xs text-muted-foreground"`
- `components/slack-connection-guard.tsx:121`: `<Alert className="rounded-none border-x-0 border-t-0 border-amber-500/30 bg-amber-50 text-amber-950 animate-in fade-in slide-in-from-top-2 duration-300 motion-reduce:animate-none dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-100"`
- `components/slack-connection-guard.tsx:124`: `<AlertDescription className="text-amber-900/90 dark:text-amber-100/85"`
- `app/workspace/team/_components/recent-reassignments.tsx:42`: `<CardTitle className="flex items-center gap-2 text-base"`
- `app/workspace/team/_components/recent-reassignments.tsx:80`: `<Badge variant="outline" className="text-xs"`
- `app/workspace/reports/team/_components/team-kpi-summary-cards.tsx:51`: `<CardTitle className="text-sm font-medium text-muted-foreground"`
- `app/workspace/reports/team/_components/team-kpi-summary-cards.tsx:68`: `<CardTitle className="text-sm font-medium text-muted-foreground"`
- `app/workspace/reports/team/_components/team-kpi-summary-cards.tsx:89`: `<CardTitle className="text-sm font-medium text-muted-foreground"`
- `app/workspace/reports/team/_components/team-kpi-summary-cards.tsx:108`: `<CardTitle className="text-sm font-medium text-muted-foreground"`
- `app/workspace/reports/team/_components/team-kpi-summary-cards.tsx:129`: `<CardTitle className="text-sm font-medium text-muted-foreground"`
- `app/workspace/reports/team/_components/team-kpi-summary-cards.tsx:148`: `<CardTitle className="text-sm font-medium text-muted-foreground"`
- `app/workspace/reports/team/_components/team-kpi-summary-cards.tsx:168`: `<CardTitle className="text-sm font-medium text-muted-foreground"`
- `components/notification-center.tsx:47`: `<Badge variant="destructive" className="absolute -right-1 -top-1 flex size-4 items-center justify-center p-0 text-[10px]"`
- `components/notification-center.tsx:60`: `<Button variant="ghost" size="sm" className="text-xs"`

### Raw element evidence

- `app/dm-links/[portalSlug]/_components/portal-leads-panel.tsx:347`: L347 `<button`
- `app/global-error.tsx:42`: L42 `<button`
- `app/support/_components/support-request-form.tsx:216`: L216 `<input`
- `app/dm-links/[portalSlug]/_components/dm-link-portal-client.tsx:210`: L210 `<input`; L315 `<button`
- `app/workspace/billing/_components/billing-proof-preview.tsx:110`: L110 `<button`
- `app/workspace/closer/meetings/_components/deal-won-card.tsx:214`: L214 `<button`
- `app/workspace/closer/meetings/_components/meeting-overview-card.tsx:268`: L268 `<button`
- `app/workspace/closer/_components/pipeline-strip.tsx:378`: L378 `<button`
- `app/workspace/leads-customers/[leadId]/_components/entity-comments-list.tsx:27`: L27 `<button`
- `app/workspace/closer/meetings/_components/booking-answers-card.tsx:92`: L92 `<button`
- `app/workspace/closer/meetings/_components/comment-input.tsx:126`: L126 `<button`
- `app/workspace/closer/_components/meeting-block.tsx:70`: L70 `<button`; L109 `<button`
- `app/workspace/leads/_components/lead-search-input.tsx:58`: L58 `<button`
- `app/workspace/closer/reminders/[followUpId]/_components/reminder-no-response-dialog.tsx:240`: L240 `<input`
- `app/workspace/lead-gen/_components/respark-batch.tsx:286`: L286 `<button`
- `app/workspace/leads-customers/_components/entity-ui-tooltips.tsx:69`: L69 `<button`
- `app/workspace/leads-customers/[leadId]/_components/entity-programs-section.tsx:87`: L87 `<button`
- `app/workspace/leads-customers/[leadId]/_components/entity-opportunity-row.tsx:125`: L125 `<button`
- `app/workspace/leads/[leadId]/merge/_components/merge-page-client.tsx:239`: L239 `<button`
- `app/workspace/profile/_components/profile-page-client.tsx:234`: L234 `<input`
- `components/sortable-header.tsx:28`: L28 `<button`

### Legacy form evidence

- `app/workspace/closer/meetings/_components/follow-up-dialog.tsx:476`
- `app/workspace/closer/meetings/_components/mark-lost-dialog.tsx:137`
- `app/workspace/closer/meetings/_components/mark-no-show-dialog.tsx:142`
- `app/workspace/closer/reminders/[followUpId]/_components/reminder-mark-lost-dialog.tsx:146`
- `app/workspace/closer/reminders/[followUpId]/_components/reminder-no-response-dialog.tsx:284`
- `app/workspace/lead-gen/_components/lead-gen-capture-page-client.tsx:390`
- `app/workspace/leads-customers/[leadId]/_components/enrollment-status-dialog.tsx:110`
- `app/workspace/leads-customers/[leadId]/_components/lifecycle-change-dialog.tsx:143`
- `app/workspace/operations/booked-calls/_components/booking-goals-dialog.tsx:166`
- `app/workspace/operations/booked-calls/attribution/_components/set-portal-password-dialog.tsx:133`
- `app/workspace/operations/lead-gen/_components/void-submission-dialog.tsx:123`
- `app/workspace/opportunities/[opportunityId]/_components/delete-opportunity-dialog.tsx:123`
- `app/workspace/opportunities/[opportunityId]/_components/mark-side-deal-lost-dialog.tsx:119`
- `app/workspace/opportunities/[opportunityId]/_components/void-payment-dialog.tsx:118`
- `app/workspace/pipeline/meetings/_components/admin-follow-up-dialog.tsx:455`
- `app/workspace/pipeline/meetings/_components/admin-mark-lost-dialog.tsx:132`
- `app/workspace/reports/slack-qualifications/_components/team-goal-dialog.tsx:128`
- `app/workspace/settings/_components/event-type-config-dialog.tsx:290`
- `app/workspace/settings/_components/program-form-dialog.tsx:211`
- `app/workspace/team/_components/event-type-assignment-dialog.tsx:125`
- `app/workspace/team/_components/role-edit-dialog.tsx:134`

### Button icon evidence

- `app/onboarding/connect/page.tsx:369`
- `app/onboarding/connect/page.tsx:454`
- `app/workspace/billing/_components/billing-payment-summary.tsx:251`
- `app/workspace/billing/_components/billing-payment-summary.tsx:253`
- `app/workspace/billing/_components/billing-payment-summary.tsx:268`
- `app/workspace/billing/_components/billing-payment-summary.tsx:274`
- `app/workspace/billing/_components/billing-proof-preview.tsx:154`
- `app/workspace/billing/_components/billing-proof-preview.tsx:180`
- `app/workspace/closer/meetings/_components/comment-entry.tsx:124`
- `app/workspace/closer/meetings/_components/comment-input.tsx:120`
- `app/workspace/closer/meetings/_components/fathom-link-field.tsx:190`
- `app/workspace/closer/meetings/_components/meeting-comments.tsx:126`
- `app/workspace/closer/meetings/_components/meeting-info-panel.tsx:93`
- `app/workspace/closer/meetings/_components/meeting-overview-card.tsx:297`
- `app/workspace/closer/meetings/_components/reschedule-chain-banner.tsx:52`
- `app/workspace/closer/meetings/_components/reschedule-link-display.tsx:46`
- `app/workspace/closer/meetings/_components/reschedule-link-display.tsx:64`
- `app/workspace/closer/meetings/_components/reschedule-link-display.tsx:66`
- `app/workspace/operations/booked-calls/attribution/_components/attribution-registry.tsx:128`
- `app/workspace/reports/_components/report-date-controls.tsx:175`
- `app/workspace/reports/revenue/_components/revenue-by-origin-chart.tsx:122`
- `app/workspace/settings/_components/event-type-config-dialog.tsx:540`
- `app/workspace/settings/_components/payment-link-editor.tsx:103`
- `app/workspace/settings/_components/payment-link-editor.tsx:118`
- `app/workspace/team/redistribute/[unavailabilityId]/_components/redistribute-wizard-page-client.tsx:803`
- `app/workspace/team/redistribute/[unavailabilityId]/_components/redistribute-wizard-page-client.tsx:925`
- `app/workspace/team/redistribute/[unavailabilityId]/_components/redistribute-wizard-page-client.tsx:937`
- `components/theme-toggle.tsx:52`
- `components/theme-toggle.tsx:61`

### Group composition evidence

**SelectItem**

- `app/admin/_components/admin-page-client.tsx:237`
- `app/dm-links/[portalSlug]/_components/portal-leads-panel.tsx:520`
- `app/workspace/closer/_components/program-select.tsx:86`
- `app/workspace/closer/meetings/_components/mark-no-show-dialog.tsx:166`
- `app/workspace/leads-customers/[leadId]/_components/enrollment-status-control.tsx:79`
- `app/workspace/leads-customers/[leadId]/_components/lifecycle-change-dialog.tsx:158`
- `app/workspace/operations/sales-calls/_components/sales-calls-page-client.tsx:205`
- `app/workspace/reports/_components/report-date-controls.tsx:207`
- `app/workspace/reports/leads/_components/form-response-analytics-section.tsx:73`
- `app/workspace/settings/_components/payment-link-editor.tsx:69`
- `app/workspace/settings/_components/program-form-dialog.tsx:274`
- `app/workspace/team/_components/calendly-link-dialog.tsx:111`
- `app/workspace/team/_components/mark-unavailable-dialog.tsx:337`
- `app/workspace/team/redistribute/[unavailabilityId]/_components/redistribute-wizard-page-client.tsx:901`

**DropdownMenuItem**

- `app/workspace/closer/meetings/_components/comment-entry.tsx:130`
- `app/workspace/operations/booked-calls/attribution/_components/campaign-presets-card.tsx:204`
- `app/workspace/settings/_components/program-row.tsx:147`

## 6. Charts

**13 Recharts modules, 14 rendered chart definitions**. `rg -l 'recharts|@/components/ui/chart'` over the corpus finds 13 files; per-program renders both BarChart and PieChart. All 13 use ChartContainer. All use at least one --chart-* token; the team-outcome chart mixes chart, status and raw palette colours. No hard-coded hex chart palette was found. The upstream `components/ui/chart.tsx` is excluded from drift; it injects config colours as --color-* variables.

| Chart | Colour source / tokens | Evidence |
|---|---|---|
| Generic operations horizontal bars | chart-1 → --color-value; all series tokenized | `app/workspace/_components/ops-bar-chart-card.tsx:97` |
| Goal radial progress and contributor strips | chart-1 progress, chart-1..5 contributor cycle; tokenized | `app/workspace/_components/goal-progress-ring.tsx:35`, `:219` |
| Reminder chain histogram | chart-2 → --color-opportunities | `app/workspace/reports/reminders/_components/reminder-chain-length-histogram.tsx:22` |
| Revenue deal-size histogram | chart-2 → --color-count | `app/workspace/reports/revenue/_components/deal-size-distribution.tsx:27` |
| Revenue trend lines | chart-1 finalRevenue, chart-2 deposits | `app/workspace/reports/revenue/_components/revenue-trend-chart.tsx:33` |
| Revenue by origin bars | origin metadata uses chart-1..5, reuses slots across 9 origins | `app/workspace/reports/revenue/_components/revenue-by-origin-chart.tsx:39` |
| Team meeting outcome pie | 10-state mapping above; raw amber; invalid destructive hsl(); remaining categorical/muted | `app/workspace/reports/team/_components/meeting-outcome-distribution-chart.tsx:29` |
| Lead field-answer bars | chart-3 → --color-count | `app/workspace/reports/leads/_components/field-answer-distribution.tsx:25` |
| Pipeline loss-attribution stacks | chart-1 admin, chart-2 closer, chart-5 unknown | `app/workspace/reports/pipeline/_components/loss-attribution-chart.tsx:48` |
| Pipeline no-show-source bars | chart-1, chart-3, chart-5 per source | `app/workspace/reports/pipeline/_components/no-show-source-split-chart.tsx:47` |
| Pipeline stage pie | qualified/booked/call_held/follow_up chart-1..4 | `app/workspace/reports/pipeline/_components/stage-distribution-chart.tsx:24` |
| Setter qualifications composed bar/target line | chart-1 qualified; chart-2 target | `app/workspace/reports/slack-qualifications/_components/setter-qualification-trend.tsx:42` |
| Per-program revenue BarChart AND PieChart | chart-1..5 modulo by row index; index order controls colour, not a persistent program ID | `app/workspace/operations/sales-calls/_components/per-program-stat-card.tsx:203`, `:299`, `:350` |

Additional chart-like visualizations, **8 file variants**, found by `<Progress`, `backgroundColor`, and dynamic width searches and reviewed in context: reminder funnel `app/workspace/reports/reminders/_components/reminder-funnel-chart.tsx:81`, outcome card grid `reminder-outcome-card-grid.tsx:34` and revenue strips `reminder-driven-revenue-card.tsx:51` in the same folder all use OUTCOME_META chart colours; program revenue custom bars `app/workspace/reports/revenue/_components/revenue-by-program-section.tsx:93` use primary/secondary accent props; top field answers `app/workspace/reports/leads/_components/top-answer-per-field-list.tsx:82`, Slack leaderboard `app/workspace/_components/slack-user-leaderboard-card.tsx:75`, conversion ratio `slack-conversion-ratio-card.tsx:56` in that folder, and respark batch progress `app/workspace/lead-gen/_components/respark-batch.tsx:1` use Progress with semantic default styling. Goal contributor strips are already counted with their radial chart. These should share progress/legend/empty-state recipes too.

The theme defines five chart slots with identical light/dark values, `app/globals.css:71` and `:117`. Distinctness and contrast need rendered tests after the palette is chosen; no current contrast failure is asserted from source alone.

## 7. Dark mode

Count: **133 matches in 34 files**. Search `dark` in the pattern register below.
These manual dark: classes are chiefly status colour compensation, contrary to the semantic-token rule. They are migration debt even where they render correctly.

- **3 invalid colour-conversion locations**: `app/globals.css:207` to `:209` wrap complete OKLCH muted variables in hsl(), affecting the custom skeleton shimmer; team no-show colour `app/workspace/reports/team/_components/meeting-outcome-distribution-chart.tsx:32` does the same to destructive; sticky table shadow `app/workspace/settings/_components/event-type-config-list.tsx:216` does the same to border. These are invalid in both themes. Count comes from `rg -n 'hsl\(var\(--'` and grouping the three shimmer declarations as one location, total five occurrences.
- **2 arbitrary shadow declarations**: the invalid table shadow above and a fixed near-black OKLCH shadow on entity panels, `app/workspace/leads-customers/[leadId]/_components/entity-detail-ui.tsx:13`. The latter has no dark-specific adjustment, so elevation needs visual review, not an assumed contrast failure.
- **0 bg-white occurrences** outside the baseline. The **6 absolute white/black class occurrences** are two black scrims with two white zoom icons, search `absolute-color`. These are reasonable image overlays; check their overlay contrast on bright proof images. They are not white page backgrounds.
- **2 light-only text-colour candidates**: amber warning icon `app/workspace/reports/reminders/_components/reminders-report-page-client.tsx:132` and green copied icon `app/workspace/closer/meetings/_components/reschedule-link-display.tsx:64` lack dark compensation. Use warning/success roles with tested contrast.
- **7 status variables** are root-only and carry light values into dark mode; they are currently unused. Do not preserve them as a complete accessible status system without redesigning the role set. Current-time red lines and small emerald health dots also retain one fixed palette value in both themes, see the complete colour inventory.
- ThemeProvider is class-based, light by default, explicit user toggle, system mode disabled, `app/layout.tsx:96`. Do not assume OS preference is intended. No rendered dark-mode verification ran.

- `app/workspace/closer/meetings/_components/deal-won-card.tsx:225`: L225 `bg-black/0`; L225 `bg-black/20`; L226 `text-white`
- `app/workspace/billing/_components/billing-proof-preview.tsx:121`: L121 `bg-black/0`; L121 `bg-black/15`; L122 `text-white`

- `app/workspace/leads-customers/[leadId]/_components/entity-detail-ui.tsx:13`: L13 `shadow-[0_1px_2px_0_oklch(0_0_0/0.04)]`
- `app/workspace/settings/_components/event-type-config-list.tsx:216`: L216 `shadow-[0_1px_0_hsl(var(--border))]`

## 8. Icons and motion

- **1 imported icon library**, Lucide React; **0 alternative icon-library imports** found. Search external import specifiers for `lucide|icon|motion|anim`; Lucide appears, with no other matching icon or motion package. Also checked all external imports in the corpus. `components.json:15` agrees. Custom Magnus artwork is rendered as a brand asset, `components/magnus-brand.tsx:1`, not a second icon library. No inline `<svg` markup was found outside the baseline.
- **7 custom keyframes**, all in globals. Search `keyframes`. Fade-out 150ms, fade-in 200ms, stream-in 300ms, shimmer 1.5s infinite, progress 500ms, attention ring 900ms ×3, wiggle 500ms once. These need motion tokens and retained behaviour, not automatic deletion.

- `app/globals.css:170`: L170 `@keyframes vt-fade-out`; L175 `@keyframes vt-fade-in`; L182 `@keyframes stream-in`; L199 `@keyframes shimmer`; L216 `@keyframes progress-bar`; L236 `@keyframes attention-pulse-ring`; L255 `@keyframes attention-wiggle`

Count: **125 matches in 51 files**. Search `motion` in the pattern register below.
This regex is a vocabulary inventory and includes CSS selectors/comments, not a count of distinct animated widgets.

Motion vocabulary: `transition-colors` × 43, `animate-in` × 11, `transition-opacity` × 9, `transition-transform` × 8, `ease-out` × 7, `animate-spin` × 5, `duration-500` × 4, `animate-stream-in` × 4, `duration-300` × 4, `duration-400` × 3, `duration-200` × 3, `transition-all` × 3, `transition-group` × 2, `transition-old` × 2, `transition-new` × 2, `ease-in-out` × 2, `animate-progress-bar` × 2, `animate-attention-pulse-ring` × 2, `animate-attention-wiggle` × 2, `duration-600` × 2, `animate-none` × 2, `animate-pulse` × 1, `animate-css` × 1, `transition-shadow` × 1.

- View-transition CSS lives at `app/globals.css:153`; shell and streaming hooks/components should retain their animation contracts. Custom skeleton-shimmer uses are listed below. The styling rule prefers bundled shimmer utilities over bespoke keyframes.
- Reduced-motion handling exists at `app/globals.css:273`, disabling custom streaming/shimmer/attention and reducing view-transition duration. It does not automatically cover all local transforms, transitions or imperative smooth scrolling. The respark batch calls `scrollIntoView({ behavior: "smooth" })` unconditionally, `app/workspace/lead-gen/_components/respark-batch.tsx:78`; this is **1 imperative smooth-scroll location** requiring a reduced-motion policy.
- Theme toggle uses two manually sized rotating/scaling sun/moon icons, `components/theme-toggle.tsx:52` and `:61`. Report program bars animate width via transition-all, `app/workspace/reports/revenue/_components/revenue-by-program-section.tsx:96`. Onboarding dots correctly use motion-safe:animate-pulse, `app/onboarding/_components/onboarding-shell.tsx:61`.

## 9. Bundled detector

Ran the exact requested command **once**: `.claude/skills/impeccable/scripts/impeccable detect --json app components`. Exit **0**; output **[]**; about **0.17 seconds**. Rule/count summary: **no reported rules, 0 findings total**. It did not fail or time out. This run includes the requested components path, whereas manual drift counts exclude baseline primitives. Zero detector output does not establish zero drift: the source inventories above independently demonstrate palette utilities, legacy groups, arbitrary values and custom animation code. No assumptions are made about which rules the detector enabled. The impeccable context command was also invoked once, without source edits.

## Absorb into the system

- Status roles and per-theme palettes: success, warning, destructive, neutral, info; six deal positions; five attendance states; payment review statuses; enrollment/lead lifecycle; urgency; source categories; respark buckets/results. Consolidate the mappings above and explicitly decide chart status semantics.
- Typography roles: page-title, detail-title, section-title, metric, body, compact-meta, micro-label, mono-reference, brand-wordmark. Decide whether the person name and billing amount keep Aceh. Replace the 96 arbitrary sizes and 24 arbitrary tracking declarations with agreed roles.
- Containers and density: named form/profile/standard/wide/detail modes; one shell gutter owner; Card compact/default/hero density; table row and filter heights; overlay widths and chart heights. Preserve essential calendar geometry as its own recipe.
- Shared PageHeader, SectionHeader, MetricCard, StatusBadge, SourceBadge, CountBadge, feedback Alert recipes, and a detail-panel composition. Start from existing StatsCard, StatusBadge and Empty implementations, using the evidence above rather than replacing them blindly.
- DataTableFrame and mobile list row recipes, sort controls, row actions, loading/empty/error states, pagination and report footers. Keep feature columns and data queries local.
- FilterBar, searchable selector, SearchInput, DateRangeControl, period navigation and calendar header. Preserve tenant business-day/time-zone meaning.
- Field/FieldGroup form composition with unified validation, descriptions, loading, action footers and choice groups. Migrate legacy FormItem layouts in the 21 identified files.
- Chart frame, categorical and semantic series contracts, stable identity-to-colour assignment, legends/tooltips, chart empty states and progress/funnel recipes. Replace invalid hsl conversions and define a palette beyond the current five close-hue slots.
- Icon placement/sizing through component contracts; button-size variants for compact actions; motion duration/easing/distance roles, stream/view-transition/attention recipes, bundled shimmer, and reduced-motion-aware scrolling.
- Export theme for PDF colours/fonts/spacing, `lib/operations-reports/pdf.ts:13`; avoid accidentally applying browser dark mode to printable output.

## Search pattern register

Every named search above used `rg --json --pcre2 -U -e PATTERN <explicit corpus files>` and counted submatches. Negative file-set comparisons for forms/groups are documented where used. Filename inventories use the shown filename regex.

| Search | Matches | Files | Exact pattern |
|---|---:|---:|---|
| palette | 365 | 42 | `\b(?:bg&#124;text&#124;border(?:-[trblxy])?&#124;ring&#124;fill&#124;stroke&#124;from&#124;via&#124;to&#124;outline&#124;decoration&#124;shadow)-(?:slate&#124;gray&#124;zinc&#124;neutral&#124;stone&#124;red&#124;orange&#124;amber&#124;yellow&#124;lime&#124;green&#124;emerald&#124;teal&#124;cyan&#124;sky&#124;blue&#124;indigo&#124;violet&#124;purple&#124;fuchsia&#124;pink&#124;rose)-\d{2,3}(?:/\d+)?` |
| palette-variable | 1 | 1 | `var\(--color-(?:slate&#124;gray&#124;zinc&#124;neutral&#124;stone&#124;red&#124;orange&#124;amber&#124;yellow&#124;lime&#124;green&#124;emerald&#124;teal&#124;cyan&#124;sky&#124;blue&#124;indigo&#124;violet&#124;purple&#124;fuchsia&#124;pink&#124;rose)-\d{2,3}\)` |
| literal | 84 | 7 | `#[0-9a-fA-F]{3,8}\b&#124;(?:rgb&#124;rgba&#124;hsl&#124;hsla&#124;oklch)\([^\n)]*\)` |
| size | 96 | 46 | `\btext-\[(?:\d&#124;\.)[^\]]+\]` |
| weight | 579 | 190 | `\bfont-(?:thin&#124;extralight&#124;light&#124;normal&#124;medium&#124;semibold&#124;bold&#124;extrabold&#124;black)\b` |
| tracking | 125 | 74 | `\btracking-(?:\[[^\]]+\]&#124;[\w.-]+)` |
| arbitrary-tracking | 24 | 15 | `\btracking-\[[^\]]+\]` |
| brand | 5 | 5 | `\bfont-brand\b` |
| layout | 216 | 112 | `\b(?:p[trblxy]?&#124;m[trblxy]?&#124;gap(?:-[xy])?&#124;[wh]&#124;min-[wh]&#124;max-[wh]&#124;top&#124;left&#124;right&#124;bottom&#124;basis&#124;grid-cols&#124;translate-[xy])-\[[^\]]+\]` |
| space | 27 | 14 | `\bspace-[xy]-[\w.]+` |
| card-padding | 59 | 40 | `<Card(?:Content&#124;Header&#124;Footer)?\b[^>]*className="[^"]*\bp[xytrbl]?-` |
| panel | 113 | 75 | `<(?:div&#124;section)\b[^>]*className="[^"]*rounded[^\"]*(?:bg-card&#124;border)[^\"]*"` |
| raw | 23 | 21 | `<(?:button&#124;input&#124;table)\b` |
| h1 | 50 | 46 | `<h1\b[^>]*>` |
| empty | 57 | 51 | `<Empty\b` |
| form | 36 | 35 | `<form\b` |
| dark | 133 | 34 | `\bdark:[^\s"`]+` |
| absolute-color | 6 | 2 | `\b(?:bg&#124;text&#124;border)-(?:white&#124;black)(?:/\d+)?` |
| shadow | 2 | 2 | `\bshadow-\[[^\]]+\]` |
| keyframes | 7 | 1 | `@keyframes\s+[\w-]+` |
| motion | 125 | 51 | `\b(?:animate&#124;transition&#124;duration&#124;ease&#124;delay)-[\w\[\]./-]+` |
| conditional | 3 | 1 | `className=\{`` |
| equal-dimensions | 44 | 17 | `\b(?:h-(\d+(?:\.\d+)?)\s+w-\1&#124;w-(\d+(?:\.\d+)?)\s+h-\2)\b` |

Appearance candidate scan opening pattern: `<(?:Button OR Badge OR Card(?:Title OR Description)? OR Alert(?:Title OR Description)? OR Input OR SelectTrigger)\b[^>]*?className=(?:"[^"]*" OR \{[\s\S]*?\})`; retain only appearance utilities as described in section 5. Button-icon scan uses paired `<Button ... </Button>` blocks and nested icon/Spinner names with size-/h-/w- utilities; it excludes Button and Badge names from the icon count. These composite results are review candidates, not AST guarantees.

## Limits and verification

- Only `.impeccable/audit/drift.md` was written. I made no source edits, dependency installs, migrations, tests, build, server or browser session. An unrelated `AGENTS.md` working-tree change appeared during the audit and was left untouched.
- Dark-mode appearance, contrast, touch targets, responsive overflow and motion behaviour remain unverified visually. Findings labelled candidates need that check after a design direction exists.
- Search inventories cover the named application corpus and exported PDF UI helper. External WorkOS widgets and generated/third-party internals are outside scope. Comments and tests can match regexes; the raw-input comment and React error-number literal false positives were explicitly removed from defect totals.
- Component variants in filename inventories are a redesign absorption map. They are not evidence of functional defects or a recommendation to collapse every domain component.

### Compound search recipes

- Forms missing FieldGroup: `rg -l '<form\b' <corpus>` set difference `rg -l '<FieldGroup\b' <corpus>`. All resulting files have one form and contain FormField.
- Missing groups: `rg -l '<SelectItem\b' <corpus>` minus `rg -l '<SelectGroup\b' <corpus>`; repeat for DropdownMenuItem / DropdownMenuGroup. Counts are files.
- Payment conflicts: compare the three keys in STATUS_TONE to PAYMENT_STATUS_CONFIG. Recorded and disputed differ in hue, verified agrees; the two semantic-only presentations are listed separately.
- Invalid conversion: `rg -n 'hsl\(var\(--' <corpus>` gives five lines in three files. Three adjacent shimmer lines are one affected CSS recipe.
- Paired-button icon search: `rg --pcre2 -U -o '<Button\b(?:(?!<Button\b)[\s\S])*?</Button>' <corpus>`, then match `<(?:[A-Z]\w*Icon|Sun|Moon|Trash2|Plus|Spinner)\b[^>]*className=[^>]*(?:size-\d|\bh-\d|\bw-\d)[^>]*>` inside each block. Sum matches, not output lines.
- Appearance overrides: use the opening-element pattern above, then retain matches containing `\b(?:bg-|font-|tracking-|text-(?:\[|xs\b|sm\b|base\b|lg\b|[2-9]?xl\b|muted|foreground|primary|destructive|emerald|amber|blue|red)|rounded-)`. This counts 132 candidate opening elements.
- Chart inventory: `rg -l 'recharts|@/components/ui/chart' <corpus>`; count `<BarChart\b|<PieChart\b|<LineChart\b|<RadialBarChart\b|<ComposedChart\b` for 14 rendered definitions, excluding imports.
