# Convex Database Design And Audit

Skill guide for designing and auditing Convex data models with strong relational discipline, predictable performance, and migration-safe evolution.

## When to use this skill

Use this workflow when:

- **New Convex project** - Designing a schema for a greenfield app
- **Schema audit** - Reviewing an existing Convex codebase for data-model quality
- **Relationship design** - Modeling 1:1, 1:N, and N:M relationships with `Id` references
- **Performance issues** - Fixing slow reads, full-table scans, or index mismatches
- **Integrity review** - Checking atomicity, ownership, referential integrity, and lifecycle rules
- **Refactoring** - Splitting oversized documents, extracting child tables, or adding denormalized read models
- **Migration planning** - Preparing safe schema or data changes for existing deployments

## Core principle

Convex is a document database, but the best production schemas still follow relational thinking:

- Keep a clear source of truth for each domain concept
- Use `Id` references and junction tables for real relationships
- Keep documents bounded in size and churn
- Denormalize only when a concrete read path benefits
- Design indexes from actual query patterns, not guesses
- Enforce integrity in mutations and helpers, not with SQL-era assumptions about foreign keys, triggers, or implicit planners

## Read first

Before using this skill, review these local references:

1. `convex/_generated/ai/guidelines.md`
2. `.docs/convex/best-practices.md`
3. `.docs/convex/database/schemas.md`
4. `.docs/convex/database/document-id.md`
5. `.docs/convex/database/reading-data.md`
6. `.docs/convex/database/indexes.md`
7. `.docs/convex/database/indexes-and-query-performance.md`
8. `.docs/convex/database/paginated-queries.md`

If the audit recommends breaking schema or data changes, switch to the `convex-migration-helper` skill before implementing them.

## Input format

Collect the following before designing or auditing.

### Required information

| Field | Description |
| --- | --- |
| **Domain description** | What the app stores and what the main workflows are |
| **Core entities** | Main business objects and their lifecycles |
| **Critical read paths** | Lists, detail pages, dashboards, counters, feeds, search, etc. |
| **Critical write paths** | Create, update, assignment, status changes, deletion, imports, sync jobs |
| **Tenant and auth model** | Single-tenant or multi-tenant, and how access is derived |
| **Existing schema/functions** | `schema.ts`, Convex functions, and any known hotspots |

### Optional information

| Field | Default | Description |
| --- | --- | --- |
| **Expected scale** | Medium | Rough table sizes and growth expectations |
| **Read/write ratio** | Balanced | Whether the workload is read-heavy, write-heavy, or mixed |
| **High-churn fields** | None | Presence, heartbeats, cursors, counters, status pings, etc. |
| **Current issues** | None | Slow queries, conflicts, missing indexes, oversized docs, deploy failures |
| **Migration constraints** | Existing data must be preserved | Whether production data already exists |

### Input example

```text
Audit this Convex CRM backend:
- Entities: tenants, users, leads, opportunities, meetings, payments
- Multi-tenant app; every record belongs to a tenant
- Hot reads:
  - pipeline by tenant + status
  - closer dashboard counts
  - meeting detail with payment state
- Hot writes:
  - Calendly webhook ingestion
  - opportunity status transitions
  - payment recording
- Existing production tenant with real data
```

## Relational concepts translated to Convex

| Relational idea | Convex pattern |
| --- | --- |
| **Primary key** | Built-in `_id` |
| **Foreign key** | `v.id("table")` field plus mutation-level existence and ownership checks |
| **1:1** | Reference from one side to the other; keep one side optional if creation order requires it |
| **1:N** | Child table with `parentId` and an index starting with that field |
| **N:M** | Junction table with both references and indexes for both access directions |
| **Normalization** | Separate canonical tables for independent entities |
| **Denormalization** | Copy only the specific summary fields needed for a hot read path |
| **Unique constraint** | Enforce in a mutation using indexed lookup and a single controlled write path |
| **Cascade delete** | Explicit cleanup logic in mutations or scheduled batches |

## Instructions

Follow these steps in order.

### Step 1: Inventory the current model and workload

Start from the real codebase, not from desired architecture.

