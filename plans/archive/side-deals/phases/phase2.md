# Phase 2 - Backend: Opportunity Creation & Lifecycle Mutations

**Goal:** Ship the backend API for first-class opportunities and side deals: shared lead identity resolution, idempotent manual opportunity creation, side-deal payment/lost mutations, and role-scoped list/search queries. After this phase, the feature can be exercised from the Convex dashboard without any new UI.

**Prerequisite:** Phase 1 widened schema is deployed, generated Convex types include `source`, `latestActivityAt`, `manualCreationKey`, and side-deal payment origins, and the Phase 1 runtime writer sweep is complete.

**Runs in PARALLEL with:** Phase 3 can build route shells and table components against planned row types after 2E signatures stabilize, but full integration waits for this phase. Internally, 2B, 2D, 2E, and 2F can run in parallel after 2A lands.

**Skills to invoke:**
- `convex-performance-audit` - verify all list/search paths use bounded, indexed reads and never paginate then filter.
- `convex-dev-workos-authkit` - verify every public query/mutation derives tenant/user context through `requireTenantUser`.
- `convex-migration-helper` - read-only guardrail: confirm no new required schema fields are introduced in this phase.

---

## Acceptance Criteria

1. `api.opportunities.createManual.createManual` creates exactly one `source: "side_deal"` opportunity per stable `clientRequestId`; retries return the existing opportunity id.
2. A closer caller cannot assign an opportunity to any user except self.
3. A tenant admin/master caller must provide `assignedCloserId`, and that user must belong to the same tenant, have role `closer`, and not be inactive.
4. New-lead creation writes a lead, lead identifiers with `source: "side_deal"`, search text, lead aggregate, tenant lead stats, and an `opportunity.created` event.
5. Existing-lead creation attaches to the selected lead, or follows `mergedIntoLeadId` to the surviving lead when a merged lead id is passed.
6. `api.sideDeals.logPayment.logPayment` rejects Calendly-sourced opportunities, records payment rows with no `meetingId`, transitions only valid in-progress side-deal opportunities to `payment_received`, converts the lead to a customer, updates aggregates/stats, and emits payment/opportunity events.
7. `api.sideDeals.markLost.markLost` rejects Calendly-sourced opportunities, enforces assigned-closer ownership for closers, and updates active/lost counters exactly once.
8. `api.opportunities.listQueries.listOpportunities` returns paginated rows scoped to tenant and role; closers only see rows where `assignedCloserId === viewerUserId`.
9. `api.opportunities.listQueries.searchOpportunities` returns bounded enriched results and honors the same source/status/period/closer filters as list mode.
10. `api.leads.queries.searchLeadsForPicker`, `api.leads.queries.getLeadForPicker`, and `api.users.queries.listActiveClosers` are available for Phase 4 forms with tenant-safe, bounded results.
11. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
2A (shared validators + identity extraction - BLOCKER) ───────────────┐
                                                                     │
              ┌──────────────────────────────────────────────────────┘
              │
              ├── 2B (createManual mutation) ───────────────┐
              │                                             │
              ├── 2C (sideDeals.logPayment + markLost) ─────┤
              │                                             ├── 2G (backend QA)
              ├── 2D (list/search opportunity queries) ─────┤
              │                                             │
              └── 2E (lead/closer picker queries) ──────────┘
```

**Optimal execution:**
1. Start **2A** first. It extracts lead identity resolution and defines shared validators/types used by all writers.
2. Once 2A merges, run **2B, 2C, 2D, and 2E in parallel**. They own separate module directories (`opportunities/`, `sideDeals/`, `leads/`, `users/`).
3. Run **2G** as a single integration gate: `npx convex dev`, dashboard function calls, direct `rg` sweep for unbounded reads and authorization mistakes, then `pnpm tsc --noEmit`.

**Estimated time:** 2-3 days solo, or 1.25-1.5 days with four parallel backend streams after 2A.

---

## Subphases

### 2A - Shared Validators + Lead Identity Resolution

**Type:** Backend
**Parallelizable:** No - create/payment/list flows depend on shared source validators and a single identity resolver.

**What:** Extract lead matching/creation from `convex/pipeline/inviteeCreated.ts` into a shared helper and add opportunity-side validators.

**Why:** Manual side-deal creation must reuse the same exact lead de-duplication and identifier writes as Calendly bookings. A second copy would drift and produce duplicate leads.

**Where:**
- `convex/leads/identityResolution.ts` (new)
- `convex/pipeline/inviteeCreated.ts` (modify)
- `convex/opportunities/validators.ts` (new)

**How:**

**Step 1: Create shared validators for new lead input and filters.**

```typescript
// Path: convex/opportunities/validators.ts
import { v } from "convex/values";

