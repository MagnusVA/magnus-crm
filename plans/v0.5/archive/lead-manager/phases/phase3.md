# Phase 3 — Backend: Lead Mutations & Merge Logic

**Goal:** Implement all write operations for the Lead Manager feature: `updateLead` (admin-only lead editing), `mergeLead` with `executeMerge` helper (atomic lead merge with full audit trail), and `dismissDuplicateFlag` (clear pipeline-detected duplicate banner). After this phase, any CRM user can merge two leads in a single transaction, and admins can edit lead info and dismiss false-positive duplicate flags.

**Prerequisite:** Phase 1 complete (schema deployed — `leadMergeHistory` table, `searchText` field on `leads`, `by_tenantId_and_status` index, `search_leads` search index, lead permissions in `convex/lib/permissions.ts`, `buildLeadSearchText` utility in `convex/leads/searchTextBuilder.ts`).

**Runs in PARALLEL with:** Phase 2 (Lead Queries in `convex/leads/queries.ts`) — separate files, no dependency between Phase 2 and Phase 3.

**Skills to invoke:**
- `convex-performance-audit` — after implementation, audit the `executeMerge` helper. It reads and writes many documents in a single transaction (source/target leads, source opportunities up to 100, source/target identifiers up to 100 each, tenant opportunities up to 500 for duplicate flag cleanup). Verify total bytes read/written stay within Convex mutation limits.

**Acceptance Criteria:**

1. `updateLead` mutation updates `fullName`, `phone`, and `email` on a lead, rejects merged leads, enforces admin-only access (`tenant_master`, `tenant_admin`), and rebuilds `searchText` after patching.
2. `mergeLead` mutation atomically: validates both leads, repoints source opportunities to target, consolidates identifiers (delete source + create on target with `source: "merge"`, skip duplicates), rebuilds target `socialHandles` and `searchText`, marks source as `merged` with `mergedIntoLeadId`, clears `potentialDuplicateLeadId` on affected opportunities, and creates a `leadMergeHistory` audit record.
3. All roles (`tenant_master`, `tenant_admin`, `closer`) can execute `mergeLead`.
4. `mergeLead` throws for: self-merge, cross-tenant leads, already-merged source, already-merged target.
5. `dismissDuplicateFlag` clears `potentialDuplicateLeadId` on an opportunity. Admin-only (`tenant_master`, `tenant_admin`).
6. Every merge creates exactly one `leadMergeHistory` record with correct `identifiersMoved` and `opportunitiesMoved` counts.
7. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
3A (updateLead mutation)
                          ← independent, can all start in parallel
3B (mergeLead + executeMerge)

3C (dismissDuplicateFlag)  ← independent of 3A and 3B
```

**Optimal execution:**

1. Start **3A**, **3B**, and **3C** all in parallel — they write to separate exported functions in separate files with no shared mutable state. 3A lives in `mutations.ts`; 3B and 3C live in `merge.ts`.
2. After all three complete, run `pnpm tsc --noEmit` to verify type correctness.

**Estimated time:** 2-3 hours

---

## Subphases

### 3A — `updateLead` Mutation

**Type:** Backend
**Parallelizable:** Yes — independent of 3B and 3C. Writes to a new file (`mutations.ts`) that neither 3B nor 3C touches.

**What:** Create `convex/leads/mutations.ts` with an `updateLead` mutation that allows admins to edit a lead's `fullName`, `phone`, and `email` fields. After patching, rebuilds the denormalized `searchText` field using the `buildLeadSearchText` utility from Phase 1.

**Why:** Admins need to correct lead info when it arrives misspelled or incomplete from Calendly bookings. Social handles are managed through `leadIdentifiers` (not directly editable here). The `searchText` rebuild ensures the search index stays current after manual edits.

**Where:**
- `convex/leads/mutations.ts` (new file)

**How:**

**Step 1: Create the mutations file with `updateLead`**

```typescript
// Path: convex/leads/mutations.ts
import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { buildLeadSearchText } from "./searchTextBuilder";

/**
 * Update editable lead fields. Admin-only (tenant_master, tenant_admin).
 *
 * Only fullName, phone, and email can be edited directly.
 * Social handles are managed through leadIdentifiers (not directly editable here).
 * Rebuilds searchText after patching to keep the search index current.
 */
