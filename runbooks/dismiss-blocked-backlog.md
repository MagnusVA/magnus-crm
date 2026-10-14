# Dismiss the blocked webhook backlog

Status: not run on production yet.

## What it does

PR #91 reached production on 2026-10-14 at 06:27:20 UTC. Every webhook delivery blocked before then was classified by the old pipeline. We decided to fix forward instead of reviewing them one by one, so `migrations:dismissBlockedBacklog` dismisses them.

For each delivery with status `blocked` received before the cutoff (`DISMISS_BLOCKED_BEFORE` in `convex/pipeline/dismissal.ts`), it:

- writes a `webhookDeliveryDismissals` row with the previous status, reason and generation (the undo log)
- sets the delivery to `ignored` with reason `dismissed_backlog`, and bumps its generation so any stale Workpool job for it does nothing
- marks its raw event processed with `processingReason: "dismissed_backlog"`, which stops the stuck-event alerts

Deliveries blocked after the cutoff, and deliveries that are `queued`, `failed`, `applied` or `ignored`, are left alone. No lead, opportunity, meeting or payment is touched.

## What you lose

The daily raw cleanup treats a dismissed delivery as resolved. It deletes the raw payload once the delivery is more than 30 days old. On 2026-10-14 that covers every legacy delivery from before Oct 9. After that, a dismissed legacy delivery can be restored to the review queue but can't be retried, because its payload is gone. The export in step 1 is the only copy.

## Steps

All commands target production through `--env-file .env.vercel.production`. `--prod` is not reliable here, because `.env.local` holds a dev deploy key.

1. Back up production, and keep the export outside the repo. It contains customer PII.

   ```sh
   npx convex export --env-file .env.vercel.production --path ~/magnus-backups/prod-before-dismissal.zip
   ```

2. Preview. This is read-only. On 2026-10-14, `toDismiss` was 342 and `blockedAfterCutoff` was 0.

   ```sh
   npx convex run --env-file .env.vercel.production pipeline/dismissal:previewBlockedBacklogDismissal
   ```

3. Dry run. This runs one batch and rolls it back.

   ```sh
   npx convex run --env-file .env.vercel.production migrations:run '{"fn":"migrations:dismissBlockedBacklog","dryRun":true}'
   ```

4. Run the migration and wait for it to finish.

   ```sh
   npx convex run --env-file .env.vercel.production migrations:run '{"fn":"migrations:dismissBlockedBacklog"}'
   npx convex run --env-file .env.vercel.production --component migrations lib:getStatus '{"names":["migrations:dismissBlockedBacklog"]}'
   ```

5. Assert. It fails if a pre-cutoff delivery is still blocked, if a dismissed delivery has no log row, or if a dismissed delivery's raw event isn't marked processed.

   ```sh
   npx convex run --env-file .env.vercel.production migrations:run '{"fn":"migrations:assertBlockedBacklogDismissed"}'
   ```

6. Verify:
   - The preview now shows `toDismiss: 0`.
   - The operations health banner no longer counts the blocked backlog.
   - `pipeline.events_stuck_unprocessed` stops firing in PostHog within 15 minutes.

## Undo

Find the delivery IDs in `webhookDeliveryDismissals` (`npx convex data webhookDeliveryDismissals --env-file .env.vercel.production`). Then restore up to 100 per call:

```sh
npx convex run --env-file .env.vercel.production pipeline/dismissal:restoreDismissedDeliveries '{"deliveryIds":["<id>","<id>"]}'
```

A restored delivery goes back to `blocked` with its old reason and shows up in pipeline recovery again, where an admin can retry it if its payload still exists. Running `dismissBlockedBacklog` again with `reset: true` would dismiss it again.