export const opportunitySourceValidator = v.union(
  v.literal("calendly"),
  v.literal("side_deal"),
);

export const opportunityStatusValidator = v.union(
  v.literal("scheduled"),
  v.literal("in_progress"),
  v.literal("meeting_overran"),
  v.literal("payment_received"),
  v.literal("follow_up_scheduled"),
  v.literal("reschedule_link_sent"),
  v.literal("lost"),
  v.literal("canceled"),
  v.literal("no_show"),
);

export const periodFilterValidator = v.optional(
  v.union(
    v.literal("today"),
    v.literal("this_week"),
    v.literal("this_month"),
  ),
);

export const socialHandleValidator = v.object({
  platform: v.union(
    v.literal("instagram"),
    v.literal("tiktok"),
    v.literal("twitter"),
    v.literal("facebook"),
    v.literal("linkedin"),
    v.literal("other_social"),
  ),
  handle: v.string(),
});

export const newLeadInputValidator = v.object({
  fullName: v.string(),
  email: v.string(),
  phone: v.optional(v.string()),
  socialHandle: v.optional(socialHandleValidator),
});
```

**Step 2: Extract identity resolution with a narrow public helper API.**

```typescript
// Path: convex/leads/identityResolution.ts
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { insertLeadAggregate } from "../reporting/writeHooks";
import { updateTenantStats } from "../lib/tenantStatsHelper";
import { buildLeadSearchText } from "./searchTextBuilder";

type IdentifierSource = "calendly_booking" | "manual_entry" | "merge" | "side_deal";

export type ResolveLeadIdentityArgs = {
  tenantId: Id<"tenants">;
  fullName?: string;
  email: string;
  phone?: string;
  socialHandle?: {
    platform: "instagram" | "tiktok" | "twitter" | "facebook" | "linkedin" | "other_social";
    handle: string;
  };
  identifierSource: IdentifierSource;
  createdAt: number;
};

export type ResolveLeadIdentityResult = {
  leadId: Id<"leads">;
  created: boolean;
};

export async function resolveLeadIdentity(
  ctx: MutationCtx,
  args: ResolveLeadIdentityArgs,
): Promise<ResolveLeadIdentityResult> {
  const normalizedEmail = args.email.trim().toLowerCase();
  if (!normalizedEmail) {
    throw new Error("Email is required for new leads in MVP.");
  }

  const existingByEmail = await ctx.db
    .query("leadIdentifiers")
    .withIndex("by_tenantId_and_type_and_value", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .eq("type", "email")
        .eq("value", normalizedEmail),
    )
    .first();

  if (existingByEmail) {
    const existingLead = await ctx.db.get(existingByEmail.leadId);
    if (existingLead && existingLead.tenantId === args.tenantId) {
      if (existingLead.status === "merged" && existingLead.mergedIntoLeadId) {
        const target = await ctx.db.get(existingLead.mergedIntoLeadId);
        if (target && target.tenantId === args.tenantId && target.status !== "merged") {
          return { leadId: target._id, created: false };
        }
      }
      return { leadId: existingLead._id, created: false };
    }
  }

  const leadId = await ctx.db.insert("leads", {
    tenantId: args.tenantId,
    fullName: args.fullName?.trim() || normalizedEmail,
    email: normalizedEmail,
    phone: args.phone?.trim() || undefined,
    status: "active",
    firstSeenAt: args.createdAt,
    lastSeenAt: args.createdAt,
    createdAt: args.createdAt,
    updatedAt: args.createdAt,
    searchText: buildLeadSearchText({
      fullName: args.fullName,
      email: normalizedEmail,
      phone: args.phone,
      socialHandles: args.socialHandle
        ? [{ type: args.socialHandle.platform, handle: args.socialHandle.handle }]
        : undefined,
    }),
  });

  await ctx.db.insert("leadIdentifiers", {
    tenantId: args.tenantId,
    leadId,
    type: "email",
    value: normalizedEmail,
    rawValue: args.email,
    source: args.identifierSource,
    confidence: "verified",
    createdAt: args.createdAt,
  });

  await insertLeadAggregate(ctx, leadId);
  await updateTenantStats(ctx, args.tenantId, { totalLeads: 1 });

  return { leadId, created: true };
}
```

**Step 3: Replace the equivalent Calendly logic with the helper.**

```typescript
// Path: convex/pipeline/inviteeCreated.ts
import { resolveLeadIdentity } from "../leads/identityResolution";

