# Phase 1 — Schema & Permissions Foundation

**Goal:** Establish the data layer for Lead Manager by creating the `leadMergeHistory` table, adding a `searchText` field and search index to `leads`, defining lead RBAC permissions, building the `searchTextBuilder` utility, and wiring it into the pipeline so every new/updated lead gets searchable text on create.

**Prerequisite:** Feature E (Lead Identity Resolution) deployed; `leads` and `leadIdentifiers` tables exist with current schema.

**Runs in PARALLEL with:** Nothing — all subsequent Lead Manager phases depend on this.

**Skills to invoke:**
- `convex-migration-helper` — for post-deploy backfill of `searchText` on existing leads (deferred, not blocking Phase 1 deployment)

**Acceptance Criteria:**

1. New `leadMergeHistory` table exists with all fields (`tenantId`, `sourceLeadId`, `targetLeadId`, `mergedByUserId`, `mergedAt`, `identifiersMoved`, `opportunitiesMoved`, `meetingsMoved`) and indexes (`by_tenantId`, `by_sourceLeadId`, `by_targetLeadId`).
2. `leads` table has optional `searchText` field, a new `by_tenantId_and_status` index, and a `search_leads` search index (searchField: `"searchText"`, filterFields: `["tenantId", "status"]`).
3. Seven new `lead:*` permissions exist in `convex/lib/permissions.ts` with correct role assignments.
4. `convex/leads/searchTextBuilder.ts` exports a pure `buildLeadSearchText()` function that concatenates name, email, phone, social handles, and identifier values.
5. `convex/pipeline/inviteeCreated.ts` calls `buildLeadSearchText()` after `createLeadIdentifiers` in both the Feature A deterministic linking path and the normal flow path, and after `syncLeadFromBooking` for existing-lead updates, patching `searchText` onto the lead.
6. Schema deployment via `npx convex dev` completes without errors.
7. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
1A (Schema: leadMergeHistory + leads modifications)
    ├──→ 1B (Permissions: lead RBAC entries)
    └──→ 1C (Utility: searchTextBuilder.ts)
              ↓
          1D (Pipeline integration: populate searchText)
```

**Optimal execution:**

1. Complete 1A first (everything depends on schema types).
2. Run 1B and 1C in parallel (zero shared files).
3. After 1C completes, implement 1D (depends on 1A schema types + 1C utility).

**Estimated time:** 2-3 hours (1A = 30 min, 1B = 15 min, 1C = 20 min, 1D = 45 min, validation = 30 min)

---

## Subphases

### 1A — Schema: `leadMergeHistory` Table + `leads` Modifications

**Type:** Backend
**Parallelizable:** No — this is the blocking foundation. All subsequent subphases depend on the schema types being deployed.

**What:** Add the `leadMergeHistory` table to `convex/schema.ts`, add the `searchText` optional field to the `leads` table, add a `by_tenantId_and_status` index to `leads`, and add a `search_leads` search index to `leads`.

**Why:** The merge history table provides an auditable record of every lead merge operation for compliance and undo capability. The `searchText` field enables full-text search across all lead identity data (name, email, phone, social handles, identifiers) via Convex's built-in search index. The `by_tenantId_and_status` index supports filtered list queries (e.g., show only active leads). All fields are optional for backward compatibility with existing data.

**Where:**
- `convex/schema.ts` (modify)

**How:**

**Step 1: Add the `leadMergeHistory` table**

Insert this new table definition after the `leadIdentifiers` table (after line 179 in the current schema):

```typescript
// Path: convex/schema.ts

// === Feature C: Lead Merge Audit Trail ===
leadMergeHistory: defineTable({
  tenantId: v.id("tenants"),
  sourceLeadId: v.id("leads"),     // The lead that was merged (now status="merged")
  targetLeadId: v.id("leads"),     // The lead that received the merged data
  mergedByUserId: v.id("users"),   // Who performed the merge
  mergedAt: v.number(),            // Unix ms timestamp
  identifiersMoved: v.number(),    // Count of leadIdentifier records reassigned
  opportunitiesMoved: v.number(),  // Count of opportunities reassigned
  meetingsMoved: v.number(),       // Count of meetings reassigned (via opportunities)
})
  .index("by_tenantId", ["tenantId"])
  .index("by_sourceLeadId", ["sourceLeadId"])
  .index("by_targetLeadId", ["targetLeadId"]),
