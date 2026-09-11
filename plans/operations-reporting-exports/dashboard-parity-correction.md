# Dashboard parity and multiple currencies

## Correction

The first reporting implementation changed the presentation when a range used a background job. It replaced dashboard components with generic report tables, so Qualifications and Booked Calls lost their bar charts and Lead Gen lost its KPI cards and team grouping. This contradicted the intended separation between data retrieval and presentation.

All ranges must render the existing dashboard components. Small safe ranges use live queries. Larger ranges and capped live queries use background jobs, then adapt completed aggregate results into the same component props. Loading uses those components' existing skeletons. Job progress, errors, generation time, and Refresh remain available.

## Data transport

Report jobs keep the existing bounded readers, checkpoints, result rows, authorization, and file cleanup. The browser reads immutable aggregate sections in pages of 50 and assembles each complete section before passing it to the original components. Individual Convex calls never return an unbounded array. Raw submission and meeting lists retain their independent pagination.

Changing the range, source, or job discards pending results from the previous scope. A page error is visible and never turns partial data into a completed dashboard. Empty byte-limited pages continue through their cursor. Repeated cursors fail with a retry message.

Materialized rows include the canonical member identity fields used by the live queries: name, email or secondary label, avatar URL and source, and active status. Team labels, schedules, rates, goals, and event timestamps must match the corresponding live view. Lead Gen's dashboard top ten is ranked by submissions after all origin aggregate pages arrive; workbook ranking remains its existing separate contract.

## Currency display

Phone Sales must load even when payments use different currencies. Call activity remains independent of currency. Monetary values are grouped by currency globally, by program, and by closer. The UI keeps the existing cards and tables and adds a selector for their monetary values, defaulting to USD when available and otherwise to an available currency. No exchange rate or combined total is inferred.

Exports retain currency on every monetary row and use currency-aware labels and formatting. The application stores every currency as integer hundredths, so formatting always divides by 100; currency-specific display precision does not change that divisor. Invalid or custom currency codes fall back to a numeric amount and their original label. Raw payments continue to identify their original currency and stored amount.

## Compatibility and rollout

CRM records do not need a backfill. Reporting rows are temporary scalar payloads in the existing tables. Increment the report definition version and prevent old in-flight jobs from continuing with new reducers; ask the client to regenerate instead. Keep old job/artifact metadata until normal cleanup removes the owned files and rows. Never remove ownership records early.

Deploy the compatible backend to development first, verify the existing query responses and completed jobs, then exercise Day and Month in the browser. Production rollout must publish the backend before the matching frontend.

## Verification

- Render the actual dashboard components in regression tests and assert the original charts, cards, and contribution sections remain in snapshot mode.
- Verify full live/snapshot view-model parity, including identities, schedules, goals, null rates, zero-activity members, and team grouping.
- Check pagination beyond one result page, empty intermediate pages, stale requests, and cursor failures.
- Check USD plus another currency, a report containing only non-USD payments, and appropriate currency formatting in the UI and CSV/Excel/PDF.
- Run focused automated tests, TypeScript, lint, build, development deployment validation, and browser checks. Record outcomes separately after execution.

## Validation results — September 11, 2026

- Original UI regression tests pass for all four historical dashboards. Full worker/public-result/live-adapter parity tests pass for Qualifications and Booked Calls; Sales integration covers USD/EUR, payment-only programs, and an inactive former closer.
- The full test run passed 52 tests, including the 32,001-event and 8,501-group tests, and exposed one security fixture still using an obsolete definition version. After updating that fixture, all seven security tests passed. The two new dashboard parity integration tests also passed separately.
- TypeScript, Convex TypeScript, changed-file ESLint, `git diff --check`, and the production build passed.
- Convex development deployment `cautious-donkey-511` succeeded. Authenticated browser checks completed Day and Month on all four routes after loading skeletons disappeared, with original headings/layout sections and no page errors. Development data was sparse; populated edge cases are covered by the integration fixtures.
- Mixed-currency CSV and numeric Excel tests passed. A generated PDF containing USD, EUR, JPY, KWD, and a malformed currency code was rendered and visually inspected without clipping.
- Independent review findings about missing booking teams, program show-up rates, DM closer display names, and already-ready old-version reports were fixed and rechecked.