const identity = await resolveLeadIdentity(ctx, {
  tenantId,
  fullName: inviteeName,
  email: inviteeEmail,
  phone: extractedPhone,
  socialHandle: extractedSocialHandle,
  identifierSource: "calendly_booking",
  createdAt: now,
});
const leadId = identity.leadId;
```

**Key implementation notes:**
- The snippet above is the target shape, not a blind replacement. `inviteeCreated.ts` currently contains potential-duplicate and form-field extraction logic; preserve those decisions while extracting only the reusable exact-match identity core.
- `resolveLeadIdentity` must not emit domain events. Calendly and manual callers have different event sources and metadata.
- `buildLeadSearchText` currently exists in `convex/leads/searchTextBuilder.ts`; reuse it rather than duplicating text concatenation rules.
- MVP keeps email required. Do not widen `leads.email` or `customers.email` here.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leads/identityResolution.ts` | Create | Shared exact-match lead resolver and creator. |
| `convex/pipeline/inviteeCreated.ts` | Modify | Reuse shared resolver; preserve Calendly-specific extraction and duplicate heuristics. |
| `convex/opportunities/validators.ts` | Create | Shared source/status/filter/new-lead validators. |

---

### 2B - Idempotent Manual Opportunity Creation

**Type:** Backend
**Parallelizable:** Yes - depends on 2A, independent of payment/list/picker work.

**What:** Create `api.opportunities.createManual.createManual`.

**Why:** This is the entry point for `/workspace/opportunities/new`. It resolves an existing or new lead, assigns a closer, inserts a side-deal opportunity, updates reporting/stats, and emits audit events.

**Where:**
- `convex/opportunities/createManual.ts` (new)

**How:**

**Step 1: Implement validation, idempotency, and role-scoped closer assignment.**

```typescript
// Path: convex/opportunities/createManual.ts
import { v } from "convex/values";
import { mutation } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { resolveLeadIdentity } from "../leads/identityResolution";
import { updateTenantStats } from "../lib/tenantStatsHelper";
import { emitDomainEvent } from "../lib/domainEvents";
import { insertOpportunityAggregate } from "../reporting/writeHooks";
import { newLeadInputValidator } from "./validators";

export const createManual = mutation({
  args: {
    clientRequestId: v.string(),
    existingLeadId: v.optional(v.id("leads")),
    newLeadInput: v.optional(newLeadInputValidator),
    assignedCloserId: v.optional(v.id("users")),
    notes: v.optional(v.string()),
  },
  returns: v.object({
    opportunityId: v.id("opportunities"),
    leadId: v.id("leads"),
    leadWasCreated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);
    const now = Date.now();
    const isAdmin = role === "tenant_master" || role === "tenant_admin";
    const manualCreationKey = args.clientRequestId.trim();

    if (!manualCreationKey || manualCreationKey.length > 100) {
      throw new Error("Invalid creation request ID.");
    }

    const existingByRequest = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_manualCreationKey", (q) =>
        q.eq("tenantId", tenantId).eq("manualCreationKey", manualCreationKey),
      )
      .unique();
    if (existingByRequest) {
      return {
        opportunityId: existingByRequest._id,
        leadId: existingByRequest.leadId,
        leadWasCreated: false,
      };
    }

    const hasExistingLead = args.existingLeadId !== undefined;
    const hasNewLeadInput = args.newLeadInput !== undefined;
    if (hasExistingLead === hasNewLeadInput) {
      throw new Error("Provide either existingLeadId or newLeadInput, not both or neither.");
    }

    let assignedCloserId: Id<"users">;
    if (isAdmin) {
      if (!args.assignedCloserId) {
        throw new Error("Pick an active closer before creating an opportunity.");
      }
      const closer = await ctx.db.get(args.assignedCloserId);
      if (
        !closer ||
        closer.tenantId !== tenantId ||
        closer.role !== "closer" ||
        closer.isActive === false
      ) {
        throw new Error("Assigned closer not found or inactive in this tenant.");
      }
      assignedCloserId = closer._id;
    } else {
      if (args.assignedCloserId && args.assignedCloserId !== userId) {
        throw new Error("Only admins can create opportunities on behalf of another closer.");
      }
      assignedCloserId = userId;
    }

    const { leadId, leadWasCreated } = await resolveLeadForManualCreate(ctx, {
      tenantId,
      existingLeadId: args.existingLeadId,
      newLeadInput: args.newLeadInput,
      now,
    });

    const opportunityId = await ctx.db.insert("opportunities", {
      tenantId,
      leadId,
      assignedCloserId,
      status: "in_progress",
      source: "side_deal",
      manualCreationKey,
      notes: args.notes?.trim() || undefined,
      createdAt: now,
      updatedAt: now,
      latestActivityAt: now,
    });

    await insertOpportunityAggregate(ctx, opportunityId);
    await updateTenantStats(ctx, tenantId, {
      totalOpportunities: 1,
      activeOpportunities: 1,
    });

    if (leadWasCreated) {
      await emitDomainEvent(ctx, {
        tenantId,
        entityType: "lead",
        entityId: leadId,
        eventType: "lead.created",
        source: isAdmin ? "admin" : "closer",
        actorUserId: userId,
        occurredAt: now,
        metadata: { source: "side_deal" },
      });
    }

    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "opportunity",
      entityId: opportunityId,
      eventType: "opportunity.created",
      source: isAdmin ? "admin" : "closer",
      actorUserId: userId,
      toStatus: "in_progress",
      occurredAt: now,
      metadata: { source: "side_deal", assignedCloserId },
    });

    return { opportunityId, leadId, leadWasCreated };
  },
});
```