**Tasks**

- Read `convex/schema.ts` first if it exists
- List every table, its fields, and its indexes
- Map each table to its owners, readers, writers, and lifecycle
- Trace the most important queries, mutations, actions, and scheduled jobs
- Identify which queries are reactive lists, which are point reads, and which are summary reads

**Audit questions**

- Is each table a real domain concept, or is it a dump of unrelated fields?
- Which documents are canonical source of truth, and which are derived read models?
- Are there tables or fields that exist only because the frontend shape leaked into the backend?

### Step 2: Define document boundaries and relationships

Convex supports nested objects and arrays, but production designs should keep documents bounded and relationally clear.

**Tasks**

- Give each long-lived entity its own table
- Keep nested objects for bounded value objects, not growing collections
- Use `Id` references for cross-entity relationships
- Model 1:N as child tables, not as unbounded arrays on the parent
- Model N:M with explicit junction tables
- Keep high-churn data separate from stable profile or summary data

**Rules**

- Prefer normalization by default for source-of-truth data
- For most operational source-of-truth data, aim for roughly 3NF before adding read-oriented denormalization
- Denormalize only for a concrete read path such as counters, last activity, latest child reference, or dashboard summaries
- Keep arrays small and bounded; if growth is unbounded, use another table
- Avoid deeply nested objects when the nested data has an independent lifecycle or query pattern
- If two tables need circular references, make at least one side optional so the data can be created incrementally

**Normalization levels in Convex**

- **1NF**: Keep fields atomic enough for the app's access patterns, and eliminate repeating groups. In Convex this usually means no unbounded child arrays or embedded collections that should really be their own table.
- **2NF**: Make non-key fields depend on the whole entity or relationship, not only part of it. In Convex this matters most for junction tables: fields like `role`, `joinedAt`, or `status` belong on the relationship record, while user-only facts stay on `users`.
- **3NF**: Store each non-key fact on the entity it actually describes, and avoid duplicating facts across tables unless the duplication is an intentional denormalization for a measured read path.

**Audit heuristics**

- If a document contains a growing list of same-type children, it likely violates 1NF for a scalable Convex design
- If a junction table stores attributes that only describe one side of the relationship, it likely violates 2NF
- If the same business fact is copied into multiple tables without a clearly owned source of truth, it likely violates 3NF unless it is an explicitly maintained read model

**Convex relationship guidance**

- **1:1**: Store the reference on the side that owns the lifecycle; if both sides must link, one side is usually optional
- **1:N**: Put the parent `Id` on the many side and index it
- **N:M**: Create a junction table like `projectMembers`, `postTags`, or `opportunityClosers`

### Step 3: Design the schema around invariants

A Convex schema is not just for typing. It is the runtime contract for stored documents.

**Tasks**

- Define every production table in `schema.ts`
- Use precise validators with `v.string()`, `v.number()`, `v.id("table")`, `v.object()`, `v.union()`, and `v.literal()`
- Use unions and literals for states and status machines
- Use `v.optional(...)` only where the field can truly be absent during normal operation or a migration window
- Prefer explicit tables and typed references over `v.any()` or catch-all blobs

**Audit questions**

- Are status fields modeled as unions/literals, or as loose strings?
- Are important references typed with `v.id("table")`?
- Are deprecated or transitional fields clearly marked as optional because of a migration?
- Are there fields whose shape is ambiguous enough that they should be split into explicit typed structures?

**Integrity guidance**

- Treat `v.id("table")` as a typed reference, not as a fully enforced foreign key
- If a referenced document must exist, verify it inside the mutation that writes the reference
- If a delete would orphan children, decide explicitly whether to block, clean up, or soft-delete
- If a business key must be unique, enforce it in a single mutation using an indexed lookup before write

### Step 4: Design indexes from actual queries

In Convex, index design is part of API design. The database does not choose indexes for you.

**Tasks**

- List every important query shape before adding indexes
- Add indexes that match the equality prefix and ordering of real reads
- Reuse compound indexes where a prefix already serves a simpler query
- Keep index count lean to reduce write overhead
- Use staged indexes for large existing tables when backfill risk matters

