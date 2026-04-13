# v0.5b — implementation gaps

This note tracks **mismatches between planned v0.5b data flows and what the codebase does today**. It is meant for prioritization and handoff, not as a product spec.

---

## 1. Booking form facts: `eventTypeFieldCatalog` and `meetingFormResponses`

### Intended behavior (v0.5b)

- **`meetingFormResponses`**: normalized rows for each booking-form question/answer on a meeting, with provenance (tenant, meeting, opportunity, lead, event type).
- **`eventTypeFieldCatalog`**: stable dimension per Calendly event type — one logical field per `(tenantId, eventTypeConfigId, fieldKey)`, with `currentLabel`, `firstSeenAt`, `lastSeenAt` (and optional typing later).

Plans describe **upserting the catalog whenever `questions_and_answers` is processed** from an `invitee.created` webhook payload — in the same pass as inserting or updating `meetingFormResponses`. That keeps downstream analytics aligned with live bookings without relying on a separate backfill for new traffic.

### Actual behavior (repository state)

| Area | Status |
| ---- | ------ |
| **Schema** | Both tables exist in `convex/schema.ts` with indexes as designed. |
| **Live pipeline** | `convex/pipeline/` does **not** reference `meetingFormResponses` or `eventTypeFieldCatalog`. New webhooks do **not** populate these tables on the normal ingest path. |
| **Writers today** | **`convex/admin/migrations.ts` only**: `backfillMeetingFormResponsesForRawEvent` parses retained `rawWebhookEvents` (`invitee.created`), resolves meeting + `eventTypeConfigId`, runs `extractQuestionsAndAnswers`, then calls `upsertFieldCatalogEntry` and inserts/patches `meetingFormResponses`. Duplicate `eventTypeConfigs` merge logic also moves/merges catalog rows onto a canonical config. |
| **Cleanup** | `convex/admin/tenantsMutations.ts` deletes tenant-scoped rows when purging a tenant. |

### Impact

- Any analytics or UI that depends on these tables will only reflect data **after an admin backfill** (or migration runs), not **continuously** as bookings arrive.
- Tenants that never ran the backfill can have **empty** catalog and response tables while meetings and leads still exist — consumers will see “missing data” even though webhooks were processed elsewhere in the pipeline.

### Resolution options (for planning)

1. **Dual-write in pipeline** — When handling `invitee.created` (or the single code path that already has payload + meeting + opportunity), reuse the same extraction and upsert logic as `backfillMeetingFormResponsesForRawEvent` (ideally shared helpers to avoid drift).
2. **Scheduled internal job** — Periodically process new `rawWebhookEvents` or “unbackfilled” meetings; higher latency, simpler than touching the hot webhook path.
3. **Document as intentional** — If the product decision is “analytics only from historical migration,” state that explicitly in UI and docs so it is not mistaken for a bug.

### Code references

- Catalog upsert: `upsertFieldCatalogEntry` in `convex/admin/migrations.ts`.
- Per-raw-event backfill: `backfillMeetingFormResponsesForRawEvent` in the same file.
- Schema: `meetingFormResponses`, `eventTypeFieldCatalog` in `convex/schema.ts`.

---

## 2. How to extend this document

Add sections for other v0.5b gaps with the same shape: **intended → actual → impact → options**.
