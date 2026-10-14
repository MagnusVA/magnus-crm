# Repair data after the transitionOpportunity rollout

Status: not run on production yet.

## Why

Before `transitionOpportunity`, two kinds of status change left data behind:

- Closer, admin and side-deal outcomes never rebuilt `operationsQualificationRows`, and logging a payment rebuilt them before the status changed. A qualification row can still show the status and closer from booking time, so the qualifications queue filters on stale values.
- Cancelling a meeting from unavailability redistribution changed the opportunity's status without updating `tenantStats`. `activeOpportunities` is too high by one for each such cancel.

The new code keeps both correct from now on. These steps repair what is already wrong. Neither touches opportunities, meetings, leads or payments.

## Steps

All commands target production through `--env-file .env.vercel.production`, because `.env.local` holds a dev deploy key. The live tenant is `k57dqjfyf8qqy31bq375ng8gb984b24q`. Step 1 only reads. The other steps go through the migrations component, which records its own progress even for an assert, and steps 3 and 5 change data, so run them only with the owner's approval.

`migrations:run` only starts the batches, so its output proves nothing. After each one, re-run `getStatus` until it reports `isDone: true`. If it reports `state: "failed"`, its `error` names the row that failed.

```sh
npx convex run --env-file .env.vercel.production --component migrations lib:getStatus '{"names":["migrations:<name>"]}'
```

1. Check the status counters. `match: false` means drift; the response shows the stored and recounted values.

   ```sh
   npx convex run --env-file .env.vercel.production reporting/verification:verifyTenantStatusCounters '{"tenantId":"k57dqjfyf8qqy31bq375ng8gb984b24q"}'
   ```

2. Check the qualification rows. The assert fails on the first stale row with "has a stale qualification row". Changes no application data.

   ```sh
   npx convex run --env-file .env.vercel.production migrations:run '{"fn":"migrations:assertQualificationRowsCurrent"}'
   ```

3. Rebuild the qualification rows: a dry run first, which runs one batch and rolls it back, then the real run. Wait for `isDone: true`.

   ```sh
   npx convex run --env-file .env.vercel.production migrations:run '{"fn":"migrations:rebuildQualificationRows","dryRun":true}'
   npx convex run --env-file .env.vercel.production migrations:run '{"fn":"migrations:rebuildQualificationRows"}'
   ```

4. Assert again. A finished migration is skipped unless it is reset, so pass `reset: true`.

   ```sh
   npx convex run --env-file .env.vercel.production migrations:run '{"fn":"migrations:assertQualificationRowsCurrent","reset":true}'
   ```

5. If step 1 found drift, reset the three status counters from the status aggregate, then repeat step 1. It returns the values before and after.

   ```sh
   npx convex run --env-file .env.vercel.production admin/migrations:repairTenantStatusCounters '{"tenantId":"k57dqjfyf8qqy31bq375ng8gb984b24q"}'
   ```

## Undo

The qualification rows are a projection, rebuilt from the Slack events and opportunities, so there is nothing to undo. The counter repair sets the counters to a recount, which is correct by definition. Don't patch back the `before` values step 5 returns: every status change since the repair has moved the counters, and the old values would overwrite those changes. If the counters look wrong later, run step 1 and, if it reports drift, step 5 again.
