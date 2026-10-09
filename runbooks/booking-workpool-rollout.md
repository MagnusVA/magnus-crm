# Booking and reporting Workpool rollout

Status: implementation only. No production deployment, migration, replay, or data repair has been performed for this change.

## What changes

Webhook acceptance writes the raw payload, a durable delivery receipt, provider facts, and a Workpool job in one transaction. A receipt keeps its deduplication key after raw-payload retention expires. The processor commits booking changes and its terminal outcome atomically. Outcomes are `applied`, `ignored`, `blocked`, or `failed`; a blocked booking retains its payload and a reason for review.

Meeting commands read the current meeting by ID inside their mutation. They commit the business change, existing synchronous aggregate updates, and a reporting obligation together. Reporting workers read current source records and replace each meeting's recorded contribution in `operationsMeetingStatsV2`. Repeated requests coalesce, and generation checks make obsolete workers and completion callbacks harmless. Opportunity changes fan out through cursor-based pages, including changes received during an existing sweep.

The two pools have independent concurrency limits: four webhook mutations and two reporting mutations. These are starting limits, not measured production throughput guarantees. Workpool mutations receive Convex's transaction/OCC retry behavior; failed mutations do **not** receive the action retry policy. The application retains failed work and exposes guarded manual retry.

Reporting becomes eventually consistent. A failed report job does not undo a closer's committed outcome. The operations health banner shows pending reporting work and delivery problems; the attribution diagnostics tab exposes delivery previews and retries plus failed reporting jobs. Existing synchronous aggregate components remain in use. Convex → Fivetran → ClickHouse is unchanged.

## Invariants covered by tests

- Duplicate delivery, including after raw cleanup, cannot create another booking.
- Cancellation arriving before creation is retained and reconciled when creation arrives.
- Out-of-order no-show removal wins over an older no-show addition.
- An explicit provider reschedule stays on the same opportunity; cancellation of the old booking cannot cancel its replacement.
- Late provider cancellation cannot undo a completed paid outcome.
- Placeholder phone numbers cannot merge different emails; conflicting real identifiers block for review.
- Unicode, multiline, and repeated question labels are stored under stable safe keys, with labels preserved for display.
- Unknown and inactive hosts cannot create orphaned meetings. A corrected host can be retried with a fresh preview.
- Historical bookings cannot reopen a newer opportunity outcome. Invalid internal reschedule links roll back their attempted business changes.
- A meeting contributes once after status changes, and an opportunity with 205 meetings updates beyond the former 200-row cutoff.
- A monthly report includes 1,300 bucket rows, beyond the former 1,000-row cutoff.
- A failed projection leaves the source outcome intact and supports a generation-checked retry after repair.
- Existing tenants cannot read empty V2 totals before the rebuild is verified.
- Recovery requires tenant admin/master access and rejects another tenant's records.

Tests use synthetic records. The investigation's production fixtures must not be copied into the repository.

## Deployment and migration sequence — run together later

This is one coordinated application release, with a widen/rebuild/verify sequence inside the release. It deliberately retains the old stats table and optional schema fields; there is no destructive narrowing step.

1. Take a production backup/export and record source counts, old report totals, delivery backlog, and the deployment version. Pause raw cleanup while checking the legacy delivery inventory. Drain the legacy scheduled webhook processor before changing its action entry point to a mutation. Confirm no destructive replay or old backfill is running. Any legacy job that cannot drain must be inventoried for receipt adoption and reviewed recovery. Use a maintenance window for reports: existing tenants with old stats receive a rebuild-not-verified error until activation.
2. Deploy the backend, components, generated bindings, and frontend together. Do not run an old deployment's writers alongside the new readers. Preserve existing vendor sync configuration.
3. Run `adoptWebhookDeliveryReceipts`, then `assertWebhookDeliveryReceipts`. Adoption records legacy outcomes and provider facts but does not replay business changes. A historical `processed=true` flag alone is insufficient evidence of a successful booking; unmatched supported deliveries become `legacy_delivery_requires_review`. Unsupported event types become ignored. Duplicate raw rows retain one canonical receipt/payload.
4. Run `rebuildMeetingProjections`. It enqueues small batches from **source meetings**, never from inflated old totals. Wait for the reporting pool's meeting and opportunity jobs and the webhook pool's delivery jobs to drain; inspect failures in diagnostics and repair their cause before retrying.
5. Run `assertMeetingProjections`, `assertMeetingProjectionSources`, and `assertMeetingProjectionBuckets`, in that order, after the drain. They check source relationships and expected keys, orphaned contributions, and exact per-bucket counts. Re-run assertions from the beginning if a repair changes their inputs. The migration component tracks completed runs, so a completed assertion must be explicitly restarted rather than assumed to have checked later repairs.
6. Call `activateMeetingProjections` for the test tenant only after checking the assertions completed on this rebuild. The mutation requires the rebuild and assertion migrations to be complete and no queued or failed reporting work for the tenant. Verify representative closer, phone-sales, overview, team-performance, pipeline-health, and export ranges against source records. After validating the test tenant, activate every other affected tenant individually, checking the current assertion results and that tenant's reporting queue before each activation. Existing tenants with legacy stats cannot use V2 reports until activated; keep their reports in maintenance until then. Resume cleanup after the receipt inventory is verified.
7. Review the historical blocked deliveries and identity contamination separately, as below. Recheck projections after approved repairs.

