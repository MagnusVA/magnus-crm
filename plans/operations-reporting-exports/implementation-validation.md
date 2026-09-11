# Operations reporting: implementation and validation

Date: 2026-09-11. Implemented in the working tree; backend deployed to the development deployment only. Production rollout has not been performed.

## Delivered behavior

All four Operations dashboards share asynchronous Summary CSV, raw ledger CSV, Performance Excel, and Report PDF exports. Sales Calls also has Raw Payments CSV. Lead Gen retains its existing team workbook layout. PDF uses a Node renderer with repeated table headings, page numbers, and bounded file parts.

Ranges longer than seven days use background reports. A short live query that reaches its row or byte budget switches to the same reporting path. Historical summaries and result tables are materialized separately; tables and file manifests return at most 50 rows per request. The Operations date picker permits custom ranges over 120 days; other dashboards retain their existing default range policy.

The client creates a job through an authenticated mutation, subscribes to its status, and downloads a completed single-file export. It also offers explicit download/retry controls, including numbered parts for large reports. Historical views show generation time, Refresh, cancellation, and failure states.

## Processing and retention

- Indexed source readers use bounded pages with small, explicit hydration limits. Live scans retain at most 512 KiB before returning a capped result, leaving headroom for the document that crosses the boundary.
- Workers checkpoint contributions and cursors atomically and yield after 20 pages or 40 seconds. A lease generation prevents an older worker from publishing after takeover.
- Aggregate groups and cross-page deduplication keys live in temporary rows. A large result never travels through one Convex array or one action-local map.
- File parts hold at most 5,000 CSV rows, 2,000 Excel rows, or 300 PDF rows, with additional input/output byte guards. Each artifact is at most 16 MiB.
- Jobs have a two-hour age limit, three recovery attempts, and per-user/per-tenant concurrency limits. Exceptions fail visibly rather than publishing incomplete totals.
- Download eligibility lasts ten minutes after completion. The ten-minute sweeper deletes owned report files and temporary data in bounded batches. Already issued storage URLs remain usable until physical deletion; ordinary retention is ten to twenty minutes, subject to scheduler delays.
- The ten-minute recovery sweep handles abandoned leases. Reserved uploads carry an ownership token in their content type plus an expected SHA-256, size, and time window, allowing recovery after a crash between storage upload and database attachment.
- Upload reservations remain open for eleven minutes: the documented ten-minute Node action lifetime plus a one-minute settlement margin. Cleanup waits for that window before declaring its ownership scan complete, including for attached files, so a slow interrupted upload is still covered. A regression verifies recovery of a file uploaded after the former two-minute window.
- Access requires current tenant admin/master membership and job ownership. Workers recheck membership when claiming work, renewing a lease, and publishing a result; revocation cancels the job and schedules cleanup. Download eligibility is checked in a mutation with fresh server time. Sales monetary reports retain the application's USD contract; non-USD input fails explicitly and remains available in Raw Payments CSV.

## Pagination invariant

Action scans never supply `endCursor`. If a byte-limited page reports `SplitRequired`, its `continueCursor` is the actual stopping position, so committing that page and continuing does not skip its tail. The backend checks the limit before consuming the next document and falls back to the scan cursor when no end cursor exists. See the [index scan](https://github.com/get-convex/convex-backend/blob/dc69b906006e06ef3cde6c82450d3dcb0a35b9c3/crates/database/src/query/index_range.rs#L168-L184) and [pagination implementation](https://github.com/get-convex/convex-backend/blob/dc69b906006e06ef3cde6c82450d3dcb0a35b9c3/crates/isolate/src/environment/udf/async_syscall.rs#L1745-L1805).

Published result rows and artifact manifests are immutable while a job is ready. Their reactive pages cannot grow into incomplete fixed intervals. Changing this invariant would require explicit reactive page splitting.

## Migration and deployment

Four additive tables hold jobs, checkpoints, result/deduplication rows, and artifact ownership. Existing business documents and rollups require no backfill. Deploy the compatible backend before the frontend. Keep cleanup and artifact ownership tables during rollback until all report files are removed.

The implementation uses Convex 1.45.0 and Node 24. `@react-pdf/renderer` and React are external Node action packages: bundling the renderer initially failed on its font package import, while the external package configuration passed the actual Convex runtime probe. There is no external PDF service or browser-rendering dependency.

The design's staged rollout remains a production release step. No tenant rollout flag was added; the current integration is restricted by the existing Operations admin authorization. To roll back the UI, restore the previous small-range entry points while leaving the new backend cleanup available. Do not send large ranges back through capped live queries.

## Validation evidence

Automated coverage includes metric populations and null/rate behavior, cross-page unique sums, idempotency, stale leases, role/tenant/owner isolation, expired downloads, reservation recovery, cleanup fairness, byte guards, CSV injection handling, typed Excel currency/percentage cells, and PDF rendering budgets.

The volume fixture scans 32,001 qualification events through the actual worker and checks the complete total. An independent Convex test database with 8,501 materialized rows checks bounded public pagination without missing or duplicated groups. The latter isolates the result-array boundary from convex-test's unindexed lookup cost; it is not a production throughput benchmark. The combined fixture timed out under shared-host load, so these checks were separated and routine fixture logs suppressed. Both tests then passed in 101.98 seconds under Node 24, retaining their 120-second individual timeouts and full data volumes.

An interrupted-upload test stores bytes but omits attachment, recovers the owned file through reconciliation, then deletes it through terminal cleanup. An unrelated file containing identical bytes but a different ownership token survives. The test fixture explicitly supplies content-type metadata omitted by convex-test 0.0.57; a separate real Convex Node action probe verified that production storage preserves this MIME parameter and returns base64 SHA-256 metadata.

The PDF stress fixture renders 300 rows across 38 pages with repeated headings and page numbers. Its first page was visually inspected, including long names and USD values. The latest local run generated a 96,563-byte PDF and 44,634-byte workbook; host RSS was approximately 216 MiB. This is a renderer check, not a measurement of deployed peak memory.

Browser QA used the configured development test owner. All 17 export choices produced downloads: Summary CSV, Performance Excel, and Report PDF on each page; all four raw ledgers; and Sales Raw Payments CSV. The four downloaded workbooks opened with valid sheet structures. All four downloaded PDFs parsed successfully, and the Booked Calls PDF was also visually inspected.

All four dashboards completed a custom March 1–September 11 range, exceeding the previous 120-day picker limit. Rapid Day → Week → Month changes settled on the correct report. A development browser session encountered a Convex protocol-version error during the last Booked Calls PDF check; a clean production-build session completed the same download with no browser errors. No speculative auth or protocol patch was made.

The production build and TypeScript check pass. ESLint passes for all changed source files, including the final animated export trigger. Security coverage includes seven tests, including access revocation after a worker has claimed a job.

Final automated results: 31 passing tests across seven files, run as the 29-test suite plus the two isolated volume checks. The final production build passes, and the last development backend push completed successfully. No production deployment was performed.

The final cleanup regression starts with 51 ready jobs and verifies that scheduled continuations expire them, remove their children, and purge their metadata across the 50-job boundary. Cleanup continues after finishing a job and schedules a delayed retry for temporarily blocked artifacts, allowing other jobs to proceed.

After deploying that fix to development, the scheduled chain completed cleanup for all 29 expired QA jobs. The verification query reported zero pending cleanup jobs; ready reports retained their artifacts.

Temporary browser authentication state and QA scripts were deleted after validation. The local browser QA server was stopped; report samples remain outside the repository.
