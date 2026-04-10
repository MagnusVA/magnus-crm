Heavy data aggregation across many records in Convex is a scenario that hits the boundaries of what Convex is designed for. Here's a breakdown of your options, from most to least recommended:

---

## 1. Stream to an OLAP Database (Recommended for True Reporting)

Convex is an **OLTP** database optimized for fast, indexed, transactional queries — not large analytical scans. For heavy reporting across hundreds of thousands of records, the official recommendation is to export your data to a dedicated analytics platform. [[streaming integrations](https://docs.convex.dev/production/integrations/streaming-import-export)]

> "If you need very dynamic sorting and filtering for something like an 'advanced search' view, databases like ElasticSearch can be helpful."

Use **Fivetran** or **Airbyte** to stream your Convex tables to a warehouse like **Snowflake**, **BigQuery**, or **Databricks**, then run your complex reports there. [[Fivetran integration](https://stack.convex.dev/fivetran-alpha)]

---

## 2. Use the Aggregate Component (For Pre-computed Summaries)

If you need counts, sums, min/max, or rankings that need to be served reactively (e.g., dashboard widgets), the **Aggregate component** stores a B-tree structure that gives you `O(log n)` lookups instead of scanning every row. [[aggregate component](https://www.convex.dev/components/aggregate)]

```ts
npm install @convex-dev/aggregate
```

It supports:
- `aggregate.count(ctx)` — total count
- `aggregate.sum(ctx)` — sum of values
- `aggregate.max(ctx)` — max value
- Namespacing for partitioned data (e.g., per-user, per-game)
- Offset-based pagination

You define it once and keep it in sync with your table mutations (ideally via [Triggers](https://stack.convex.dev/triggers)).

---

## 3. Use Workflows for Batch Processing (For Infrequent Heavy Computation)

If your aggregation is a periodic job (e.g., weekly reports), use the **Workflow component** to process data in paginated batches without hitting timeout or document limits. [[workflow component](https://www.convex.dev/components/workflow)]

A community member processing ~1–2M rows described the pattern:

> "The different workflows have a small input object to denote what to process, that then runs the heavy workload with just JS functions, and the 'small' aggregate object is then returned to avoid the data limits." [[Discord thread](https://discord.com/channels/1019350475847499849/1430635266808348904)]

Key rules for this approach:
- Use `.paginate()` inside your action/mutation steps to avoid the 16MB document read limit
- Return only small aggregate objects from steps, not raw data
- Avoid returning large objects from actions

---

## 4. Ad-hoc Export + DuckDB (For One-off Analysis)

For one-time reports, export your data and query it locally:

```bash
npx convex export --prod --path ./snapshot.zip
unzip ./snapshot.zip && cd snapshot
duckdb
```

Then run SQL joins across your exported `.jsonl` table files. [[data export](https://stack.convex.dev/observability-in-production#persist-important-events-to-tables)]

---

## Summary

| Scenario | Recommended Approach |
|---|---|
| Live dashboard metrics | Aggregate component |
| Periodic bulk reports | Workflow + paginated batches |
| Complex multi-table analytics | Stream to Snowflake/BigQuery via Fivetran |
| One-off investigation | Export + DuckDB |

The core takeaway: **Convex is not optimized for large analytical scans**, and trying to do heavy aggregation directly will run into document read limits and timeouts. Design your system to either pre-compute aggregates or offload analytics to a purpose-built tool.








For ad-hoc CRM-style reports generated periodically, the best approaches based on the knowledge sources are:

## 1. Export + DuckDB (Best for Ad-hoc SQL-style Reports)

Since these are infrequent, one-off reports, exporting your data and querying it locally with DuckDB is a great fit. You get full SQL capabilities including joins across tables:

```bash
npx convex export --prod --path ./snapshot.zip
unzip ./snapshot.zip && cd snapshot
duckdb
```

Then run SQL joins across your exported `.jsonl` table files:

```sql
SELECT someField, otherField FROM 'contacts/documents.jsonl' AS contacts
JOIN 'deals/documents.jsonl' AS deals
ON contacts._id = deals.contactId
LIMIT 100;
```

[[data export](https://stack.convex.dev/observability-in-production#persist-important-events-to-tables)]

## 2. Workflow + Paginated Batches (For Scheduled/Triggered Reports)

If you want reports generated inside Convex and stored back to a table, use the **Workflow component** with paginated queries to avoid hitting document read limits and timeouts. A community member processing 1–2M rows described the key pattern:

- Use `.paginate()` to read data in chunks
- Do processing in plain JS/TS functions
- Return only the small aggregate/report object, not raw data
- Store the result in a Convex table for later retrieval

[[Discord thread](https://discord.com/channels/1019350475847499849/1430635266808348904)]

## 3. Stream to BigQuery/Snowflake (If Reports Become Frequent)

If your reporting needs grow and you need more SQL power on a recurring basis, streaming your Convex tables to an analytics database like BigQuery via Fivetran would give you a full OLAP environment for CRM-style reporting.

---

**For your use case specifically**, the **Export + DuckDB** approach is likely the simplest starting point — no extra infrastructure, full SQL joins, and works well for infrequent CRM reports. If you need the reports stored and served within your app, the **Workflow + pagination** pattern is the way to go.