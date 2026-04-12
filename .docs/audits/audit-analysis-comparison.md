# Database Audit Cross-Analysis: 5 Model Comparison

**Analysis Date**: 2026-04-12  
**Audits Analyzed**:
- database-audit-gpt1.md (GPT-1)
- database-audit-gpt3.md (GPT-3)
- database-gpt2.md (GPT-2)
- database-audit-opus2.md (Opus-2)
- database-opus1.md (Opus-1)

---

## Executive Summary

All 5 audits **reached consensus on the 5 most critical issues**. They diverge primarily on:
1. Emphasis and priority ordering
2. Recommended migration complexity (Opus models favored more granular fixes; GPT models took broader approaches)
3. Specific implementation patterns for event tables
4. Treatment of customer-data synchronization as a problem vs. accepted snapshot behavior

**Common Thread**: The schema is operationally solid but analytically weak. It optimizes for current-state reads, not historical facts.

---

## 1. Universal Consensus Findings (All 5 Audits Agree)

### F-A: No Durable Event/History Table for Business Facts
| Aspect | Finding |
|--------|---------|
| **Severity** | 🔴 High (all 5) |
| **Core Issue** | State changes (opportunity status, meeting outcome, payment status) overwrite in place; no immutable event log |
| **Consequence** | Cannot answer "what happened over time?", no audit trail, reporting requires inference from snapshots |
| **Recommended Fix** | Add append-only event table: `domainEvents`, `activityLog`, or `opportunityEvents` + friends |
| **Key Citations** | GPT-1 F-2, GPT-3 F-1, GPT-2 F-1, Opus-2 F-07, Opus-1 F-2.1 |

**Nuance**: No disagreement on **why** (critical for analytics), but different on **shape**:
- GPT-1/GPT-3: Recommend a unified `domainEvents` or similar with broad entity/event type discriminants
- GPT-2: Recommends `opportunityStatusEvents`, `meetingLifecycleEvents`, `paymentEvents`, etc. (specialized per domain)
- Opus-2: Detailed `activityLog` schema with typed metadata object
- Opus-1: Also proposes activity log with comprehensive action types

**Consensus recommendation**: Specialized event tables per domain are acceptable if taxonomy is clean; unified table is acceptable if discriminants are explicit and metadata is typed.

### F-B: `leads.customFields` Violates 1NF/Schema Safety (`v.any()`)
| Aspect | Finding |
|--------|---------|
| **Severity** | 🟡 High/Medium (varies by auditor) |
| **Core Issue** | Field is `v.any()` — untyped, unindexable, unbounded, loses per-meeting provenance |
| **Consequence** | Analytics cannot filter/count by question/answer; type-unsafe; schema not self-documenting |
| **Recommended Fix** | Path A: narrow to `v.record(v.string(), v.string())`; Path B: add separate normalized table for meeting-level answers |
| **Key Citations** | GPT-1 F-6, GPT-3 F-2, GPT-2 F-2, Opus-2 F-02, Opus-1 F-2.6 |

**Migration Strategy Alignment**:
- All 5 recommend widen-migrate-narrow approach
- Opus-2 and Opus-1 emphasize the retention window constraint: raw webhook payloads kept only 30 days, so backfill must happen quickly
- GPT-2 adds: if using normalized answer table, recommend fields: `tenantId`, `meetingId`, `eventTypeConfigId`, `fieldKey`, `valueRaw`, `valueNormalized`, `observedAt`

**No disagreement on this finding.**

### F-C: Dashboard Stats Queries Use Full Table Scans (`.collect()`)
| Aspect | Finding |
|--------|---------|
| **Severity** | 🔴 High (all 5) |
| **Core Issue** | `getAdminDashboardStats` scans `users`, `opportunities`, `paymentRecords` on every render; each change invalidates reactive query |
| **Consequence** | O(n) bandwidth per dashboard render; high invalidation churn; will not scale |
| **Recommended Fix** | Maintain summary document `tenantStats` (counters by status, totals, etc.); mutations atomically patch instead of rescanning |
| **Key Citations** | GPT-1 F-7, GPT-3 F-7, GPT-2 F-3, Opus-2 F-10, Opus-1 F-2.2 |