export const updateLead = mutation({
  args: {
    leadId: v.id("leads"),
    fullName: v.optional(v.string()),
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
  },
  handler: async (ctx, { leadId, ...updates }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const lead = await ctx.db.get(leadId);
    if (!lead || lead.tenantId !== tenantId) {
      throw new Error("Lead not found");
    }
    if (lead.status === "merged") {
      throw new Error("Cannot edit a merged lead");
    }

    // Build patch object with only provided fields
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (updates.fullName !== undefined) patch.fullName = updates.fullName;
    if (updates.phone !== undefined) patch.phone = updates.phone;
    if (updates.email !== undefined) patch.email = updates.email;

    await ctx.db.patch(leadId, patch);

    // Rebuild searchText after the patch
    const updatedLead = await ctx.db.get(leadId);
    if (updatedLead) {
      const identifiers = await ctx.db
        .query("leadIdentifiers")
        .withIndex("by_leadId", (q) => q.eq("leadId", leadId))
        .take(50);
      const searchText = buildLeadSearchText(
        updatedLead,
        identifiers.map((i) => i.value),
      );
      await ctx.db.patch(leadId, { searchText });
    }

    console.log("[Leads:Mutation] updateLead", {
      leadId,
      updatedFields: Object.keys(updates),
    });
  },
});
```

**Key implementation notes:**

- The `updates` rest parameter is destructured from `args` so only `leadId` is used for lookup and the remaining fields are the patch payload.
- The `patch` object uses `Record<string, unknown>` because `ctx.db.patch` accepts a partial document. Only fields explicitly passed by the caller are included — `undefined` args are not added to the patch (they would clear the field otherwise).
- `searchText` is rebuilt using the *patched* lead (`updatedLead` re-read after the first `ctx.db.patch`). This ensures the search index reflects the edit.
- The `identifiers.map((i) => i.value)` call passes all identifier values (email, phone, social handles) to the search text builder so the search index covers all known identifiers, not just the lead's top-level fields.
- The `.take(50)` bound on identifiers is generous — most leads will have fewer than 10 identifiers. If a lead has more than 50, the search text will be incomplete for the excess identifiers, which is an acceptable tradeoff.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leads/mutations.ts` | Create | New file with `updateLead` mutation |

---

### 3B — `mergeLead` Mutation + `executeMerge` Helper

**Type:** Backend
**Parallelizable:** Yes — independent of 3A and 3C. Writes to a new file (`merge.ts`) that 3A does not touch.

**What:** Create `convex/leads/merge.ts` with a `mergeLead` mutation (exposed to the client) and an `executeMerge` helper function (internal logic). The merge is atomic — all 8 steps happen in a single Convex mutation transaction. If any step fails, the entire merge is rolled back.

**Why:** This is the core Feature C operation. Closers spot duplicates daily (a returning lead books under a different email or social handle). They need to merge two leads into one, combining all opportunities and identifiers on the surviving lead, without losing any data. The `leadMergeHistory` audit record gives admins full visibility into every merge.

**Where:**
- `convex/leads/merge.ts` (new file)

**How:**

**Step 1: Create the merge file with imports and types**

```typescript
// Path: convex/leads/merge.ts
import { v } from "convex/values";
import { mutation } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { requireTenantUser } from "../requireTenantUser";
import { buildLeadSearchText } from "./searchTextBuilder";
```

**Step 2: Add the `mergeLead` mutation (public entry point)**

```typescript
// Path: convex/leads/merge.ts (continued)

/**
 * Execute a lead merge. All roles with lead:merge permission.
 *
 * source = the lead being absorbed (becomes status: "merged").
 * target = the surviving lead that receives all data.
 *
 * This mutation is atomic — all changes happen in a single transaction.
 * If any step fails, the entire merge is rolled back.
 * Every merge creates a leadMergeHistory audit record for admin review.
 */
export const mergeLead = mutation({
  args: {
    sourceLeadId: v.id("leads"),
    targetLeadId: v.id("leads"),
  },
  handler: async (ctx, { sourceLeadId, targetLeadId }) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);

    await executeMerge(ctx, tenantId, userId, sourceLeadId, targetLeadId);
  },
});
```

**Step 3: Add the `executeMerge` helper (core merge logic)**