**Step 2: Add a private helper for existing/new lead XOR resolution.**

```typescript
// Path: convex/opportunities/createManual.ts
async function resolveLeadForManualCreate(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    existingLeadId?: Id<"leads">;
    newLeadInput?: {
      fullName: string;
      email: string;
      phone?: string;
      socialHandle?: {
        platform: "instagram" | "tiktok" | "twitter" | "facebook" | "linkedin" | "other_social";
        handle: string;
      };
    };
    now: number;
  },
): Promise<{ leadId: Id<"leads">; leadWasCreated: boolean }> {
  if (args.existingLeadId) {
    const lead = await ctx.db.get(args.existingLeadId);
    if (!lead || lead.tenantId !== args.tenantId) {
      throw new Error("Selected lead not found.");
    }
    if (lead.status === "merged" && lead.mergedIntoLeadId) {
      const target = await ctx.db.get(lead.mergedIntoLeadId);
      if (!target || target.tenantId !== args.tenantId || target.status === "merged") {
        throw new Error("Selected lead has been merged but the target lead is unavailable.");
      }
      return { leadId: target._id, leadWasCreated: false };
    }
    return { leadId: lead._id, leadWasCreated: false };
  }

  const result = await resolveLeadIdentity(ctx, {
    tenantId: args.tenantId,
    fullName: args.newLeadInput!.fullName,
    email: args.newLeadInput!.email,
    phone: args.newLeadInput!.phone,
    socialHandle: args.newLeadInput!.socialHandle,
    identifierSource: "side_deal",
    createdAt: args.now,
  });
  return { leadId: result.leadId, leadWasCreated: result.created };
}
```

**Key implementation notes:**
- Do not use a client-supplied tenant id. `tenantId` comes only from `requireTenantUser`.
- Keep `manualCreationKey` collision scoped by tenant. The same request id in another tenant is unrelated.
- `createManual` intentionally creates no meeting and no payment.
- Use `MutationCtx` for the helper context. Do not use untyped `any` or internal Convex function properties.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/opportunities/createManual.ts` | Create | Public idempotent mutation for manual side-deal opportunity creation. |

---

### 2C - Side-Deal Payment + Lost Mutations

**Type:** Backend
**Parallelizable:** Yes - depends on 1B/2A and is independent of list/search work.

**What:** Create `api.sideDeals.logPayment.logPayment` and `api.sideDeals.markLost.markLost`.

**Why:** Side-deal opportunities are finalized from the detail page by recording a payment or marking the opportunity lost. Both paths must reuse existing payment/customer/reporting helpers instead of creating a parallel pipeline.

**Where:**
- `convex/sideDeals/logPayment.ts` (new)
- `convex/sideDeals/markLost.ts` (new)

**How:**

**Step 1: Implement side-deal payment logging.**

```typescript
// Path: convex/sideDeals/logPayment.ts
import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { executeConversion } from "../customers/conversion";
import { emitDomainEvent } from "../lib/domainEvents";
import { toAmountMinor, validateCurrency } from "../lib/formatMoney";
import { patchOpportunityLifecycle } from "../lib/opportunityActivity";
import {
  assertPaymentRow,
  resolveProgramForWrite,
  syncCustomerPaymentSummary,
  type CommissionableOrigin,
} from "../lib/paymentHelpers";
import { paymentTypeValidator, resolvePaymentType } from "../lib/paymentTypes";
import { isSideDeal } from "../lib/sideDeals";
import { validateTransition } from "../lib/statusTransitions";
import { applyPaymentStatsDelta, isActiveOpportunityStatus } from "../lib/tenantStatsHelper";
import { insertPaymentAggregate, replacePaymentAggregate } from "../reporting/writeHooks";