**Implementation Consensus**:
- Opus-2 provides detailed schema for `tenantStats`
- All 5 agree: one document per tenant, update atomically in same transaction as state changes
- No complexity here — straightforward optimization

### F-D: Closer Pipeline Queries Use Unbounded `.collect()` and Post-Filtering
| Aspect | Finding |
|--------|---------|
| **Severity** | 🔴 High (all 5) |
| **Core Issue** | Closer pipeline loads all opportunities for closer, filters by status in JS; no `by_tenantId_and_assignedCloserId_and_status` index |
| **Consequence** | O(closer_opps) per render; worsens as closer books more deals; pattern repeats in calendar and redistribution code |
| **Recommended Fix** | Add index `opportunities.by_tenantId_and_assignedCloserId_and_status`; optionally denormalize `assignedCloserId` onto `meetings` |
| **Key Citations** | GPT-1 F-4, GPT-3 F-4, GPT-2 F-4, Opus-2 F-11, Opus-1 F-2.3 |

**Disagreement on Scope**:
- GPT-1/GPT-3: Index only (`by_tenantId_and_assignedCloserId_and_status`)
- GPT-2: Index + denormalize closer onto meetings (more invasive but solves calendar/redistribution O(n×m) problem too)
- Opus-2: Index only, but notes potential for summary per-closer
- Opus-1: Index only with mention of denormalization as future

**Consensus path**: Add index immediately (safe); defer meeting denormalization to Phase 2 after impact is measured.

### F-E: Tenant Offboarding Leaves Orphaned Data
| Aspect | Finding |
|--------|---------|
| **Severity** | 🔴 High (all 5) |
| **Core Issue** | `deleteTenantRuntimeDataBatch` only deletes 3 tables (`rawWebhookEvents`, `calendlyOrgMembers`, `users`); leaves 11+ tables orphaned |
| **Consequence** | Orphaned leads, opportunities, meetings, payments contaminate future reporting; violates data lifecycle contract |
| **Recommended Fix** | Extend deletion batch to cover all tenant-scoped tables (14 total); use `.take(128)` pattern for each |
| **Key Citations** | GPT-1 F-1, GPT-3 F-3, GPT-2 F-9, Opus-2 F-21, Opus-1 F-2.1 (indirect, via "audit trail" discussion) |

**No disagreement. Code fix only (no schema migration).**

---

## 2. Strong Consensus (4 out of 5 Audits Agree)

### F-F: `tenants` Table Mixes Stable Identity with High-Churn OAuth State
| Aspect | Finding |
|--------|---------|
| **Severity** | 🟡 Medium/Low (Opus-2 High, others Medium/Low) |
| **Core Issue** | Calendly tokens refreshed every 90 min; each refresh invalidates all reactive queries on `tenants` |
| **Consequence** | 16 invalidations/day for queries that read tenant config; churn from semantically unchanged data |
| **Recommended Fix** | Extract `calendlyConnections` table with tenantId foreign key; `tenants` stays profile-only |
| **Key Citations** | GPT-3 F-6, GPT-2 F-6, Opus-2 F-01, Opus-1 F-2.14 |
| **Absent From** | GPT-1 (did not flag this) |

**Disagreement Level**: Low. Only GPT-1 missed this; all others agreed on severity and fix.

**Opus-2 Unique Addition**: Provided exact field list to extract (8+ OAuth fields).

### F-G: User Deletion Leaves Orphaned Foreign-Key References
| Aspect | Finding |
|--------|---------|
| **Severity** | 🔴 High (GPT-3, GPT-2, Opus-2) / 🟡 Medium (Opus-1) |
| **Core Issue** | `removeUser` hard-deletes `users` row but doesn't address foreign keys in `opportunities.assignedCloserId`, `paymentRecords.closerId`, etc. |
| **Consequence** | Broken audit trails, historical reports cannot attribute past actions to an actor, orphaned reference data |
| **Recommended Fix** | Soft-delete: add `users.deletedAt` and `users.isActive`; preserve for historical joins; block deactivation if user owns active work |
| **Key Citations** | GPT-3 F-3, GPT-2 (implicit in user lifecycle discussion), Opus-2 (integrity review), Opus-1 (finding 2.5) |
| **Absent From** | GPT-1 (did not explicitly flag) |