This is the most complex function in Feature C. It performs 8 steps atomically within a single Convex mutation transaction.

```typescript
// Path: convex/leads/merge.ts (continued)

/**
 * Core merge logic. Executes all merge steps in a single transaction.
 *
 * Steps:
 * 1. Validate both leads (same tenant, both active, not self-merge)
 * 2. Repoint source opportunities to target
 * 3. Consolidate identifiers (delete source, create on target with source="merge", skip duplicates)
 * 4. Rebuild target socialHandles denormalization
 * 5. Update target searchText
 * 6. Mark source as merged
 * 7. Clear potentialDuplicateLeadId on affected opportunities
 * 8. Create leadMergeHistory audit record
 */
async function executeMerge(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  userId: Id<"users">,
  sourceLeadId: Id<"leads">,
  targetLeadId: Id<"leads">,
): Promise<void> {
  const now = Date.now();

  // --- Validation ---
  if (sourceLeadId === targetLeadId) {
    throw new Error("Cannot merge a lead with itself");
  }

  const source = await ctx.db.get(sourceLeadId);
  const target = await ctx.db.get(targetLeadId);

  if (!source || source.tenantId !== tenantId) {
    throw new Error("Source lead not found");
  }
  if (!target || target.tenantId !== tenantId) {
    throw new Error("Target lead not found");
  }
  if (source.status === "merged") {
    throw new Error("Source lead is already merged");
  }
  if (target.status === "merged") {
    throw new Error("Cannot merge into a merged lead");
  }

  // --- Step 1: Repoint source opportunities to target ---
  const sourceOpportunities = await ctx.db
    .query("opportunities")
    .withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", sourceLeadId),
    )
    .take(100);

  for (const opp of sourceOpportunities) {
    await ctx.db.patch(opp._id, { leadId: targetLeadId, updatedAt: now });
  }

  // --- Step 2: Consolidate identifiers ---
  // Load all source identifiers — these will be deleted regardless.
  const sourceIdentifiers = await ctx.db
    .query("leadIdentifiers")
    .withIndex("by_leadId", (q) => q.eq("leadId", sourceLeadId))
    .take(100);

  // Load existing target identifiers to detect duplicates.
  const targetIdentifiers = await ctx.db
    .query("leadIdentifiers")
    .withIndex("by_leadId", (q) => q.eq("leadId", targetLeadId))
    .take(100);

  // Build a set of target identifier keys for O(1) duplicate detection.
  const targetIdSet = new Set(
    targetIdentifiers.map((i) => `${i.type}:${i.value}`),
  );

  let identifiersMoved = 0;
  for (const identifier of sourceIdentifiers) {
    const key = `${identifier.type}:${identifier.value}`;
    if (!targetIdSet.has(key)) {
      // Create a new identifier record on the target with source="merge".
      // This preserves provenance — the record shows it came from a merge.
      await ctx.db.insert("leadIdentifiers", {
        tenantId,
        leadId: targetLeadId,
        type: identifier.type,
        value: identifier.value,
        rawValue: identifier.rawValue,
        source: "merge",
        sourceMeetingId: identifier.sourceMeetingId,
        confidence: identifier.confidence,
        createdAt: now,
      });
      identifiersMoved++;
    }
    // Delete the source identifier regardless (it's now on the target or a duplicate).
    await ctx.db.delete(identifier._id);
  }

  // --- Step 3: Rebuild target's socialHandles denormalization ---
  // Re-read all target identifiers (including the newly created merge records).
  const allTargetIdentifiers = await ctx.db
    .query("leadIdentifiers")
    .withIndex("by_leadId", (q) => q.eq("leadId", targetLeadId))
    .take(100);

  const socialTypes = new Set([
    "instagram",
    "tiktok",
    "twitter",
    "facebook",
    "linkedin",
    "other_social",
  ]);
  const socialHandles = allTargetIdentifiers
    .filter((i) => socialTypes.has(i.type))
    .map((i) => ({ type: i.type, handle: i.value }));

  // --- Step 4: Update target lead with merged socialHandles and searchText ---
  const updatedTarget = await ctx.db.get(targetLeadId);
  if (!updatedTarget) {
    throw new Error("Target lead disappeared during merge");
  }

  const searchText = buildLeadSearchText(
    { ...updatedTarget, socialHandles },
    allTargetIdentifiers.map((i) => i.value),
  );

  await ctx.db.patch(targetLeadId, {
    socialHandles: socialHandles.length > 0 ? socialHandles : undefined,
    searchText,
    updatedAt: now,
  });

  // --- Step 5: Mark source as merged ---
  await ctx.db.patch(sourceLeadId, {
    status: "merged",
    mergedIntoLeadId: targetLeadId,
    updatedAt: now,
  });

  // --- Step 6: Clear potentialDuplicateLeadId on affected opportunities ---
  // Check opportunities that were just repointed (source -> target) and any
  // existing opportunities that referenced the source as a potential duplicate.
  // Note: We scan tenant opportunities to catch flags on opportunities belonging
  // to OTHER leads that had the source flagged as a potential duplicate.
  const allTenantOpportunities = await ctx.db
    .query("opportunities")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
    .take(500);

  for (const opp of allTenantOpportunities) {
    if (opp.potentialDuplicateLeadId === sourceLeadId) {
      await ctx.db.patch(opp._id, {
        potentialDuplicateLeadId: undefined,
        updatedAt: now,
      });
    }
  }

  // --- Step 7: Create audit record ---
  await ctx.db.insert("leadMergeHistory", {
    tenantId,
    sourceLeadId,
    targetLeadId,
    mergedByUserId: userId,
    identifiersMoved,
    opportunitiesMoved: sourceOpportunities.length,
    createdAt: now,
  });

  console.log("[Leads:Merge] executeMerge completed", {
    sourceLeadId,
    targetLeadId,
    identifiersMoved,
    opportunitiesMoved: sourceOpportunities.length,
    mergedBy: userId,
  });
}
```