export const logPayment = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    amount: v.number(),
    currency: v.string(),
    programId: v.id("tenantPrograms"),
    paymentType: paymentTypeValidator,
    proofFileId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);
    const now = Date.now();
    const isAdmin = role === "tenant_master" || role === "tenant_admin";

    const opportunity = await ctx.db.get(args.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) throw new Error("Opportunity not found.");
    if (!isSideDeal(opportunity)) throw new Error("This mutation only accepts side-deal opportunities.");
    if (!isAdmin && opportunity.assignedCloserId !== userId) throw new Error("You are not the assigned closer for this opportunity.");
    if (!validateTransition(opportunity.status, "payment_received")) {
      throw new Error(`Opportunity status '${opportunity.status}' cannot transition to 'payment_received'.`);
    }
    if (args.amount <= 0) throw new Error("Payment amount must be greater than zero.");
    if (!opportunity.assignedCloserId) throw new Error("Opportunity must be assigned to a closer before payment.");

    const currency = validateCurrency(args.currency);
    const amountMinor = toAmountMinor(args.amount);
    const program = await resolveProgramForWrite(ctx, tenantId, args.programId);
    const paymentType = resolvePaymentType(args.paymentType);
    const origin: CommissionableOrigin = isAdmin ? "admin_side_deal" : "closer_side_deal";

    assertPaymentRow({
      tenantId,
      commissionable: true,
      attributedCloserId: opportunity.assignedCloserId,
      recordedByUserId: userId,
      origin,
      contextType: "opportunity",
      opportunityId: args.opportunityId,
      customerId: undefined,
      programId: program._id,
      paymentType,
    });

    const paymentId = await ctx.db.insert("paymentRecords", {
      tenantId,
      opportunityId: args.opportunityId,
      meetingId: undefined,
      attributedCloserId: opportunity.assignedCloserId,
      recordedByUserId: userId,
      commissionable: true,
      amountMinor,
      currency,
      programId: program._id,
      programName: program.name,
      paymentType,
      proofFileId: args.proofFileId ?? undefined,
      status: "recorded",
      statusChangedAt: now,
      recordedAt: now,
      contextType: "opportunity",
      origin,
    });

    const paymentBeforeCustomerLink = await insertPaymentAggregate(ctx, paymentId);
    await patchOpportunityLifecycle(ctx, args.opportunityId, {
      status: "payment_received",
      paymentReceivedAt: now,
      updatedAt: now,
    });
    await applyPaymentStatsDelta(ctx, tenantId, {
      commissionable: true,
      paymentType,
      amountMinorDelta: amountMinor,
      wonDealDelta: 1,
      activeOpportunityDelta: isActiveOpportunityStatus(opportunity.status) ? -1 : 0,
    });

    const customerId = await executeConversion(ctx, {
      tenantId,
      leadId: opportunity.leadId,
      convertedByUserId: userId,
      winningOpportunityId: args.opportunityId,
      winningMeetingId: undefined,
    });
    if (customerId) {
      await ctx.db.patch(paymentId, { customerId });
      await replacePaymentAggregate(ctx, paymentBeforeCustomerLink, paymentId);
      await syncCustomerPaymentSummary(ctx, customerId);
    }

    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "payment",
      entityId: paymentId,
      eventType: "payment.recorded",
      source: isAdmin ? "admin" : "closer",
      actorUserId: userId,
      occurredAt: now,
      metadata: { opportunityId: args.opportunityId, amountMinor, currency, programId: program._id, paymentType, origin, sideDeal: true },
    });

    return { paymentId, customerId: customerId ?? undefined };
  },
});
```

**Step 2: Implement side-deal mark-lost.**

```typescript
// Path: convex/sideDeals/markLost.ts
import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { emitDomainEvent } from "../lib/domainEvents";
import { patchOpportunityLifecycle } from "../lib/opportunityActivity";
import { isSideDeal } from "../lib/sideDeals";
import { validateTransition } from "../lib/statusTransitions";
import { isActiveOpportunityStatus, updateTenantStats } from "../lib/tenantStatsHelper";