**Nuance**: Only 3 explicitly called this out; 1 more touched on it indirectly; 1 didn't address it.

### F-H: Missing Relationship Indexes Force Post-Filtering
| Aspect | Finding |
|--------|---------|
| **Severity** | 🔴 High (all) |
| **Examples** | `followUps.by_tenantId_and_leadId` (F-4 in GPT-1), `opportunities.by_tenantId_and_potentialDuplicateLeadId`, `rawWebhookEvents` duplicate detection, etc. |
| **Consequence** | Capped scans (`.take(200)` then filter); incomplete results; slow detail pages |
| **Recommended Fix** | Add specific missing indexes per query path |
| **Key Citations** | GPT-1 F-4, GPT-3 F-4/7, GPT-2 F-6, Opus-2 F-17/19, Opus-1 F-2.12/13/15 |

**Consensus**: All 5 identified missing indexes, though exact lists varied by audit scope and thoroughness.

---

## 3. Partial or Contested Findings

### C-1: `customers` Table Duplicates Lead Data (3NF Violation)
| Aspect | Finding |
|--------|---------|
| **Severity** | 🟡 Medium (all mention) |
| **Issue** | Snapshot of `leads.fullName`, `email`, `phone`, `socialHandles` at conversion; if lead is edited later, customer is stale |
| **Auditors Treating As Problem** | Opus-2 (F-03), Opus-1 (F-2.7), GPT-3 (mentioned), GPT-2 (implicit) |
| **Auditors Treating As Acceptable** | GPT-1 (snapshot pattern noted but not flagged as violation) |

**Disagreement Detail**:
- **Opus-2, Opus-1**: Treat as design decision but note it creates two conflicting sources; recommend either (A) remove duplicates and join at read time, or (B) add sync path when lead is edited
- **GPT-1**: Notes it as denormalization but doesn't treat it as urgent (treats it as intentional snapshot design, not a bug)
- **GPT-3, GPT-2**: Acknowledge it but less emphasis on urgency

**Consensus Resolution**: It's intentional snapshot behavior, but should be **documented** as such. If post-sale operations expand, consider canonical contact-info model.

### C-2: Denormalized Fields with Stale Maintenance (`meetings.leadName`, `opportunities.hostCalendly*`)
| Aspect | Finding |
|--------|---------|
| **Severity** | 🟢 Low (all) |
| **Issue** | Set at creation; never updated when source data changes (e.g., lead name corrected) |
| **Auditors Flagging** | Opus-2 (F-04, F-05), Opus-1 (F-2.8), GPT-1 (noted in denormalization review), GPT-3 (mentioned) |
| **Proposed Fixes** | (A) Add maintenance path, or (B) resolve at query time and remove field |

**No Real Disagreement**: All agree it's low priority but should be addressed eventually. Opus-2 rated it explicitly Low; others treated as minor gap.