**Key implementation notes:**

- **Atomicity**: All 8 steps run inside a single Convex mutation transaction. If any step throws, the entire transaction rolls back — no partial merges.
- **Identifier provenance**: Source identifiers are *deleted* and *recreated* on the target with `source: "merge"` rather than patching `leadId` on the existing records. This gives a clean audit trail: every identifier record shows where it came from (`"calendly_booking"`, `"manual_entry"`, or `"merge"`). The cost is more writes during the merge, but merges are rare operations (not hot-path).
- **Duplicate detection**: The `targetIdSet` prevents creating duplicate identifier records. If the source has an email `alice@example.com` and the target already has the same email, the source record is deleted but no new record is created on the target. The `identifiersMoved` counter only counts genuinely new identifiers.
- **socialHandles rebuild**: Rather than trying to merge the old `socialHandles` array with new entries, we re-read all target identifiers after the insert/delete operations and rebuild from scratch. This is simpler and guarantees correctness.
- **searchText rebuild**: The `buildLeadSearchText` call uses the spread `{ ...updatedTarget, socialHandles }` to pass the freshly computed social handles (which may differ from what is stored on the target document before the patch).
- **Duplicate flag cleanup (Step 6)**: The `.take(500)` scan of tenant opportunities is a bounded full scan. This is acceptable because: (1) merges are rare operations, (2) most tenants have fewer than 500 opportunities, and (3) this must check opportunities belonging to *any* lead in the tenant (not just source/target). If a tenant grows beyond 500 opportunities, the excess opportunities will not have their flags cleared — document this as a known limitation and address with a dedicated index in a fast-follow if needed.
- **Transaction limits**: The worst case is a merge involving a source with 100 opportunities and 100 identifiers. Document reads: 2 (leads) + 100 (source opps) + 100 (source identifiers) + 100 (target identifiers) + 100 (re-read target identifiers) + 1 (re-read target lead) + 500 (tenant opps scan) = ~903 reads. Document writes: 100 (opp patches) + 100 (identifier deletes) + 100 (identifier inserts) + 1 (target lead patch) + 1 (source lead patch) + N (duplicate flag patches) + 1 (audit insert) = ~303+ writes. This is within Convex's mutation limits (8192 documents read, 8192 documents written) with comfortable headroom. Invoke `convex-performance-audit` after implementation to verify actual byte counts.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leads/merge.ts` | Create | New file with `mergeLead` mutation and `executeMerge` helper |

---

### 3C — `dismissDuplicateFlag` Mutation

