# Leads & Customers Unified View - UX Direction Lock

**Phase:** 0D - UX Direction and Component Reuse Lock  
**Date captured:** 2026-05-31

## Design Position

The unified workspace should feel like a compact executive ledger: restrained, dense, readable under repeated operational use, and consistent with the existing Tailwind 4 + `radix-nova` shadcn surface. Avoid marketing composition, oversized cards, and decorative color. Use small, precise sections with high information scent.

## Visual Contract

- Use existing semantic tokens from the app theme; do not introduce a one-off palette.
- Prefer full-width sections, hairline borders, and separators over nested cards.
- If cards are used, reserve them for repeated records, modals/sheets, or clearly framed tools. Do not place cards inside cards.
- Keep radius small and consistent with current shadcn primitives.
- Use tabular figures for counts, dates, money, and sortable numeric columns.
- Use badges sparingly for lifecycle, customer status, opportunity status, source, and permission-limited rows.
- Keep text sizing compact: page heading at current workspace scale, section headings at `text-base`/`text-sm`, table rows tight but readable.
- Dark mode must be first-class through existing tokens; no hardcoded light-only colors.

## Browse Page Contract

| Area | Rule |
|---|---|
| Header | One compact header row with title and side-deal action. No hero section. |
| Search | Search by name, email, phone, handle, lead ID, customer ID, opportunity ID, and meeting ID. Sync `q` to URL. |
| Filters | Lifecycle filter uses segmented control/tabs and syncs to URL. |
| Results desktop | Use semantic `Table` for dense rows. Identity, lifecycle/state, last signal, opportunities, meetings, and last activity must fit without horizontal churn at normal desktop widths. |
| Results mobile | Use compact row/card list, not a squeezed desktop table. Show identity, lifecycle, best contact hint, opportunity/meeting counts, and last signal. |
| Row actions | Primary row destination must be a `Link`; support Cmd/Ctrl-click and middle-click. Inline opportunity action links to detail with `?opportunityId=`. |
| Loading | Use skeletons with `role="status"` and `aria-label`; dimensions must match final rows to avoid CLS. |
| Empty states | Use existing `Empty` primitives; never render broken blank tables. |

## Detail Page Contract

No required detail data may be hidden behind tabs. Anchor navigation is allowed only as a jump aid.

Required section order:

1. Header and lifecycle strip
2. Identity chain
3. Customer/payment strip when converted
4. Opportunities
5. Meetings and visible comments
6. Payments
7. Activity
8. Fields and identifiers
9. Attribution, either integrated into sections or a compact field grid

Section rules:

- Header shows name, email, phone, social handles, lifecycle badges, and customer status if converted.
- Identity chain is a compact strip, not the current oversized relationships card.
- Opportunities are visible as rows with status, source, program, closer, payment summary, and Details action.
- Meetings are visible with role-appropriate meeting links opening new tabs.
- Comments render inline and bounded; no comment text appears for unauthorized viewers.
- Payment rows use existing semantics and guards; payment proof details stay out of overview rows unless explicitly authorized.
- Activity is a single chronological timeline, not split across hidden tabs.
- Fields and identifiers use a dense definition grid with truncation/breaking for long values.

## Opportunity Sheet Contract

- Use `Sheet`, `SheetContent side="left"`, `SheetHeader`, `SheetTitle`, and `SheetDescription`.
- Sheet state is URL-addressable via `?opportunityId=<id>`.
- Closing the sheet removes only `opportunityId` from the URL.
- Sheet content should reuse existing opportunity detail payload and components where density fits.
- The page behind the sheet remains the person context; the sheet should not navigate away for ordinary detail inspection.
- Sheet scroll container uses overflow containment and should not obscure meeting links.

## Accessibility And Interaction Rules

These rules come from the repo conventions plus the current Vercel Web Interface Guidelines fetched on 2026-05-31.

- Icon-only buttons must have `aria-label`; decorative icons use `aria-hidden="true"`.
- Use `<button>` for actions and `<Link>`/`<a>` for navigation. Do not use clickable `<div>`/`tr>` as the only action surface.
- Interactive elements need visible `focus-visible` treatment.
- Form controls need labels or `aria-label`, meaningful `name`, and correct `type`/`inputMode`.
- Async validation/toast regions need accessible announcements where the existing primitive does not already provide them.
- Headings must remain hierarchical; anchor targets need `scroll-margin-top`.
- Long PII/user-generated fields need `min-w-0`, `truncate`, `line-clamp-*`, or `break-words`.
- Dates, times, currency, and numbers use `Intl.*` helpers or existing formatting helpers, not ad hoc string formatting.
- Loading copy uses an ellipsis character (`…`) where visible.
- Respect reduced motion. Avoid route or sheet animation that blocks interaction.

## Responsive Rules

- Avoid horizontal overflow on mobile; desktop-only tables must degrade to mobile rows.
- Fixed-format elements such as row action columns, badge groups, counters, and sheet widths need stable dimensions/responsive constraints.
- Do not scale font size with viewport width.
- Sheet width: full width on small screens; constrained left sheet on `sm+`.
- Keep touch targets usable in dense layouts; icon buttons still need clear hit areas and labels/tooltips where meaning is not obvious.

## Component Reuse Decisions

| Existing component | UX decision |
|---|---|
| `EntityAttributionCard` | Keep data model; redesign display as compact field grid for entity/detail/sheet contexts. |
| `LeadsTable` | Use as density reference only; new rows should use `Link` surfaces, URL state, and lifecycle data. |
| `CustomersTable` | Use payment/customer column ideas; do not reuse as-is because route identity changes to lead ID. |
| `LeadDetailPageClient` tab sections | Mine content; do not preserve tab-gated information architecture. |
| `PaymentHistoryTable` | Reuse or extract if it remains compact and permission-safe. |
| `OpportunityMeetingsList` | Reuse/extract for sheet and entity sections, with target blank for meeting links where required. |
| `OpportunityPaymentsList` | Reuse/extract for opportunity sheet after density pass. |
| `OpportunityActivityTimeline` | Reuse/extract for sheet and activity section. |
| `CreateOpportunityPageClient` | Move/copy under new namespace; keep React Hook Form + Zod v4 resolver pattern. |

## Do Not Do

- Do not create a landing page or hero.
- Do not hide detail sections behind tabs.
- Do not nest cards or stack decorative panels inside panels.
- Do not add new charting, animation, table, or design-system packages.
- Do not show every state in bright colors; reserve contrast for lifecycle and action priority.
- Do not log or display raw identifiers in helper text, screenshots, analytics, or debug surfaces.