### C-3: Payment Model Not Safe for Multi-Currency Analytics
| Aspect | Finding |
|--------|---------|
| **Severity** | 🔴 High (GPT-1, GPT-3, GPT-2) / Not Explicitly Mentioned (Opus-2, Opus-1) |
| **Issue** | `paymentRecords.amount` is float; `currency` is string; `adminStats` sums without currency awareness |
| **Auditors Flagging** | GPT-1 (F-3), GPT-3 (F-5), GPT-2 (F-5 implied via "polymorphic paymentRecords") |
| **Auditors Silent** | Opus-2 and Opus-1 (don't mention money safety) |

**Why the Silence?**: Opus-2/Opus-1 scoped themselves slightly differently (less focus on analytics-specific reporting) or assumed single-currency premise.

**Consensus Recommendation** (where provided):
- Replace `amount` (float) with `amountMinor` (int64) for financial safety
- Keep `currency` as constrained code (ISO 4217)
- Define reporting rule: single-currency-per-tenant or multi-currency with FX pipeline
- Add per-currency aggregates if multi-currency

### C-4: `paymentRecords` and `followUps` Are Too Polymorphic
| Aspect | Finding |
|--------|---------|
| **Severity** | 🟡 Medium (all) |
| **Issue** | Nullable foreign keys encode multiple business row types; schema doesn't enforce valid combinations |
| **Auditors Flagging** | GPT-2 (F-8 explicitly), GPT-3 (implicit), Opus-2 (F-09 for payments), Opus-1 (noted) |

**Specific Disagreement**:
- **GPT-2**: Recommends explicit discriminant fields (`contextType`) or split tables
- **Opus-2**: Focused on `paymentRecords.opportunityId` being optional; suggests either audit+tighten or separate `customerPayments` table
- **Opus-1**: Treats as secondary concern

**Consensus**: Valid issue, but varying urgency (High for GPT-2, Medium for Opus-2, Low for Opus-1).

---

## 4. Disagreements & Contradictions

### D-1: Should `meetings` Denormalize `assignedCloserId`?
| Audit | Position | Reasoning |
|-------|----------|-----------|
| **GPT-1** | No (index only) | Adding a denormalized field is invasive; compound index sufficient |
| **GPT-3** | Tentative yes (Option A provided) | Notes it would solve O(n×m) detail query problem; adds migration plan but marks as "later" |
| **GPT-2** | Strongly yes | Necessary to fix closer calendar, next-meeting, redistribution queries; worth the migration |
| **Opus-2** | Optional A (yes) or B (index only) | "Option A" is denormalize; "Option B" is compound index. Leaves decision open. |
| **Opus-1** | Defer | Acknowledges it but doesn't push it; treats as lower priority |

**Resolution**: **Consensus is "not immediately necessary."**
- All agree compound index `by_tenantId_and_assignedCloserId_and_status` solves the high-priority pipeline issue
- Meeting denormalization is a Phase 2 optimization to avoid O(n×m) joins in detail/calendar queries
- GPT-2 makes the strongest case (solves multiple pain points); Opus models suggest deferring until impact is measured

### D-2: Event Table Granularity — Unified vs. Specialized
| Audit | Position |
|-------|----------|
| **GPT-1** | Unified: `opportunityEvents`, `meetingEvents`, `followUpEvents`, `userMembershipEvents`, `featureUsageEvents` (separate tables but same pattern) |
| **GPT-3** | Unified: `domainEvents` with `entityType` and `eventType` discriminants; generic metadata object |
| **GPT-2** | Specialized: `opportunityStatusEvents`, `meetingLifecycleEvents`, `paymentEvents`, `customerConversionEvents`, `userActionEvents` |
| **Opus-2** | Specialized: Detailed `activityLog` with union of action types; typed metadata per event type |
| **Opus-1** | Specialized: Similar to Opus-2 |

**Disagreement Severity**: None — this is a taste difference, not a correctness issue.

**Recommendation**: Either approach works. Specialized tables are slightly more type-safe; unified table with discriminants is leaner. Team preference should drive the choice. Opus-2's schema is production-ready for the unified approach; GPT-2 is clear on specialized approach.

### D-3: Customer Data Sync — Is It a Problem?
| Audit | Position |
|-------|----------|
| **GPT-1** | Minor issue; denormalization acceptable |
| **GPT-3** | Medium issue; should evaluate sync or removal |
| **GPT-2** | Implicit issue (part of 3NF violation discussion) |
| **Opus-2** | Explicit problem; must choose sync or removal |
| **Opus-1** | Explicit problem; must choose sync or removal |

**Consensus**: It's a design choice that should be **documented**. If post-sale operations expand (orders, support, renewals), a canonical contact model will be needed. For now, snapshot is acceptable.

### D-4: What's the Priority of the Money Model Fix?
| Audit | Severity | Priority |
|-------|----------|----------|
| **GPT-1** | High | Immediate (remediation plan, item 2) |
| **GPT-3** | High | Next (after user soft-delete and events) |
| **GPT-2** | High (implicit) | Later phase (not in immediate remediation) |
| **Opus-2** | Not mentioned | — |
| **Opus-1** | Not mentioned | — |

**Why the Variance**: GPT-1/GPT-3 focused heavily on analytics-grade reporting; Opus-2/Opus-1 took a slightly broader lens but didn't emphasize financial safety. **This is a content gap in Opus audits, not a disagreement.**

---

## 5. Completeness Gaps (What One Audit Caught That Others Missed)

### Gap 1: Raw Webhook Event De-duplication (Found by All, Details by Opus-2)
- **GPT-1 F-8**: Uniqueness is soft, not hard
- **Opus-2 F-20**: Specific missing index `by_tenantId_and_eventType_and_calendlyEventUri` and notes about webhook payload structure
- **Others**: Noted but less detail

### Gap 2: Event Type Config Duplication (Found by All)
- **GPT-2 F-7**: Called out explicitly as a dimension table uniqueness issue
- **Opus-2 F-17**: Same thing, with explicit "pick oldest" heuristic noted
- **GPT-1 F-8**: Mentioned in uniqueness section
- **Opus-1 F-2.6**: Treated as part of broader validation issue

### Gap 3: Post-Pagination Filtering (Found by GPT-1, GPT-3, GPT-2; Not Emphasized by Opus)
- **GPT-1 F-4**: Closers paginate all customers, filter `convertedByUserId` in JS (incomplete results)
- **GPT-3 F-4**: Lead list defaults to "active-like" by filtering after pagination
- **GPT-2 F-5**: Same pattern across multiple queries
- **Opus-2/Opus-1**: Touched on but less emphasis; Opus-1 treated this as part of broader "missing indexes" discussion

### Gap 4: N+1 Lookups in Detail Pages (Found by All but Detailed Differently)
- **Opus-2 F-13**: Explicit O(n×m) nested loops analysis with specifics
- **GPT-3 F-7**: Called out with examples
- **Opus-1**: Mentioned in context of query optimization

### Gap 5: `leads.status` Optional Field (Found by GPT-1, GPT-3, Opus-1; Treated Lightly by Opus-2)
- **GPT-1 F-5**: Explicit finding about optional status breaking search/list logic
- **GPT-3**: Mentioned in context of leads.status cleanup
- **Opus-1 F-2.11**: Treated as Low severity
- **Opus-2**: Not explicitly called out

### Gap 6: Orphan Audit Pre-Remediation (Found by All but Emphasis Varies)
- **All 5**: Agree tenant deletion leaves orphans
- **GPT-1**: Recommends "run an orphan audit across all tables keyed by `tenantId`" before building reporting
- **Opus-2/Opus-1**: Less emphasis on the pre-remediation audit step
- **GPT-2**: Recommended as part of historical cleanup required

---

## 6. Comparison Matrix: Findings Across Audits

### Mapping of Findings to Each Audit

| Issue | GPT-1 | GPT-3 | GPT-2 | Opus-2 | Opus-1 | Consensus? |
|-------|-------|-------|-------|--------|--------|-----------|
| No event history | F-2 | F-1 | F-1 | F-7 | F-2.1 | ✅ Unanimous |
| `customFields` `v.any()` | F-6 | F-2 | F-2 | F-2 | F-2.6 | ✅ Unanimous |
| Dashboard full scans | F-7 | F-7 | F-3 | F-10 | F-2.2 | ✅ Unanimous |
| Closer `.collect()` | F-4 | F-4 | F-4 | F-11 | F-2.3 | ✅ Unanimous |
| Tenant offboarding orphans | F-1 | F-3 | F-9 | F-21 | Implicit | ✅ Unanimous |
| `tenants` OAuth churn | — | F-6 | F-6 | F-1 | F-2.14 | ✅ 4/5 (GPT-1 missed) |
| User hard delete orphans | — | F-3 | F-3 | Integrity | F-2.5 | ✅ 4/5 (GPT-1 didn't flag) |
| Missing relationship indexes | F-4 | F-4/F-7 | F-6 | F-17/19 | F-2.12/13 | ✅ Unanimous |
| `customers` field duplication | Noted | Mentioned | Implicit | F-3 | F-2.7 | ✅ 4/5 (emphasis varies) |
| `payments` not currency-safe | F-3 | F-5 | F-5 | — | — | ✅ 3/5 (Opus silent) |
| `followUps` polymorphic | — | Implicit | F-8 | F-9 | Implicit | ✅ 3/5 explicit |
| `paymentRecords` polymorphic | — | Implicit | F-8 | F-9 | Implicit | ✅ 3/5 explicit |
| O(n×m) detail queries | F-4 | F-7 | F-6 | F-13 | Implicit | ✅ Unanimous |
| Denormalized fields stale | Reviewed | Mentioned | Implicit | F-4/5 | F-2.8 | ✅ Unanimous (low priority) |
| Missing time-range indexes | F-7 | Implicit | F-6 | F-16 | F-2.9 | ✅ Unanimous |

---

## 7. Severity Redistribution

### High Severity (🔴) — Unanimous
1. ✅ No event history (impacts analytics and audit)
2. ✅ Dashboard full table scans (impacts scalability)
3. ✅ Closer pipeline `.collect()` (impacts scalability)
4. ✅ Tenant offboarding (data lifecycle integrity)
5. ✅ `customFields` schema safety (type safety + analytics)

### High Severity (🔴) — Mostly Agreed (4/5)
6. ✅ User hard delete (data integrity for historical queries)
7. ✅ `tenants` OAuth churn (impacts subscription cost)

### Medium Severity (🟡) — Agreed by 3+
8. ✅ Missing relationship indexes (query correctness)
9. ✅ Payment model unsafety (financial reporting)
10. ✅ Polymorphic tables (validation and analytics)
11. ✅ O(n×m) detail queries (performance)
12. ✅ `customers` field sync (data consistency)

### Low Severity (🟢) — Agreed by 3+
13. ✅ Denormalized field staleness (minor UI inconsistency)
14. ✅ Missing time-range indexes (analytics optimization)
15. ✅ `leads.status` optional (schema normalization)

---

## 8. Recommended Audit Priority Framework

### Immediate (Week 1-2)
1. **Tenant offboarding fix** — Code only, no migration
2. **Dashboard summary table** — Additive, high impact
3. **Closer pipeline index** — Additive, high impact
4. **Add missing relationship indexes** — Additive, medium effort
5. **User soft delete** — Widen-migrate-narrow, but critical for data integrity

### Next (Week 3-4)
1. **Event table design and dual-write** — Pick unified or specialized; start capturing new events
2. **`customFields` narrowing** — Audit existing, widen schema, backfill, narrow
3. **Fix detail query O(n×m)** — Refactor, add indexes as needed
4. **Summary tables** — `tenantStats` (if not done in Week 1), `eventTypeStats`, customer revenue

### Later (Weeks 5-8)
1. **`tenants` OAuth extraction** — Large migration with minimal immediate impact
2. **Payment model fix** — Currency safety, int64, reporting structure
3. **Denormalized field sync** — `meetings.leadName`, `hostCalendly*` (low impact)
4. **Meeting denormalization** (if needed) — Add `assignedCloserId`, denormalize closer onto meetings
5. **Stream to warehouse** — Set up export for serious OLAP analytics

---

## 9. Key Insights & Contradictions

### Insight 1: All Audits Agree on the Analytics-Readiness Gap
Every audit explicitly stated the schema is operationally strong but analytically weak. The reason: **current-state optimization vs. historical fact preservation**. No auditor disagreed on this core insight.

### Insight 2: The Unified vs. Specialized Event Table Choice Doesn't Matter Architecturally
All 5 audits proposed event tables, but the exact taxonomy (unified vs. specialized) was a preference, not a correctness issue. Both work; the unified approach is leaner, specialized is slightly safer. **No blocker here.**

### Insight 3: Opus Models Omitted the Money Safety Issue
GPT-1, GPT-3, and GPT-2 all flagged `paymentRecords.amount` as unsafe for financial reporting (float, no currency awareness). Opus-2 and Opus-1 didn't mention it. **This is a content gap, not a disagreement** — it's a valid issue that should be on the roadmap.

### Insight 4: GPT-1 and GPT-3 More Thorough on Analytics Patterns
GPT-1 and GPT-3 spent more time on analytics-specific index recommendations and reporting shapes. Opus-2 and Opus-1 were more balanced between operational and analytical concerns. **No contradiction — different emphasis.**

### Insight 5: Only One Real Architectural Disagreement: Meeting Denormalization
GPT-2 pushed hard for denormalizing `assignedCloserId` onto meetings to avoid O(n×m) joins. Others suggested it could be deferred. **Consensus: defer to Phase 2 after measuring impact.**

### Contradiction 1: Who Should Own the Payment Model Fix?
- **GPT-1**: Immediate (remediation item 2)
- **GPT-2/3**: Later, after event tables
- **Opus**: Silent

**Resolution**: Financial safety is important but not a blocker for analytics readiness. Can proceed with event tables first; money model can follow.

### Contradiction 2: Is `customers` Data Sync a Real Problem?
- **Opus-2, Opus-1**: Explicit problem; must choose (A) or (B)
- **GPT-1**: Acceptable as intentional snapshot
- **GPT-3, GPT-2**: Mentioned but lower priority

**Resolution**: It's a design decision, not a bug. Document snapshot intent; revisit if post-sale domain expands.

---

## 10. Completeness & Coverage Summary

### Audits Ranked by Scope & Depth

| Rank | Audit | Strengths | Gaps |
|------|-------|-----------|------|
| 1 | **Opus-2** | Most comprehensive; detailed schemas for proposed tables; explicit integrity matrix; 21 findings with clear severity; excellent index coverage | Omits money safety; slightly verbose |
| 2 | **GPT-2** | Very thorough on analytics patterns; excellent on polymorphism and discriminant modeling; clear migration guidance | Less detailed on specific index recommendations; omits some low-hanging fruit |
| 3 | **GPT-1** | Balanced; good on analytics maturity; explicit on orphan audit recommendation; solid remediation plan | Less detail on exact schemas; slightly less rigorous on integrity checks |
| 4 | **GPT-3** | Comprehensive; covers most areas; clear structure | Slightly less analytical depth than GPT-1; less detail on specific recommendations |
| 5 | **Opus-1** | Good breadth; detailed findings; 15 explicit findings | Less structured than Opus-2; some findings treated as lower priority than deserved |

**Recommendation**: Use **Opus-2 as primary source** for schemas and implementation details; **GPT-2 for analytics patterns**; **GPT-1 for orphan audit and money safety**.

---

## 11. Final Consensus Recommendation

### Phase 1 (Weeks 1-2): Critical Fixes
- Fix tenant offboarding cascade (code change)
- Add `tenantStats` summary table (additive)
- Add `opportunities.by_tenantId_and_assignedCloserId_and_status` index (additive)
- Add all missing relationship indexes (additive)
- Move `users` to soft delete pattern (widen-migrate-narrow)

### Phase 2 (Weeks 3-4): Analytic Foundation
- Add event table (domain events or activity log)
- Dual-write new events from all state-change mutations
- Narrow `leads.customFields` to typed model (widen-migrate-narrow)
- Refactor O(n×m) detail queries

### Phase 3 (Weeks 5-8): Optimizations
- Extract `calendlyConnections` from `tenants` (widen-migrate-narrow)
- Add reporting summary tables (customer revenue, event type stats)
- Consider meeting denormalization (if calendar/redistribution prove hot)
- Plan warehouse export for true OLAP

### Out of Scope (Until Roadmap Confirms)
- Comprehensive payment model rewrite (unless multi-currency is confirmed need)
- Customer data sync/removal (document snapshot intent first)

---

## Appendix: Citation Index

For each finding, which audits mentioned it:

```
F-A (Event History): GPT-1 F-2, GPT-3 F-1, GPT-2 F-1, Opus-2 F-07, Opus-1 F-2.1
F-B (customFields): GPT-1 F-6, GPT-3 F-2, GPT-2 F-2, Opus-2 F-02, Opus-1 F-2.6
F-C (Dashboard scans): GPT-1 F-7, GPT-3 F-7, GPT-2 F-3, Opus-2 F-10, Opus-1 F-2.2
F-D (Closer .collect()): GPT-1 F-4, GPT-3 F-4, GPT-2 F-4, Opus-2 F-11, Opus-1 F-2.3
F-E (Tenant offboarding): GPT-1 F-1, GPT-3 F-3, GPT-2 F-9, Opus-2 F-21, Opus-1 implicit
F-F (tenants OAuth): GPT-3 F-6, GPT-2 F-6, Opus-2 F-01, Opus-1 F-2.14, GPT-1 silent
F-G (User hard delete): GPT-3 F-3, GPT-2 implicit, Opus-2 integrity, Opus-1 F-2.5, GPT-1 silent
F-H (Missing indexes): GPT-1 F-4/7, GPT-3 F-4/7, GPT-2 F-6, Opus-2 F-16/17/19, Opus-1 F-2.12/13
F-Money (Payment safety): GPT-1 F-3, GPT-3 F-5, GPT-2 F-5, Opus-2 silent, Opus-1 silent
```