**Type:** Backend
**Parallelizable:** Yes — independent of 3A and 3B. Lives in the same file as 3B (`merge.ts`) but is a standalone exported mutation with no shared state.

**What:** Add a `dismissDuplicateFlag` mutation to `convex/leads/merge.ts` that clears the `potentialDuplicateLeadId` field on an opportunity. This is used when an admin reviews a pipeline-detected duplicate flag and determines it is a false positive.

**Why:** Feature E's identity resolution pipeline sets `potentialDuplicateLeadId` when it detects a fuzzy match (same non-public email domain + similar name). This surfaces as a banner on the meeting detail page. When the admin decides the flag is wrong, they need a way to dismiss it without performing a merge.

**Where:**
- `convex/leads/merge.ts` (modify — add to the file created in 3B)

**How:**

**Step 1: Add `dismissDuplicateFlag` mutation after `executeMerge`**

```typescript
// Path: convex/leads/merge.ts (continued, after the executeMerge function)

/**
 * Dismiss the pipeline's potential-duplicate flag on an opportunity.
 * Clears potentialDuplicateLeadId so the banner no longer shows.
 *
 * Admin-only (tenant_master, tenant_admin). Closers should use mergeLead
 * to resolve duplicates, or escalate to an admin to dismiss false positives.
 */
export const dismissDuplicateFlag = mutation({
  args: {
    opportunityId: v.id("opportunities"),
  },
  handler: async (ctx, { opportunityId }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const opportunity = await ctx.db.get(opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }

    await ctx.db.patch(opportunityId, {
      potentialDuplicateLeadId: undefined,
      updatedAt: Date.now(),
    });

    console.log("[Leads:Merge] duplicate flag dismissed", {
      opportunityId,
    });
  },
});
```

**Key implementation notes:**

- This is intentionally simple: one read (opportunity lookup) and one write (patch). No transaction limit concerns.
- The mutation does not verify that `potentialDuplicateLeadId` was set before clearing it. Patching an undefined field to undefined is a no-op in Convex, so this is safe.
- Admin-only because dismissing a duplicate flag is a data quality decision. Closers can resolve duplicates by merging (which also clears the flag). If a closer believes a flag is a false positive, they escalate to an admin.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leads/merge.ts` | Modify | Add `dismissDuplicateFlag` mutation (appended after `executeMerge`) |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/leads/mutations.ts` | Create | 3A |
| `convex/leads/merge.ts` | Create | 3B, 3C |

---

## Notes for Implementer

- **Phase 1 must be deployed first.** This phase depends on the `leadMergeHistory` table, `searchText` field on `leads`, the `search_leads` search index, the `by_tenantId_and_status` index, the `buildLeadSearchText` utility, and lead permissions — all created in Phase 1. If Phase 1 is not deployed, `pnpm tsc --noEmit` will fail on missing types and imports.
- **No dependency on Phase 2.** This phase creates `mutations.ts` and `merge.ts`. Phase 2 creates `queries.ts`. They share no imports and can be developed and deployed independently.
- **`status: undefined` treated as `"active"`.** Leads created before the Phase 1 migration backfill may have `undefined` status. The validation in `executeMerge` checks `source.status === "merged"` (blocking merged leads) and `target.status === "merged"` (blocking merge into merged leads). An `undefined` status passes both checks, which is correct — `undefined` means the lead is active (pre-migration).
- **Post-implementation: invoke `convex-performance-audit`.** The `executeMerge` helper reads/writes many documents in a single transaction. After implementation, run a performance audit to verify the actual byte counts and confirm the worst-case scenario stays within Convex mutation limits.
- **Step 6 scaling limitation.** The `.take(500)` scan for `potentialDuplicateLeadId` cleanup covers most early-stage tenants. If a tenant exceeds 500 opportunities, document flags on opportunity #501+ will not be cleared during merge. This is a known, low-priority limitation — add a `by_tenantId_and_potentialDuplicateLeadId` index as a fast-follow if any tenant reaches this scale.
- **Function references.** After deployment, the client calls these as `api.leads.mutations.updateLead`, `api.leads.merge.mergeLead`, and `api.leads.merge.dismissDuplicateFlag` (Convex file-based routing from `convex/leads/mutations.ts` and `convex/leads/merge.ts`).