// === End Feature C ===
```

**Step 2: Add `searchText` field to `leads` table**

Locate the `leads` table definition (currently lines 110-145). Add the `searchText` field after the `socialHandles` field, before the closing `})`:

```typescript
// Path: convex/schema.ts (within the leads table definition, after socialHandles)

    // === End Feature E ===

    // === Feature C: Full-Text Search Support ===
    // Denormalized search string built from fullName, email, phone, socialHandles,
    // and leadIdentifier values. Updated by the pipeline on lead create/update
    // and by the searchTextBuilder utility. Enables Convex search index queries.
    searchText: v.optional(v.string()),
    // === End Feature C ===
```

**Step 3: Add `by_tenantId_and_status` index and `search_leads` search index to `leads`**

Replace the existing leads index block (currently lines 144-145) with:

```typescript
// Path: convex/schema.ts (leads table indexes)

  })
    .index("by_tenantId", ["tenantId"])
    .index("by_tenantId_and_email", ["tenantId", "email"])
    .index("by_tenantId_and_status", ["tenantId", "status"])
    .searchIndex("search_leads", {
      searchField: "searchText",
      filterFields: ["tenantId", "status"],
    }),
```

**Step 4: Validate and deploy schema**

```bash
npx convex dev
```

The dev server will validate schema changes and report errors. Once validation passes, confirm in the Convex dashboard:
- `leadMergeHistory` table is visible with 3 indexes
- `leads` table shows `searchText` field, the new `by_tenantId_and_status` index, and the `search_leads` search index

**Key implementation notes:**

- `searchText` is `v.optional(v.string())` to maintain backward compatibility. Existing leads will have `undefined` searchText until the post-deploy backfill runs or the lead is updated by a new booking.
- The `search_leads` search index uses `searchField: "searchText"` (the field Convex tokenizes for full-text search) and `filterFields: ["tenantId", "status"]` (fields that can be used as equality filters alongside the text query). Convex search indexes require at least one `searchField`.
- The `by_tenantId_and_status` index enables efficient filtered queries like "all active leads for this tenant" without scanning the full table.
- `leadMergeHistory` uses count fields (`identifiersMoved`, `opportunitiesMoved`, `meetingsMoved`) rather than arrays of IDs to avoid unbounded document growth, following the project's schema convention.
- All `leadMergeHistory` indexes are single or dual field to support: (1) admin list views filtered by tenant, (2) merge history for a specific source lead (undo/audit), (3) merge history into a target lead (provenance).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Add `leadMergeHistory` table; add `searchText` to `leads`; add `by_tenantId_and_status` index; add `search_leads` search index |

---

### 1B — Permissions: Lead RBAC Entries

**Type:** Backend
**Parallelizable:** Yes — can run in parallel with 1C after 1A completes. Zero shared files with 1C.

**What:** Add seven new lead-related permissions to `convex/lib/permissions.ts` with appropriate role assignments.

**Why:** The Lead Manager feature introduces new actions (view, edit, create, delete, merge, convert, export) that must be gated by role. Adding permissions now means Phase 2+ UI and backend code can immediately reference them without blocking on RBAC work. Following the established pattern, all roles can view leads (it is core CRM data), but destructive/administrative operations are restricted to admins and owners.

**Where:**
- `convex/lib/permissions.ts` (modify)

**How:**

**Step 1: Add the seven new permissions to the PERMISSIONS object**

Insert the new entries after the existing `"reassignment:view-all"` line (line 18 in the current file), before the closing `} as const`:

```typescript
// Path: convex/lib/permissions.ts