export const markLost = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    reason: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { opportunityId, reason }) => {
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);
    const now = Date.now();
    const isAdmin = role === "tenant_master" || role === "tenant_admin";

    const opportunity = await ctx.db.get(opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) throw new Error("Opportunity not found.");
    if (!isSideDeal(opportunity)) throw new Error("This mutation only accepts side-deal opportunities.");
    if (!isAdmin && opportunity.assignedCloserId !== userId) throw new Error("You are not the assigned closer for this opportunity.");
    if (!validateTransition(opportunity.status, "lost")) {
      throw new Error(`Opportunity status '${opportunity.status}' cannot transition to 'lost'.`);
    }

    const trimmed = reason?.trim() || undefined;
    await patchOpportunityLifecycle(ctx, opportunityId, {
      status: "lost",
      lostAt: now,
      lostByUserId: userId,
      lostReason: trimmed,
      updatedAt: now,
    });
    await updateTenantStats(ctx, tenantId, {
      activeOpportunities: isActiveOpportunityStatus(opportunity.status) ? -1 : 0,
      lostDeals: 1,
    });
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "opportunity",
      entityId: opportunityId,
      eventType: "opportunity.marked_lost",
      source: isAdmin ? "admin" : "closer",
      actorUserId: userId,
      fromStatus: opportunity.status,
      toStatus: "lost",
      reason: trimmed,
      occurredAt: now,
    });
    return null;
  },
});
```

**Key implementation notes:**
- `logPayment` must never accept `meetingId`. A side deal has no meeting.
- Keep `closer.payments.logPayment` meeting-required and Calendly-specific.
- If `executeConversion` returns `null`, add the existing-customer fallback from `convex/closer/payments.ts` so the payment still receives `customerId`.
- If `customerId` is patched after conversion, call `replacePaymentAggregate` with the pre-patch payment row. Current aggregates do not group by customer, but this keeps the write hook contract correct if reporting dimensions expand.
- Phase 7 will extend both mutations to expire stale nudges. Do not add Phase 7 schema literals in this phase.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/sideDeals/logPayment.ts` | Create | Payment insert, opportunity transition, customer conversion, reporting events. |
| `convex/sideDeals/markLost.ts` | Create | Lost transition, stats, audit event. |

---

### 2D - Opportunities List + Search Queries

**Type:** Backend
**Parallelizable:** Yes - depends on Phase 1 indexes but is independent of create/payment mutations.

**What:** Create `api.opportunities.listQueries.listOpportunities` and `api.opportunities.listQueries.searchOpportunities`.

**Why:** The Phase 3 list page needs one shared route for admins and closers. Query scoping must be server-side so closers cannot see other closers' opportunities by changing filters.

**Where:**
- `convex/opportunities/listQueries.ts` (new)

**How:**

**Step 1: Implement role-scoped filters and period calculation.**

```typescript
// Path: convex/opportunities/listQueries.ts
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { normalizeOpportunitySource } from "../lib/sideDeals";
import {
  opportunitySourceValidator,
  opportunityStatusValidator,
  periodFilterValidator,
} from "./validators";

export const listOpportunities = query({
  args: {
    paginationOpts: paginationOptsValidator,
    statusFilter: v.optional(opportunityStatusValidator),
    sourceFilter: v.optional(opportunitySourceValidator),
    periodFilter: periodFilterValidator,
    closerFilter: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);
    const isAdmin = role === "tenant_master" || role === "tenant_admin";
    const effectiveCloserId = isAdmin ? args.closerFilter : userId;
    const { periodStart, periodEnd } = resolvePeriod(args.periodFilter);

    const result = await buildOpportunityListQuery(ctx, {
      tenantId,
      closerId: effectiveCloserId,
      status: args.statusFilter,
      source: args.sourceFilter,
      periodStart,
      periodEnd,
    })
      .order("desc")
      .paginate(args.paginationOpts);

    return {
      ...result,
      page: await enrichOpportunityRows(ctx, result.page),
    };
  },
});
```

**Step 2: Implement search through the existing leads search index.**

```typescript
// Path: convex/opportunities/listQueries.ts
export const searchOpportunities = query({
  args: {
    searchTerm: v.string(),
    statusFilter: v.optional(opportunityStatusValidator),
    sourceFilter: v.optional(opportunitySourceValidator),
    periodFilter: periodFilterValidator,
    closerFilter: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);
    const isAdmin = role === "tenant_master" || role === "tenant_admin";
    const effectiveCloserId = isAdmin ? args.closerFilter : userId;
    const term = args.searchTerm.trim();
    if (term.length < 2) return [];

    const matchingLeads = await ctx.db
      .query("leads")
      .withSearchIndex("search_leads", (q) =>
        q.search("searchText", term).eq("tenantId", tenantId),
      )
      .take(25);

    const rowsNested = await Promise.all(
      matchingLeads.map((lead) =>
        ctx.db
          .query("opportunities")
          .withIndex("by_tenantId_and_leadId", (q) =>
            q.eq("tenantId", tenantId).eq("leadId", lead._id),
          )
          .take(10),
      ),
    );

    const { periodStart, periodEnd } = resolvePeriod(args.periodFilter);
    const filtered = rowsNested.flat().filter((opportunity) => {
      if (effectiveCloserId && opportunity.assignedCloserId !== effectiveCloserId) return false;
      if (args.statusFilter && opportunity.status !== args.statusFilter) return false;
      if (args.sourceFilter && normalizeOpportunitySource(opportunity) !== args.sourceFilter) return false;
      const activity = opportunity.latestActivityAt ?? opportunity.updatedAt;
      if (periodStart !== undefined && activity < periodStart) return false;
      if (periodEnd !== undefined && activity >= periodEnd) return false;
      return true;
    });

    return await enrichOpportunityRows(ctx, filtered.slice(0, 50));
  },
});
```