**Rules**

- Use `withIndex(...)` for hot or growing queries
- Index order matters; fields must be queried in index order
- A compound index can often replace a redundant single-field prefix index
- `withIndex` without a range expression should end in `first`, `unique`, `take`, or `paginate`
- Do not use `withIndex(...).collect()` over the full index unless the table is known to stay small

**Audit questions**

- Does each hot query have a matching index?
- Are there redundant indexes where one is only a prefix of another?
- Are any queries using `.filter()` where an index should exist instead?
- Are indexes ordered for the actual access pattern, including sort direction and range predicates?

**Convex limits to remember**

- Up to 16 fields per index
- Up to 32 indexes per table
- `_creationTime` is automatically appended to indexes

### Step 5: Audit read paths for scale and reactivity

Convex queries are reactive, so inefficient read shapes cost both bandwidth and invalidation.

**Tasks**

- Replace unbounded `.collect()` with `.take(n)` or `.paginate(...)` where growth is possible
- Replace `.filter()` on large queries with `withIndex(...)`
- Replace `.collect().length` counting with a maintained counter or summary record
- Review joins for repeated indexed lookups and decide whether the read should stay normalized or gain a denormalized summary
- Use `Promise.all` for bounded parallel reference fetches when joining in JavaScript

**Rules**

- `.collect()` is only acceptable when the result set is known to stay small
- User-facing lists should usually paginate
- Summary widgets should not scan full tables on every render
- If a dashboard or list repeatedly needs the same derived values, consider a denormalized digest document or summary table

**Common audit targets**

- Dashboard counters
- Recent activity feeds
- Detail pages loading multiple related tables
- Lists filtered by tenant, owner, status, or time
- Reactive views that rerun because they read too many documents

### Step 6: Audit write paths for atomicity and integrity

Convex mutations are the unit of transactional integrity. Use them to preserve invariants.

**Tasks**

- Keep related writes in the same mutation when they must succeed or fail together
- Move external I/O to actions; keep database invariants in mutations
- Await all database and scheduler calls
- Use `patch` for partial updates and `replace` only for full replacement
- Split oversized or high-conflict writes into smaller, safer data shapes when needed

**Rules**

- Do not split one logical database transaction across multiple sequential `ctx.runMutation` calls from an action unless eventual consistency is acceptable
- Do not rely on actions for database atomicity; actions do not have `ctx.db`
- Separate high-churn data from stable documents to reduce contention and invalidation
- For bulk jobs beyond transaction limits, batch with bounded reads and reschedule continuation work

**Integrity checks**

- Ownership and tenant checks happen server-side
- Required related records are loaded and validated before writing references
- State transitions are validated explicitly
- Deletions define child cleanup behavior
- Denormalized fields are updated in the same write path as their source-of-truth change

### Step 7: Audit public API safety

Database design is incomplete if the public function surface lets callers bypass the model.

**Tasks**

- Ensure all public queries, mutations, and actions have argument validators
- Ensure access control is applied to all public functions
- Derive identity from `ctx.auth.getUserIdentity()` or a trusted helper
- Use internal functions for `ctx.run*`, scheduled jobs, and cron entrypoints
- Validate externally supplied IDs with `v.id("table")` or `ctx.db.normalizeId`

**Rules**

- Never accept `userId`, `role`, or `tenantId` from the client for authorization decisions
- Never assume a client-only permission check protects the backend
- Keep sensitive internal workflows behind `internalQuery`, `internalMutation`, or `internalAction`

### Step 8: Plan schema evolution and migrations

Convex schema validation means breaking changes need rollout planning, not wishful thinking.

**Tasks**

- Check whether the project already has data in deployed environments
- Classify the change as safe or breaking
- For breaking changes, use a widen-migrate-narrow rollout
- For large index additions, consider staged indexes
- Keep read logic compatible with both old and new shapes during the migration window

**Breaking changes that usually need migration**

- Adding a new required field to existing documents
- Changing a field's type
- Splitting one document into multiple tables
- Merging tables
- Deleting or renaming fields that existing documents still use