export const PERMISSIONS = {
  "team:invite": ["tenant_master", "tenant_admin"],
  "team:remove": ["tenant_master", "tenant_admin"],
  "team:update-role": ["tenant_master"],
  "pipeline:view-all": ["tenant_master", "tenant_admin"],
  "pipeline:view-own": ["tenant_master", "tenant_admin", "closer"],
  "settings:manage": ["tenant_master", "tenant_admin"],
  "meeting:view-own": ["tenant_master", "tenant_admin", "closer"],
  "meeting:manage-own": ["closer"],
  "payment:record": ["closer"],
  "payment:view-all": ["tenant_master", "tenant_admin"],
  "payment:view-own": ["tenant_master", "tenant_admin", "closer"],
  "team:assign-event-type": ["tenant_master", "tenant_admin"],
  "team:manage-availability": ["tenant_master", "tenant_admin"],
  "follow-up:create": ["closer"],
  "follow-up:complete": ["closer"],
  "reassignment:execute": ["tenant_master", "tenant_admin"],
  "reassignment:view-all": ["tenant_master", "tenant_admin"],

  // === Feature C: Lead Manager ===
  "lead:view-all": ["tenant_master", "tenant_admin", "closer"],
  "lead:edit": ["tenant_master", "tenant_admin"],
  "lead:create": ["tenant_master", "tenant_admin"],
  "lead:delete": ["tenant_master"],
  "lead:merge": ["tenant_master", "tenant_admin", "closer"],
  "lead:convert": ["tenant_master", "tenant_admin"],
  "lead:export": ["tenant_master", "tenant_admin"],
  // === End Feature C ===
} as const;
```

**Step 2: Verify types propagate**

No changes needed to `Permission` type or `hasPermission()` function — they are derived from the `PERMISSIONS` object via `keyof typeof PERMISSIONS` and will automatically include the new keys.

```bash
pnpm tsc --noEmit
```

**Key implementation notes:**

- `lead:view-all` includes `closer` because closers need to see lead details on their meeting pages and search for leads in the pipeline. All roles can view — this is core CRM data.
- `lead:merge` includes `closer` because closers encounter duplicate leads most often during meetings and need to resolve them without escalating to an admin.
- `lead:delete` is restricted to `tenant_master` only — permanent data deletion is the most destructive operation and follows the same pattern as `team:update-role`.
- `lead:convert` and `lead:export` are admin-only operations that have broader business implications (pipeline stage changes, data export compliance).
- The `Permission` type updates automatically via `keyof typeof PERMISSIONS`, so all existing `hasPermission()` call sites remain valid.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/permissions.ts` | Modify | Add 7 new `lead:*` permission entries |

---

### 1C — Utility: `searchTextBuilder.ts`

**Type:** Backend
**Parallelizable:** Yes — can run in parallel with 1B after 1A completes. Zero shared files with 1B.

**What:** Create `convex/leads/searchTextBuilder.ts` with a pure `buildLeadSearchText()` function that produces a space-separated string from lead fields and optional identifier values.

**Why:** Full-text search in Convex operates on a single string field. This utility denormalizes name, email, phone, social handles, and any additional identifier values into one searchable blob. Keeping it as a pure function (no DB access) makes it testable, reusable from both the pipeline and future manual-edit mutations, and easy to extend.

**Where:**
- `convex/leads/searchTextBuilder.ts` (create)

**How:**

**Step 1: Create the `convex/leads/` directory and the file**

```bash
mkdir -p convex/leads
```

**Step 2: Write the `buildLeadSearchText` function**

```typescript
// Path: convex/leads/searchTextBuilder.ts

import type { Doc } from "../_generated/dataModel";

/**
 * Build a denormalized search string from lead fields and optional identifier values.
 *
 * Used to populate the `searchText` field on the `leads` table, which backs
 * the `search_leads` Convex search index. This is a pure function — no DB access.
 *
 * @param lead - The lead document (only needs fullName, email, phone, socialHandles).
 * @param identifierValues - Optional array of normalized identifier values from
 *   the `leadIdentifiers` table (e.g., additional emails, phone numbers, handles).
 *   Values already present in the lead fields are deduplicated automatically.
 * @returns A space-separated string of all searchable tokens, or undefined if
 *   the lead has no searchable data (should not happen in practice).
 */
export function buildLeadSearchText(
  lead: Pick<Doc<"leads">, "fullName" | "email" | "phone" | "socialHandles">,
  identifierValues?: string[],
): string | undefined {
  const parts: string[] = [];
  if (lead.fullName) parts.push(lead.fullName);
  if (lead.email) parts.push(lead.email);
  if (lead.phone) parts.push(lead.phone);
  if (lead.socialHandles) {
    for (const { handle } of lead.socialHandles) {
      parts.push(handle);
    }
  }
  if (identifierValues) {
    for (const val of identifierValues) {
      if (!parts.includes(val)) parts.push(val);
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}
```