**Step 3: Add query builder and enrichment helpers.**

```typescript
// Path: convex/opportunities/listQueries.ts
function buildOpportunityListQuery(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    closerId?: Id<"users">;
    status?: Doc<"opportunities">["status"];
    source?: "calendly" | "side_deal";
    periodStart?: number;
    periodEnd?: number;
  },
) {
  const withRange = (q: any) => {
    let next = q;
    if (args.periodStart !== undefined) next = next.gte("latestActivityAt", args.periodStart);
    if (args.periodEnd !== undefined) next = next.lt("latestActivityAt", args.periodEnd);
    return next;
  };

  if (args.closerId && args.source && args.status) {
    return ctx.db.query("opportunities").withIndex(
      "by_tenantId_and_assignedCloserId_and_source_and_status_and_latestActivityAt",
      (q) => withRange(q.eq("tenantId", args.tenantId).eq("assignedCloserId", args.closerId!).eq("source", args.source!).eq("status", args.status!)),
    );
  }
  if (args.closerId && args.source) {
    return ctx.db.query("opportunities").withIndex(
      "by_tenantId_and_assignedCloserId_and_source_and_latestActivityAt",
      (q) => withRange(q.eq("tenantId", args.tenantId).eq("assignedCloserId", args.closerId!).eq("source", args.source!)),
    );
  }
  if (args.closerId && args.status) {
    return ctx.db.query("opportunities").withIndex(
      "by_tenantId_and_assignedCloserId_and_status_and_latestActivityAt",
      (q) => withRange(q.eq("tenantId", args.tenantId).eq("assignedCloserId", args.closerId!).eq("status", args.status!)),
    );
  }
  if (args.closerId) {
    return ctx.db.query("opportunities").withIndex(
      "by_tenantId_and_assignedCloserId_and_latestActivityAt",
      (q) => withRange(q.eq("tenantId", args.tenantId).eq("assignedCloserId", args.closerId!)),
    );
  }
  if (args.source && args.status) {
    return ctx.db.query("opportunities").withIndex(
      "by_tenantId_and_source_and_status_and_latestActivityAt",
      (q) => withRange(q.eq("tenantId", args.tenantId).eq("source", args.source!).eq("status", args.status!)),
    );
  }
  if (args.source) {
    return ctx.db.query("opportunities").withIndex(
      "by_tenantId_and_source_and_latestActivityAt",
      (q) => withRange(q.eq("tenantId", args.tenantId).eq("source", args.source!)),
    );
  }
  if (args.status) {
    return ctx.db.query("opportunities").withIndex(
      "by_tenantId_and_status_and_latestActivityAt",
      (q) => withRange(q.eq("tenantId", args.tenantId).eq("status", args.status!)),
    );
  }
  return ctx.db.query("opportunities").withIndex(
    "by_tenantId_and_latestActivityAt",
    (q) => withRange(q.eq("tenantId", args.tenantId)),
  );
}
```

