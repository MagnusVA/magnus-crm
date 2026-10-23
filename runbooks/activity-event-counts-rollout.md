# Activity event counts rollout

Deploying this change mounts an empty `activityEventCounts` component. The summary keeps its existing scan until `tenants.activityEventCountsVerifiedAt` is set. New events immediately write their aggregate entries in the same transaction. Deletions remove the entries, including when an event has not been backfilled yet.

The schema change adds optional tenant fields only. There is no source-data rewrite. Run the backfill and asserts on dev first, then repeat against production in the Phase 6 run 7 order. These are operator commands; the implementation worker must not execute them.

## Backfill and assert

Use `migrations:run`, which provides resumable status and processes 200 domain events per batch. Every entry uses `insertIfDoesNotExist`, so restarting is safe. Run these commands in a Bash driver with `set -euo pipefail`. For production, add `--env-file .env.vercel.production` immediately after `convex run` in every command, as required by the Phase 6 plan.

```bash
#!/bin/bash
set -euo pipefail
npx convex run migrations:run '{"fn":"migrations:backfillActivityEventCounts","dryRun":true}' 2>&1 | rg '"processed"|DRY RUN|DryRun|error'
npx convex run migrations:run '{"fn":"migrations:backfillActivityEventCounts"}'
npx convex run --component migrations lib:getStatus '{"names":["migrations:backfillActivityEventCounts"]}'
```

The dry run rolls back component inserts too. It may report no source-document changes because the migration only changes the aggregate and the tenant's extra-value catalog. Stop on any error. Repeat the status command every 30 seconds until `isDone` is true, and inspect its error field before continuing.

```bash
npx convex run migrations:run '{"fn":"migrations:assertActivityEventCounts","dryRun":true}' 2>&1 | rg '"processed"|DRY RUN|DryRun|error'
npx convex run migrations:run '{"fn":"migrations:assertActivityEventCounts"}'
npx convex run --component migrations lib:getStatus '{"names":["migrations:assertActivityEventCounts"]}'
```

Wait for this assert to finish without errors. It checks each expected dimension's exact event-derived ID, not just totals, and reports only the failing event ID. Add `"reset":true` when rerunning a completed migration or assert from the beginning.

An alternative internal backfill is available, but use one backfill runner at a time:

```bash
npx convex run reporting/activityEventCounts:backfillActivityEventCounts '{}'
```

It self-schedules 200-row pages using `cursor`. Its returned `processed` count covers only the first batch. The migration runner is preferred because its status tracks completion.

## Verify 30 days and enable the reader

For each of the last 30 completed Honduras business days, run both functions with the same range:

```bash
npx convex run reporting/activityEventCounts:verifyActivityEventCounts '{"tenantId":"TENANT_ID","startDate":START_MS,"endDate":END_MS}'
npx convex run reporting/activityEventCounts:markActivityEventCountsVerified '{"tenantId":"TENANT_ID","startDate":START_MS,"endDate":END_MS}'
```

Replace the placeholders with the tenant ID and numeric epoch milliseconds. Ranges use `[startDate,endDate)` and boundaries at 01:00 America/Tegucigalpa, which is 07:00 UTC. Every calendar day has a business-day interval, including weekends. Verification rejects a range with 10,000 or more events. At the current daily volume, check one day per call.

`verifyActivityEventCounts` returns IDs, dimension/value counts, and differences. It compares the full source range with aggregate counts, including individual deleted actor IDs. Require `passed: true`, not merely an empty differences array.

`markActivityEventCountsVerified` re-runs that check transactionally. It accepts no caller-supplied success result. Each successful call records one day; only the 30th distinct day sets the flag. A failed check clears the flag and progress. Repeating a day cannot advance the count. Finish all 30 within the same Honduras business day; crossing the boundary resets progress to the newly applicable 30-day window.

This driver calculates the 30 intervals and stops on the first failed check. Supply the tenant ID as its first argument. For production, add `--env-file .env.vercel.production` to the Python `command` list after `"run"`.

```bash
#!/bin/bash
set -euo pipefail
python3 - "$1" <<'PY'
import json
import subprocess
import sys
import time

tenant_id = sys.argv[1]
day = 86_400_000
offset = 7 * 3_600_000
boundary = ((int(time.time() * 1000) - offset) // day) * day + offset
command = ["npx", "convex", "run"]
last_mark = None
for days_ago in range(30, 0, -1):
    args = json.dumps({
        "tenantId": tenant_id,
        "startDate": boundary - days_ago * day,
        "endDate": boundary - (days_ago - 1) * day,
    })
    for name in ["verifyActivityEventCounts", "markActivityEventCountsVerified"]:
        output = subprocess.check_output(
            command + ["reporting/activityEventCounts:" + name, args], text=True
        )
        result = json.loads(output)
        print(json.dumps(result), flush=True)
        if not result["passed"]:
            raise SystemExit("Activity parity failed; stop run 7")
        if name == "markActivityEventCountsVerified":
            last_mark = result
if last_mark is None or not last_mark["enabled"] or last_mark["verifiedDays"] != 30:
    raise SystemExit("Activity reader was not enabled")
PY
```

After the final `enabled: true`, independently query the authenticated activity summary over a range larger than 10,000 events. Confirm `isTruncated: false`, and that the feed can load older events through its returned cursor.

## Semantics and limits

- The summary uses a single `countBatch`. DirectAggregate writes use `insertIfDoesNotExist`; deletes use `deleteIfExists`. Exact-entry assertions also use `countBatch` with identical inclusive key/ID bounds.
- Reminder buckets retain the old literal `reminder_` prefix, even when metadata already begins with that prefix. Malformed or null metadata contributes no reminder bucket.
- Event types and reminder metadata are free strings in the source schema. Backfill and live writes preserve values outside the code catalogs in a bounded tenant catalog. More than 128 extra dimension/value pairs clears the flag and keeps the old scan. Parity returns `passed: false` on overflow even if its differences array is empty. Expanding this bound or repairing unexpected values requires a reviewed change.
- Actors come from at most 500 tenant users. Events without an actor are counted separately and excluded from the actor breakdown, as before. `Removed user` is total minus no-actor minus those known users. Users beyond that bound join the removed-user remainder. The synthetic group cannot be selected as a user-ID feed filter.
- Feed pages return at most 50 matches after reading at most 500 source events. A filtered page may be empty with `isDone: false`; continue with its cursor. The client appends pages and resets them when dates or filters change.
- Before cutover, the existing summary scan and truncation warning remain. After cutover, `isTruncated` remains in the API and is always false. Removing the legacy scan and field belongs to the later narrow PR.

On any failed assert or parity result, stop the rollout. Leave the scan active and fix forward through review. Do not set the flag manually.