**Key implementation notes:**

- The function accepts a `Pick<Doc<"leads">, ...>` so it works with both full lead documents and partial objects (e.g., when constructing a lead in the pipeline before the insert).
- Deduplication (`!parts.includes(val)`) prevents the same email from appearing twice when it exists as both `lead.email` and a `leadIdentifier` value. The linear scan is acceptable because the parts array is small (typically 3-8 items).
- Returns `undefined` (not empty string) when no parts exist, so the caller can skip the patch if there is nothing to write. Convex search indexes ignore `undefined` fields.
- No normalization is performed here — the caller is responsible for providing already-normalized values from `leadIdentifiers.value`. This keeps the function single-purpose.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leads/searchTextBuilder.ts` | Create | Pure utility function for building lead search text |

---

### 1D — Pipeline Integration: Populate `searchText` on Lead Create/Update

**Type:** Backend
**Parallelizable:** No — depends on 1A (schema types) and 1C (utility function).

**What:** Modify `convex/pipeline/inviteeCreated.ts` to import `buildLeadSearchText` and call it after `createLeadIdentifiers` in both the Feature A deterministic linking path and the normal flow path, as well as after `syncLeadFromBooking` for existing-lead updates. Each call site loads the lead's identifiers, builds the search text, and patches the `searchText` field onto the lead.

**Why:** Every lead that enters or is updated through the webhook pipeline should have up-to-date search text. This ensures the search index stays current without requiring a separate backfill cron. The three call sites cover all entry points: (1) follow-up bookings via deterministic linking, (2) new leads via identity resolution, and (3) existing leads updated with new booking data.

**Where:**
- `convex/pipeline/inviteeCreated.ts` (modify)

**How:**

**Step 1: Add the import**

Add the `buildLeadSearchText` import to the top of the file, alongside the existing imports (after the current import block ending at line 17):

```typescript
// Path: convex/pipeline/inviteeCreated.ts (imports section)

import {
	normalizeEmail,
	normalizeSocialHandle,
	normalizePhone,
	areNamesSimilar,
	extractEmailDomain,
} from "../lib/normalization";
import type { IdentifierType, SocialPlatformType } from "../lib/normalization";
import { buildLeadSearchText } from "../leads/searchTextBuilder";
```

**Step 2: Create a helper function for loading identifiers and patching searchText**

Add this helper function after the existing `createLeadIdentifiers` function (after line 630). This avoids duplicating the load-identifiers-build-patch logic at each call site:

```typescript
// Path: convex/pipeline/inviteeCreated.ts (after createLeadIdentifiers, ~line 630)

/**
 * Load a lead's identifiers, build the search text, and patch the lead.
 * Called after createLeadIdentifiers or syncLeadFromBooking to keep the
 * search index current.
 */