**Key implementation notes:**
- The query builder uses a small `any` escape because Convex's indexed query builder type changes after each chained equality/range. Keep it local and documented; do not leak `any` into returned row types.
- Do not use `.filter()` on Convex queries. Search result filtering happens after bounded search/lead lookups only.
- Search is capped and not paginated in MVP. List mode is the paginated path.
- Use `latestActivityAt` indexes, not existing `createdAt` indexes.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/opportunities/listQueries.ts` | Create | Shared paginated list and bounded search queries for Phase 3. |

---

### 2E - Picker Support Queries

**Type:** Backend
**Parallelizable:** Yes - supports Phase 4 and touches only `leads/queries.ts` and `users/queries.ts`.

**What:** Add lightweight picker queries for lead combobox and closer select.

**Why:** The create page needs result shapes smaller and broader than the normal Leads page: include active and converted leads, chase merged leads, and list only active closers for admin assignment.

**Where:**
- `convex/leads/queries.ts` (modify)
- `convex/users/queries.ts` (modify)

**How:**

**Step 1: Add lead picker result type and `getLeadForPicker`.**

```typescript
// Path: convex/leads/queries.ts
export const getLeadForPicker = query({
  args: { leadId: v.id("leads") },
  handler: async (ctx, { leadId }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);
    const lead = await ctx.db.get(leadId);
    if (!lead || lead.tenantId !== tenantId) return null;
    if (lead.status === "merged" && lead.mergedIntoLeadId) {
      const target = await ctx.db.get(lead.mergedIntoLeadId);
      if (!target || target.tenantId !== tenantId) return null;
      return {
        _id: target._id,
        fullName: target.fullName,
        email: target.email,
        phone: target.phone,
        status: target.status,
      };
    }
    return {
      _id: lead._id,
      fullName: lead.fullName,
      email: lead.email,
      phone: lead.phone,
      status: lead.status,
    };
  },
});
```

**Step 2: Add bounded search for the combobox.**

```typescript
// Path: convex/leads/queries.ts
export const searchLeadsForPicker = query({
  args: { searchTerm: v.string() },
  handler: async (ctx, { searchTerm }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);
    const term = searchTerm.trim();
    if (term.length < 2) return [];

    const results = await ctx.db
      .query("leads")
      .withSearchIndex("search_leads", (q) =>
        q.search("searchText", term).eq("tenantId", tenantId),
      )
      .take(20);

    return results.map((lead) => ({
      _id: lead._id,
      fullName: lead.fullName,
      email: lead.email,
      phone: lead.phone,
      status: lead.status,
    }));
  },
});
```

**Step 3: Add active closer list for admin assignment.**

```typescript
// Path: convex/users/queries.ts
export const listActiveClosers = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const users = await ctx.db
      .query("users")
      .withIndex("by_tenantId_and_isActive", (q) =>
        q.eq("tenantId", tenantId).eq("isActive", true),
      )
      .take(200);

    return users
      .filter((user) => user.role === "closer")
      .map((user) => ({
        _id: user._id,
        fullName: user.fullName,
        email: user.email,
      }));
  },
});
```

**Key implementation notes:**
- `listActiveClosers` filters role in memory after indexed tenant/isActive read. This is acceptable because users per tenant are bounded by business reality and `.take(200)` is explicit.
- Do not reuse `listTeamMembers` for the create form. It includes inactive users and invite state that the picker must not allow.
- `searchLeadsForPicker` includes converted leads; side deals can attach to an existing customer lead and add another payment.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leads/queries.ts` | Modify | Add `getLeadForPicker` and `searchLeadsForPicker`. |
| `convex/users/queries.ts` | Modify | Add admin-only `listActiveClosers`. |

---

### 2G - Backend QA Gate

**Type:** Manual / Backend
**Parallelizable:** No - runs after all backend streams are merged.

**What:** Validate generated API references, authorization, idempotency, counters, and query behavior before frontend integration starts.

**Why:** Later phases will assume these function signatures and invariants. Catching backend drift after UI work begins causes unnecessary rework.

**Where:**
- Convex dashboard function runner (manual)
- Terminal checks

**How:**

**Step 1: Regenerate and typecheck.**

```bash
# Path: repo root
npx convex dev
pnpm tsc --noEmit
```

**Step 2: Sweep for unsafe Convex reads and auth gaps.**

```bash
# Path: repo root
rg -n "\\.filter\\(|\\.collect\\(\\)|requireTenantUser|ctx\\.auth\\.getUserIdentity" convex/opportunities convex/sideDeals convex/leads/identityResolution.ts
```

**Step 3: Dashboard smoke tests.**

```typescript
// Path: Convex dashboard function runner
// 1. createManual with newLeadInput -> returns { opportunityId, leadId, leadWasCreated: true }
// 2. repeat same clientRequestId -> returns same opportunityId
// 3. logPayment on that opportunity -> returns { paymentId, customerId? }
// 4. listOpportunities sourceFilter side_deal -> shows row
// 5. searchOpportunities by lead email -> shows row
```

**Key implementation notes:**
- Record exact function runner payloads in the phase PR for reproducibility.
- Verify tenant stats manually for create/payment/lost paths on a disposable dev tenant.
- If any helper name differs from this plan after implementation, update this phase doc before closing the phase.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| None | Manual | Dashboard and terminal verification only. |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/opportunities/validators.ts` | Create | 2A |
| `convex/leads/identityResolution.ts` | Create | 2A |
| `convex/pipeline/inviteeCreated.ts` | Modify | 2A |
| `convex/opportunities/createManual.ts` | Create | 2B |
| `convex/sideDeals/logPayment.ts` | Create | 2C |
| `convex/sideDeals/markLost.ts` | Create | 2C |
| `convex/opportunities/listQueries.ts` | Create | 2D |
| `convex/leads/queries.ts` | Modify | 2E |
| `convex/users/queries.ts` | Modify | 2E |