**Rule**

- If the audit recommends one of the above, stop implementation work and use the `convex-migration-helper` skill

## Output format

When using this skill for an audit, produce a report with these sections.

### 1. Domain and data model summary

- Main entities and what each table is responsible for
- Normalized source-of-truth tables
- Existing denormalized fields or summary tables

### 2. Findings

For each finding, include:

- Severity
- Affected table or function
- Why it matters
- Recommended fix
- Whether a migration is required

### 3. Query and index matrix

List:

- Query shape
- Current index used
- Expected scale
- Risk level
- Recommended index or query rewrite

### 4. Integrity and atomicity review

Cover:

- Ownership and tenant boundaries
- Reference validation and orphan risk
- Write atomicity
- Denormalized-field maintenance

### 5. Migration notes

Call out:

- Safe changes that can ship directly
- Breaking changes that need widen-migrate-narrow
- Index additions that may need staged rollout

### 6. Remediation plan

Group fixes into:

- **Immediate** - correctness or security risks
- **Next** - performance and maintainability issues
- **Later** - structural improvements justified only as the app grows

## Constraints and rules

### Mandatory (MUST)

| Rule | Rationale |
| --- | --- |
| **Model independent entities as separate tables** | Keeps source of truth clear and documents bounded |
| **Use `v.id("table")` for cross-table references** | Makes relationships explicit and typed |
| **Index hot query paths** | Prevents full-table scans as data grows |
| **Bound list reads with `take` or `paginate` when growth is possible** | Avoids unbounded bandwidth and invalidation |
| **Validate all public function args** | Prevents malformed or malicious input |
| **Derive auth and tenancy server-side** | Preserves access control integrity |
| **Keep related invariant-preserving writes in one mutation** | Preserves atomicity |
| **Plan migrations for breaking schema changes** | Convex validates existing data against the schema |

### Recommended (SHOULD)

| Rule | Why |
| --- | --- |
| **Normalize first, denormalize second** | Prevents accidental duplication and drift |
| **Store high-churn fields separately** | Reduces conflicts and unnecessary reactivity |
| **Use unions/literals for statuses** | Makes invalid states harder to represent |
| **Use junction tables for true N:M relationships** | Keeps relationships queryable and bounded |
| **Audit sibling readers and writers together** | Avoids fixing one path while leaving the same issue elsewhere |

### Prohibited (MUST NOT)

| Anti-pattern | Why |
| --- | --- |
| **Unbounded arrays inside documents** | Risks document-size blowups and full-document rewrites |
| **Deeply nested independent entities** | Hides relationships and blocks efficient queries |
| **`.collect()` on growing tables by default** | Creates unbounded reads and reactive churn |
| **`.collect().length` for counts** | Does not scale |
| **`.filter()` as the main filter on large tables** | Becomes a table scan |
| **Passing auth-critical IDs from the client** | Breaks access control |
| **Assuming `.unique()` enforces uniqueness at write time** | It only asserts the read result |
| **Breaking schema changes without a migration plan** | Deploys will fail or data will drift |

## Example Convex schema

```ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  tenants: defineTable({
    name: v.string(),
    slug: v.string(),
  }).index("by_slug", ["slug"]),

  users: defineTable({
    tenantId: v.id("tenants"),
    email: v.string(),
    name: v.string(),
    role: v.union(
      v.literal("tenant_master"),
      v.literal("tenant_admin"),
      v.literal("closer"),
    ),
  })
    .index("by_tenantId_and_email", ["tenantId", "email"])
    .index("by_tenantId_and_role", ["tenantId", "role"]),

  opportunities: defineTable({
    tenantId: v.id("tenants"),
    ownerId: v.id("users"),
    leadName: v.string(),
    status: v.union(
      v.literal("new"),
      v.literal("contacted"),
      v.literal("qualified"),
      v.literal("won"),
      v.literal("lost"),
    ),
    latestMeetingId: v.optional(v.id("meetings")),
    latestMeetingAt: v.optional(v.number()),
  })
    .index("by_tenantId_and_status", ["tenantId", "status"])
    .index("by_tenantId_and_ownerId", ["tenantId", "ownerId"]),

  meetings: defineTable({
    tenantId: v.id("tenants"),
    opportunityId: v.id("opportunities"),
    closerId: v.id("users"),
    scheduledAt: v.number(),
    status: v.union(
      v.literal("scheduled"),
      v.literal("completed"),
      v.literal("no_show"),
      v.literal("canceled"),
    ),
  })
    .index("by_opportunityId_and_scheduledAt", ["opportunityId", "scheduledAt"])
    .index("by_closerId_and_scheduledAt", ["closerId", "scheduledAt"]),

  opportunityTags: defineTable({
    opportunityId: v.id("opportunities"),
    tag: v.string(),
  })
    .index("by_opportunityId_and_tag", ["opportunityId", "tag"])
    .index("by_tag_and_opportunityId", ["tag", "opportunityId"]),
});
```

