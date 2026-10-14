# Close the stale Slack opportunity backlog

Status: not run on production yet.

## What it does

A Slack-qualified opportunity that never books closes as lost, reason `stale`, 31 days after qualification: a day past the 30-day window in which a booking can join it. The hourly cron `expire-stale-slack-opportunities` does this, but only for opportunities that pass 31 days after the cutover, `STALE_EXPIRY_CUTOVER_AT` in `convex/slack/staleExpiry.ts` (2026-10-16). Older ones are the backlog, and `migrations:expireStaleSlackBacklog` closes them when you run it.

Each closed opportunity:

- moves to `lost` through `transitionOpportunity`, so `activeOpportunities` drops and `lostDeals` rises, its qualification row shows `lost`, and it gets an `opportunity.marked_lost` domain event, which also goes to PostHog
- keeps its activity time, so it doesn't jump to the top of activity-sorted lists
- stays counted as a Slack qualification for its setter
- is left out of the pipeline health loss attribution

A booking made inside the 30 days but processed later, such as a retried blocked delivery, reopens the deal. A new Slack qualification or booking for the person starts a new deal.

## Steps

All commands target production through `--env-file .env.vercel.production`, because `.env.local` holds a dev deploy key. Step 1 only reads. Steps 2 and 3 go through the migrations component and step 2 closes opportunities, so run them only with the owner's approval.

`migrations:run` only starts the batches, so its output proves nothing. After each one, re-run `getStatus` until it reports `isDone: true`. If it reports `state: "failed"`, its `error` names the opportunity that failed.

```sh
npx convex run --env-file .env.vercel.production --component migrations lib:getStatus '{"names":["migrations:<name>"]}'
```

1. Count. `backlog` is what the migration will close; `cronWillClose` is what the cron closes on its next run.

   ```sh
   npx convex run --env-file .env.vercel.production slack/staleExpiry:previewStaleSlackOpportunities
   ```

2. Dry run, which runs one batch and rolls it back, then the real run. Wait for `isDone: true`.

   ```sh
   npx convex run --env-file .env.vercel.production migrations:run '{"fn":"migrations:expireStaleSlackBacklog","dryRun":true}'
   npx convex run --env-file .env.vercel.production migrations:run '{"fn":"migrations:expireStaleSlackBacklog"}'
   ```

3. Assert. It fails on the first backlog opportunity still pending. To run it again later, add `"reset":true`, or the finished migration is skipped.

   ```sh
   npx convex run --env-file .env.vercel.production migrations:run '{"fn":"migrations:assertStaleSlackBacklogExpired"}'
   ```

   Then run step 1 again: `backlog` should be 0.

## Undo

There is no automatic undo. Each closed opportunity has `lostReason: "stale"` and an `opportunity.marked_lost` domain event with `metadata.trigger: "slack_join_window_expired"`, so they can be found and reopened by a one-off migration if needed.