async function updateLeadSearchText(
  ctx: MutationCtx,
  leadId: Id<"leads">,
): Promise<void> {
  const lead = await ctx.db.get(leadId);
  if (!lead) return;

  const identifiers = await ctx.db
    .query("leadIdentifiers")
    .withIndex("by_leadId", (q) => q.eq("leadId", leadId))
    .collect();

  const identifierValues = identifiers.map((id) => id.value);
  const searchText = buildLeadSearchText(lead, identifierValues);

  if (searchText !== lead.searchText) {
    await ctx.db.patch(leadId, { searchText });
  }
}
```

**Step 3: Call `updateLeadSearchText` after `createLeadIdentifiers` in the Feature A deterministic linking path**

Locate the Feature A deterministic linking `createLeadIdentifiers` call (line 1070-1080). Insert the `updateLeadSearchText` call immediately after it, before `syncKnownCustomFieldKeys`:

```typescript
// Path: convex/pipeline/inviteeCreated.ts (~line 1080, BEFORE)

					await createLeadIdentifiers(
						ctx,
						tenantId,
						lead._id,
						meetingId,
						inviteeEmail,
						rawInviteeEmail,
						effectivePhone,
						extractedIdentifiers.socialHandle,
						now,
					);
					await syncKnownCustomFieldKeys(
```

```typescript
// Path: convex/pipeline/inviteeCreated.ts (~line 1080, AFTER)

					await createLeadIdentifiers(
						ctx,
						tenantId,
						lead._id,
						meetingId,
						inviteeEmail,
						rawInviteeEmail,
						effectivePhone,
						extractedIdentifiers.socialHandle,
						now,
					);
					await updateLeadSearchText(ctx, lead._id);
					await syncKnownCustomFieldKeys(
```

**Step 4: Call `updateLeadSearchText` after `createLeadIdentifiers` in the normal flow path**

Locate the normal flow `createLeadIdentifiers` call (line 1263-1273). Insert the `updateLeadSearchText` call immediately after the Feature E log line, before `syncKnownCustomFieldKeys`:

```typescript
// Path: convex/pipeline/inviteeCreated.ts (~line 1274-1279, BEFORE)

		await createLeadIdentifiers(
			ctx,
			tenantId,
			lead._id,
			meetingId,
			inviteeEmail,
			rawInviteeEmail,
			effectivePhone,
			extractedIdentifiers.socialHandle,
			now,
		);
		console.log(
			`[Pipeline:Identity] Lead identifiers created | leadId=${lead._id} meetingId=${meetingId}`,
		);
		// === End Feature E ===

		await syncKnownCustomFieldKeys(
```

```typescript
// Path: convex/pipeline/inviteeCreated.ts (~line 1274-1279, AFTER)

		await createLeadIdentifiers(
			ctx,
			tenantId,
			lead._id,
			meetingId,
			inviteeEmail,
			rawInviteeEmail,
			effectivePhone,
			extractedIdentifiers.socialHandle,
			now,
		);
		console.log(
			`[Pipeline:Identity] Lead identifiers created | leadId=${lead._id} meetingId=${meetingId}`,
		);
		// === End Feature E ===

		// === Feature C: Update search text after identifiers are created ===
		await updateLeadSearchText(ctx, lead._id);
		// === End Feature C ===

		await syncKnownCustomFieldKeys(
```

**Step 5: Call `updateLeadSearchText` after `syncLeadFromBooking` in the Feature A deterministic linking path**

Locate the `syncLeadFromBooking` call in the Feature A path (line 961). Insert `updateLeadSearchText` after the sync completes. This covers existing leads that get updated fields (name, phone, custom fields) from a new booking:

```typescript
// Path: convex/pipeline/inviteeCreated.ts (~line 961-966, BEFORE)

				} else {
					const lead = await syncLeadFromBooking(ctx, targetLead, {
						inviteeName,
						inviteePhone: effectivePhone,
						latestCustomFields,
						now,
					});
					const { hostUserUri, hostCalendlyEmail, hostCalendlyName } =
```

```typescript
// Path: convex/pipeline/inviteeCreated.ts (~line 961-966, AFTER)

				} else {
					const lead = await syncLeadFromBooking(ctx, targetLead, {
						inviteeName,
						inviteePhone: effectivePhone,
						latestCustomFields,
						now,
					});
					// Feature C: Rebuild search text after lead fields are updated
					await updateLeadSearchText(ctx, lead._id);
					const { hostUserUri, hostCalendlyEmail, hostCalendlyName } =
```

**Step 6: Call `updateLeadSearchText` after `syncLeadFromBooking` in the normal flow path**

Locate the `syncLeadFromBooking` call in the normal (non-Feature-A) path (line 1118). Insert `updateLeadSearchText` after the sync, before the host membership extraction:

```typescript
// Path: convex/pipeline/inviteeCreated.ts (~line 1117-1132, BEFORE)

		// If existing lead, update fields (existing behavior, preserved)
		if (!resolution.isNewLead) {
			lead = await syncLeadFromBooking(ctx, lead, {
				inviteeName,
				inviteePhone: effectivePhone,
				latestCustomFields,
				now,
			});
		} else if (latestCustomFields) {
			// New lead: set custom fields (they were not set in resolveLeadIdentity)
			await ctx.db.patch(lead._id, {
				customFields: latestCustomFields,
			});
		}
		// === End Feature E: Identity Resolution ===

		const { hostUserUri, hostCalendlyEmail, hostCalendlyName } =
```

```typescript
// Path: convex/pipeline/inviteeCreated.ts (~line 1117-1132, AFTER)

		// If existing lead, update fields (existing behavior, preserved)
		if (!resolution.isNewLead) {
			lead = await syncLeadFromBooking(ctx, lead, {
				inviteeName,
				inviteePhone: effectivePhone,
				latestCustomFields,
				now,
			});
			// Feature C: Rebuild search text after lead fields are updated
			await updateLeadSearchText(ctx, lead._id);
		} else if (latestCustomFields) {
			// New lead: set custom fields (they were not set in resolveLeadIdentity)
			await ctx.db.patch(lead._id, {
				customFields: latestCustomFields,
			});
		}
		// === End Feature E: Identity Resolution ===

		const { hostUserUri, hostCalendlyEmail, hostCalendlyName } =
```

**Key implementation notes:**

- The `updateLeadSearchText` helper re-reads the lead from the DB to get the latest state after mutations. This costs one extra read but ensures correctness — the lead may have been modified by both `syncLeadFromBooking` (name, phone) and `createLeadIdentifiers` (social handles) in the same transaction.
- The `identifiers.collect()` call in `updateLeadSearchText` is safe because a single lead typically has 2-6 identifiers (email + phone + optionally 1-2 social handles). The `by_leadId` index ensures this is an indexed scan, not a table scan.
- The `searchText !== lead.searchText` guard avoids unnecessary writes when the search text has not changed (e.g., a re-booking with identical data). This reduces write costs and avoids triggering unnecessary search index rebuilds.
- The normal-flow `syncLeadFromBooking` call (Step 6) places `updateLeadSearchText` inside the `if (!resolution.isNewLead)` branch. For new leads, `updateLeadSearchText` runs after `createLeadIdentifiers` (Step 4), which already covers the initial search text population.
- Four call sites total: two after `createLeadIdentifiers` (Steps 3-4), two after `syncLeadFromBooking` (Steps 5-6). The `createLeadIdentifiers` sites handle new identifier data; the `syncLeadFromBooking` sites handle updated lead fields. For existing leads in the normal flow, both Step 4 and Step 6 will fire — Step 6 captures field changes from the sync, and Step 4 captures new identifiers. The idempotent guard ensures only one actual write occurs if the text is unchanged between the two calls.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/pipeline/inviteeCreated.ts` | Modify | Import `buildLeadSearchText`; add `updateLeadSearchText` helper; call at 4 sites after `createLeadIdentifiers` and `syncLeadFromBooking` |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/schema.ts` | Modify | 1A |
| `convex/lib/permissions.ts` | Modify | 1B |
| `convex/leads/searchTextBuilder.ts` | Create | 1C |
| `convex/pipeline/inviteeCreated.ts` | Modify | 1D |

---

## Notes for Implementer

- **Non-breaking deployment:** All schema changes are optional fields, so deployment is safe with existing production data. No downtime or data migration required before deployment.
- **Backward compatibility:** Existing leads will have `searchText: undefined`. Search queries should handle this gracefully — leads without searchText simply will not appear in search results until backfilled or updated by a new booking.
- **Post-deploy backfill (deferred):** After Phase 1 deploys, use the `convex-migration-helper` skill to backfill `searchText` on all existing leads. The migration iterates over all leads, loads their identifiers, calls `buildLeadSearchText`, and patches. This is non-blocking — the Lead Manager UI (Phase 2+) will work with partial search results until backfill completes.
- **Search index behavior:** Convex search indexes are eventually consistent — there may be a brief delay (typically < 1 second) between writing `searchText` and the document appearing in search results. The UI should not rely on immediate consistency after a write.
- **Transaction budget:** The `updateLeadSearchText` helper adds 1 read (lead) + 1 indexed query (identifiers) + 1 conditional write per call site. For the normal flow where both `syncLeadFromBooking` and `createLeadIdentifiers` fire, this is 2 reads + 2 queries + 1-2 writes. This is well within Convex's 8MB/512-operation transaction limits.
- **Next phase:** After Phase 1 deploys, Phase 2 (Lead List Page + Search API) can begin immediately, using the `search_leads` index and `lead:view-all` permission.