**Design notes**

- `opportunities` is the canonical sales entity
- `meetings` is a child table instead of an array on `opportunities`
- `latestMeetingId` and `latestMeetingAt` are intentional denormalizations for hot reads
- `opportunityTags` is modeled as its own table to keep the relationship queryable and bounded
- Multi-tenant isolation starts every important index with `tenantId` where the read pattern depends on tenant scope

## Common issues to catch in reviews

### Issue 1: Hidden one-to-many inside arrays

- **Symptom**: A parent document stores hundreds of children in an array
- **Risk**: Large document rewrites, weak queryability, hard pagination
- **Fix**: Move children to their own table with `parentId` and an index

### Issue 2: Hot list query uses `.filter()` or broad `.collect()`

- **Symptom**: List views slow down as tables grow
- **Risk**: Full-table scans, excess bandwidth, reactive churn
- **Fix**: Add a matching index and replace `.collect()` with `.take()` or `.paginate()`

### Issue 3: Business uniqueness is assumed but not enforced

- **Symptom**: Code assumes one user per email or one membership per pair
- **Risk**: Duplicate logical records
- **Fix**: Route writes through one mutation, read through an index, and reject duplicates before insert

### Issue 4: Denormalized fields drift from source of truth

- **Symptom**: `latestMeetingAt`, counters, or summaries become stale
- **Risk**: Incorrect UI and reporting
- **Fix**: Update denormalized fields in the same mutation as the source change

### Issue 5: High-churn data lives on a stable shared document

- **Symptom**: Presence, cursors, or status pings update a profile or room document
- **Risk**: Conflicts and unnecessary invalidation
- **Fix**: Split high-churn data into a dedicated table

### Issue 6: Breaking schema change proposed as a single deploy

- **Symptom**: A required field or type change is added directly to `schema.ts`
- **Risk**: Deployment failure or inconsistent data handling
- **Fix**: Use widen-migrate-narrow via `convex-migration-helper`

## Audit checklist

- [ ] Read the local Convex guidelines and docs first
- [ ] Inventory every table, index, and major function path
- [ ] Confirm document boundaries are bounded and intentional
- [ ] Confirm relationships use explicit `Id` references or junction tables
- [ ] Check that important invariants are enforced in mutations
- [ ] Check that public functions validate arguments and auth
- [ ] Check that hot reads use `withIndex`, `take`, or `paginate`
- [ ] Check for `.filter`, broad `.collect`, and `.collect().length`
- [ ] Check for redundant or missing indexes
- [ ] Check for denormalized fields and whether their write paths maintain them
- [ ] Check for high-churn fields mixed into stable documents
- [ ] Identify any changes that require migration planning

## References

- `convex/_generated/ai/guidelines.md`
- `.docs/convex/best-practices.md`
- `.docs/convex/database/schemas.md`
- `.docs/convex/database/document-id.md`
- `.docs/convex/database/reading-data.md`
- `.docs/convex/database/indexes.md`
- `.docs/convex/database/indexes-and-query-performance.md`
- `.docs/convex/database/paginated-queries.md`
- `.agents/skills/convex-performance-audit/SKILL.md`
- `.agents/skills/convex-migration-helper/SKILL.md`