Migration invocation pattern (commands are examples; none have been executed):

```sh
pnpm exec convex run --prod migrations:run '{"fn":"migrations:adoptWebhookDeliveryReceipts"}'
pnpm exec convex run --prod migrations:run '{"fn":"migrations:assertWebhookDeliveryReceipts"}'
pnpm exec convex run --prod migrations:run '{"fn":"migrations:rebuildMeetingProjections"}'
# Wait for the reporting backlog to drain before assertions.
pnpm exec convex run --prod migrations:run '{"fn":"migrations:assertMeetingProjections"}'
pnpm exec convex run --prod migrations:run '{"fn":"migrations:assertMeetingProjectionSources"}'
pnpm exec convex run --prod migrations:run '{"fn":"migrations:assertMeetingProjectionBuckets"}'
# Replace TENANT_ID only after reviewing migration status and queue health.
pnpm exec convex run --prod migrations:activateMeetingProjections '{"tenantId":"TENANT_ID"}'
```

A migrations runner call starts resumable work; its return is not proof that the complete migration finished. Inspect the migrations component status before advancing. Never start verification while its rebuild is still running.

## Existing data and recovery

The investigation found roughly 6,364 meetings, 89 stuck deliveries, 27 deliveries affected by invalid question keys, and a lead contaminated through a placeholder phone with 54 email aliases. Old operations totals exceeded source meetings by 957. These are the investigation snapshot, not post-change validation results.

- Review/link missing Calendly hosts and distinguish non-closer bookings from tracked sales calls. Do not invent a closer assignment.
- Preview selected receipts in diagnostics, correct the underlying cause, and retry only those reviewed receipts. A retry stores the actor and prior generation/status/reason. Stale previews fail atomically. Retrying does not bypass identity or historical-state checks.
- Historical receipts may remain blocked after the host or question-key fix because the lead has newer business activity. Review the intended historical relationship before authoring a scoped repair; never reset all raw events to unprocessed.
- Existing mixed-identity leads, identifier aliases, meetings, opportunities, and payments need a reviewed reassignment manifest. The new identity resolver prevents further propagation; it does not guess which historical records belong to which person.
- Old raw webhook payloads already deleted by retention cannot be reconstructed by this release. Receipts protect new retained identities going forward.
- The former destructive raw-webhook rebuild endpoints now reject calls, including old queued destructive entry points. They cannot be used as a recovery shortcut.

## Capacity and failure boundaries

Opportunity reporting sweeps use pages of 64 meetings. Rebuild migrations enqueue batches of 32. Admin delivery listings and report-work listings paginate at up to 100 rows; recovery previews accept at most 50 distinct deliveries. Health counts show `100+` rather than a false exact total.

Live stats readers support up to 8,192 bucket rows, above the observed monthly range. They explicitly reject or report truncation/use their existing materialized fallback beyond that bound; they do not silently accept the old 1,000-row partial result. Sales-call live stats use a 4 MiB read budget. Bucket assertions reject a single bucket above 8,192 contributions rather than verifying a partial count. Test that these bounds remain appropriate as source volume grows; the future warehouse reporting change is separate work.

Booking identity checks reject excessive candidate sets (more than 16 per identifier or 128 opportunities) for review. Synchronous closer reassignment rejects histories above 1,000 meetings before writing; it never silently updates the first 100. A booking wakes at most 64 waiting provider deliveries; any remaining blocked receipts stay visible for review/retry. These bounds protect transaction size and are explicit operating limits, not claims of unlimited scale.

Monitor webhook queue age, blocked/failed receipts, reporting queue age and failures, Workpool duration/OCC contention, and source-versus-projection counts during validation. A bounded cron reports stale/failed reporting work. Increasing pool parallelism may increase write contention on shared buckets; measure before changing it.

A missing/corrupt V2 bucket is a visible projection failure. Restore/reconcile its recorded contributions under review before retrying; simply re-enqueueing cannot repair arbitrary corruption. Never clear V2 buckets while retaining their contribution ledger.

## Rollback

Keep the widened schema and receipt/contribution tables. Pause ingress/processing as needed and deploy a forward correction. An old code rollback resumes old accounting and stops maintaining V2; do not leave V2 readers active through that rollback. Rebuild and re-verify from authoritative records before reactivating reporting. Do not delete receipts, source records, domain events, payments, or component aggregate data to make a replay pass. Drain/cancel work before any test-tenant destructive reset.
