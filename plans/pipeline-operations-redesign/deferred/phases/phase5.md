# Phase 5 — Copy Auditing and Analytics

**Goal:** Record optional, privacy-bounded copy audit events after successful portal copy actions and define a safe PostHog event policy. After this phase, admins can reason about portal usage without storing full generated URLs, requester IPs, WorkOS user data, or lead data.

**Prerequisite:** Phase 3 copy UI is functional and Phase 2 session token validation is available. Phase 4 event type readiness must prevent invalid portal rows from being copied. New audit tables are safe greenfield additions; use `convex-migration-helper` only if this phase later changes existing required fields.

**Runs in PARALLEL with:** Late Phase 4 after event type readiness contracts settle. It should not block the core portal launch unless audit reporting is a release requirement.

**Skills to invoke:**
- `convex-performance-audit` — Audit-event indexes and validation reads must stay bounded and tenant-scoped.
- `next-best-practices` — Server Actions should validate cookies server-side and avoid leaking session tokens to client state.
- `web-design-guidelines` — Copy feedback should remain accessible after clipboard success or failure.

**Acceptance Criteria:**
1. `convex/schema.ts` defines `linkPortalCopyEvents` with indexes for tenant timeline, DM closer timeline, and event type timeline.
2. Copy audit records include tenant ID, session ID hash, event type config ID, booking program ID, attribution team ID, DM closer ID, campaign preset ID, campaign value, and copy timestamp.
3. Copy audit records never store the full generated URL, raw requester IP, WorkOS user data, lead data, or raw webhook payload data.
4. Copy recording validates the portal session token, current config `sessionVersion`, selected event type, selected DM closer, selected team, and selected campaign all belong to the same tenant.
5. The public client calls copy recording only after `navigator.clipboard.writeText()` succeeds.
6. Copy recording failure does not prevent the user from seeing or manually copying the generated URL.
7. Optional PostHog capture uses `dm_link_copied` and includes only allowed IDs, booleans, and campaign value; it does not include generated URL or raw `utm_source` / `utm_medium`.
8. Admin-facing usage query returns bounded recent copy activity scoped to the authenticated tenant.
9. `npx convex dev --once` passes without schema or function registration errors.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
5A (copy event schema) ──────────────┬── 5B (copy validation mutation)
                                    └── 5D (settings usage query)

5B complete ─────────────────────────→ 5C (public copy action + server action)

5C complete ─────────────────────────→ 5E (client copy integration + PostHog policy)

5D + 5E complete ────────────────────→ 5F (verification)
```

**Optimal execution:**
1. Add schema and regenerate Convex types.
2. Implement internal copy insertion with strict tenant ownership checks.
3. Wire public action and Next.js Server Action.
4. Call the action from the client only after successful clipboard write.
5. Verify no sensitive values are stored or captured.

**Estimated time:** 1-2 days

---

## Subphases

### 5A — Copy Event Schema

**Type:** Backend  
**Parallelizable:** No — generated types are required by all audit functions.

**What:** Add `linkPortalCopyEvents` with compact tenant-scoped audit fields and timeline indexes.

**Why:** Audit data should answer "who copied which canonical link inputs" without retaining the generated Calendly URL or request identity.

**Where:**
- `convex/schema.ts` (modify)

**How:**

**Step 1: Add the audit table.**

```typescript
// Path: convex/schema.ts
linkPortalCopyEvents: defineTable({
  tenantId: v.id("tenants"),
  sessionIdHash: v.string(),
  eventTypeConfigId: v.id("eventTypeConfigs"),
  bookingProgramId: v.id("tenantPrograms"),
  attributionTeamId: v.id("attributionTeams"),
  dmCloserId: v.id("dmClosers"),
  campaignPresetId: v.id("linkPortalCampaignPresets"),
  utmCampaign: v.string(),
  copiedAt: v.number(),
})
  .index("by_tenantId_and_copiedAt", ["tenantId", "copiedAt"])
  .index("by_tenantId_and_dmCloserId_and_copiedAt", [
    "tenantId",
    "dmCloserId",
    "copiedAt",
  ])
  .index("by_tenantId_and_eventTypeConfigId_and_copiedAt", [
    "tenantId",
    "eventTypeConfigId",
    "copiedAt",
  ]),
```

**Step 2: Regenerate types.**

```bash
# Path: /Users/nimbus/dev/ptdom-crm
npx convex dev --once
```

**Key implementation notes:**
- This is a new table, so no migration is needed.
- Do not add indexes that are not required by MVP queries.
- Store `utmCampaign` because campaigns can be renamed; do not store `utmSource` or `utmMedium`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Add copy audit table |
| `convex/_generated/*` | Generate | Updated Convex types |

---

### 5B — Copy Validation Mutation

**Type:** Backend  
**Parallelizable:** Yes — depends on 5A generated types.

**What:** Add an internal mutation that validates selected IDs against the session tenant, derives booking program/team/campaign fields from current database rows, and inserts the audit record.

**Why:** Public clients can send stale or malicious IDs. The audit row must reflect tenant-owned current records, not trusted client values.

**Where:**
- `convex/linkPortal/copyMutations.ts` (create)

**How:**

**Step 1: Validate event type, closer/team, and campaign ownership.**

```typescript
// Path: convex/linkPortal/copyMutations.ts
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

export const insertCopyEvent = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    sessionIdHash: v.string(),
    eventTypeConfigId: v.id("eventTypeConfigs"),
    dmCloserId: v.id("dmClosers"),
    campaignPresetId: v.id("linkPortalCampaignPresets"),
  },
  handler: async (ctx, args) => {
    const [eventTypeConfig, dmCloser, campaign] = await Promise.all([
      ctx.db.get(args.eventTypeConfigId),
      ctx.db.get(args.dmCloserId),
      ctx.db.get(args.campaignPresetId),
    ]);

    if (
      !eventTypeConfig ||
      eventTypeConfig.tenantId !== args.tenantId ||
      eventTypeConfig.linkPortalEnabled !== true ||
      !eventTypeConfig.bookingProgramId ||
      eventTypeConfig.bookingProgramMappingStatus !== "mapped"
    ) {
      throw new Error("Portal event type is not available.");
    }

    if (!dmCloser || dmCloser.tenantId !== args.tenantId || !dmCloser.isActive) {
      throw new Error("DM closer is not available.");
    }

    const team = await ctx.db.get(dmCloser.teamId);
    if (!team || team.tenantId !== args.tenantId || !team.isActive) {
      throw new Error("Attribution team is not available.");
    }

    if (!campaign || campaign.tenantId !== args.tenantId || !campaign.isActive) {
      throw new Error("Campaign preset is not available.");
    }

    return await ctx.db.insert("linkPortalCopyEvents", {
      tenantId: args.tenantId,
      sessionIdHash: args.sessionIdHash,
      eventTypeConfigId: eventTypeConfig._id,
      bookingProgramId: eventTypeConfig.bookingProgramId,
      attributionTeamId: team._id,
      dmCloserId: dmCloser._id,
      campaignPresetId: campaign._id,
      utmCampaign: campaign.utmCampaign,
      copiedAt: Date.now(),
    });
  },
});
```

**Key implementation notes:**
- Do not accept `bookingProgramId`, `attributionTeamId`, or `utmCampaign` as public action args; derive them after ownership checks.
- Keep the insert as a single mutation so validation and write are transactional.
- If event type readiness changes between page load and copy, reject the audit event but do not break the visible link.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/linkPortal/copyMutations.ts` | Create | Internal audit insertion |

---

### 5C — Public Copy Action and Server Action

**Type:** Full-Stack  
**Parallelizable:** No — depends on 5B validation mutation.

**What:** Add a public Convex action that validates the portal session and a Next.js Server Action that reads the HttpOnly cookie and calls it.

**Why:** The client must not receive or manage the portal session token directly, but copy auditing still needs session validation.

**Where:**
- `convex/linkPortal/copyActions.ts` (create)
- `app/dm-links/[portalSlug]/actions.ts` (modify)

**How:**

**Step 1: Add Convex copy action.**

```typescript
// Path: convex/linkPortal/copyActions.ts
"use node";

import { createHash } from "node:crypto";
import { v } from "convex/values";
import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import { verifyPortalSessionToken } from "./sessionToken";

function sessionIdHash(jti: string) {
  return createHash("sha256").update(jti).digest("base64url");
}

export const recordCopyEvent = action({
  args: {
    portalSlug: v.string(),
    sessionToken: v.string(),
    eventTypeConfigId: v.id("eventTypeConfigs"),
    dmCloserId: v.id("dmClosers"),
    campaignPresetId: v.id("linkPortalCampaignPresets"),
  },
  handler: async (ctx, args) => {
    const session = verifyPortalSessionToken(args.sessionToken);
    if (session.publicSlug !== args.portalSlug) {
      throw new Error("Portal session is no longer valid.");
    }

    await ctx.runQuery(
      internal.linkPortal.portalQueries.getPortalBootstrapForSession,
      {
        tenantId: session.tenantId,
        publicSlug: args.portalSlug,
        sessionVersion: session.sessionVersion,
      },
    );

    return await ctx.runMutation(
      internal.linkPortal.copyMutations.insertCopyEvent,
      {
        tenantId: session.tenantId,
        sessionIdHash: sessionIdHash(session.jti),
        eventTypeConfigId: args.eventTypeConfigId,
        dmCloserId: args.dmCloserId,
        campaignPresetId: args.campaignPresetId,
      },
    );
  },
});
```

**Step 2: Add Next.js Server Action that reads the cookie.**

```typescript
// Path: app/dm-links/[portalSlug]/actions.ts
import type { Id } from "@/convex/_generated/dataModel";

export async function recordPortalCopy(
  portalSlug: string,
  input: {
    eventTypeConfigId: string;
    dmCloserId: string;
    campaignPresetId: string;
  },
) {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(`dm_link_portal_${portalSlug}`)?.value;
  if (!sessionToken) return;

  await fetchAction(api.linkPortal.copyActions.recordCopyEvent, {
    portalSlug,
    sessionToken,
    eventTypeConfigId: input.eventTypeConfigId as Id<"eventTypeConfigs">,
    dmCloserId: input.dmCloserId as Id<"dmClosers">,
    campaignPresetId: input.campaignPresetId as Id<"linkPortalCampaignPresets">,
  });
}
```

**Key implementation notes:**
- Type casting may be needed in the Server Action because route props carry IDs as serialized strings; keep casts local and validate again in Convex.
- The action should return `null` or the audit ID; the client does not need details.
- Never include the generated URL in the Server Action payload.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/linkPortal/copyActions.ts` | Create | Public copy audit action |
| `app/dm-links/[portalSlug]/actions.ts` | Modify | Cookie-backed copy Server Action |

---

### 5D — Admin Usage Query

**Type:** Backend  
**Parallelizable:** Yes — depends on 5A schema and can run alongside 5B.

**What:** Add a bounded settings query that returns recent copy activity for the authenticated tenant.

**Why:** If copy auditing exists, admins need at least a compact way to inspect recent usage without raw URLs.

**Where:**
- `convex/linkPortal/copyQueries.ts` (create)
- `app/workspace/settings/_components/portal-usage-card.tsx` (create, optional)

**How:**

**Step 1: Add recent audit query.**

```typescript
// Path: convex/linkPortal/copyQueries.ts
import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

export const listRecentCopyEvents = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const rows = await ctx.db
      .query("linkPortalCopyEvents")
      .withIndex("by_tenantId_and_copiedAt", (q) => q.eq("tenantId", tenantId))
      .order("desc")
      .take(Math.min(limit ?? 25, 100));

    return await Promise.all(
      rows.map(async (row) => {
        const [eventTypeConfig, dmCloser, campaign] = await Promise.all([
          ctx.db.get(row.eventTypeConfigId),
          ctx.db.get(row.dmCloserId),
          ctx.db.get(row.campaignPresetId),
        ]);
        return {
          id: row._id,
          copiedAt: row.copiedAt,
          eventTypeName: eventTypeConfig?.displayName ?? "Unknown event type",
          dmCloserName: dmCloser?.displayName ?? "Unknown DM closer",
          campaignLabel: campaign?.label ?? row.utmCampaign,
        };
      }),
    );
  },
});
```

**Step 2: Optionally render recent activity in Settings.**

```tsx
// Path: app/workspace/settings/_components/portal-usage-card.tsx
export function PortalUsageCard() {
  const events = useQuery(api.linkPortal.copyQueries.listRecentCopyEvents, {
    limit: 25,
  });

  if (events === undefined) return <Skeleton className="h-48 w-full" />;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Recent Portal Copies</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Copied</TableHead>
              <TableHead>Event Type</TableHead>
              <TableHead>DM Closer</TableHead>
              <TableHead>Campaign</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.map((event) => (
              <TableRow key={event.id}>
                <TableCell>{formatDistanceToNow(event.copiedAt, { addSuffix: true })}</TableCell>
                <TableCell>{event.eventTypeName}</TableCell>
                <TableCell>{event.dmCloserName}</TableCell>
                <TableCell>{event.campaignLabel}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
```

**Key implementation notes:**
- Keep this query admin-only through `requireTenantUser()`.
- Return display names and timestamps only; do not reconstruct URLs.
- Bound the query to 100 rows maximum.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/linkPortal/copyQueries.ts` | Create | Admin recent usage query |
| `app/workspace/settings/_components/portal-usage-card.tsx` | Create | Optional usage card |

---

### 5E — Client Copy Integration and Analytics Policy

**Type:** Frontend  
**Parallelizable:** No — depends on 5C Server Action and Phase 3 copy handler.

**What:** Invoke copy audit after successful clipboard copy and optionally capture a safe PostHog event.

**Why:** Audit should reflect successful copy actions only and analytics must not leak the generated URL or raw UTM values.

**Where:**
- `app/dm-links/[portalSlug]/_components/dm-link-portal-client.tsx` (modify)

**How:**

**Step 1: Pass `recordPortalCopy` to the client component from the page.**

```tsx
// Path: app/dm-links/[portalSlug]/page.tsx
import { logoutPortal, recordPortalCopy, unlockPortal } from "./actions";

return (
  <DmLinkPortalClient
    portalSlug={portalSlug}
    bootstrap={bootstrap}
    unlockPortal={unlockPortal}
    logoutPortal={logoutPortal}
    recordPortalCopy={recordPortalCopy}
  />
);
```

**Step 2: Record audit only after clipboard success.**

```tsx
// Path: app/dm-links/[portalSlug]/_components/dm-link-portal-client.tsx
function copyGeneratedUrl(value: string) {
  startTransition(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyState("copied");

      if (closer && program && campaign) {
        await props.recordPortalCopy(props.portalSlug, {
          eventTypeConfigId: program.eventTypeConfigId,
          dmCloserId: closer.id,
          campaignPresetId: campaign.id,
        });
      }
    } catch {
      setCopyState("manual");
    }
  });
}
```

**Step 3: If PostHog is used, capture only safe properties.**

```tsx
// Path: app/dm-links/[portalSlug]/_components/dm-link-portal-client.tsx
posthog.capture("dm_link_copied", {
  event_type_config_id: program.eventTypeConfigId,
  dm_closer_id: closer.id,
  campaign: campaign.utmCampaign,
  copy_audit_attempted: true,
});
```

**Key implementation notes:**
- Do not include `generatedUrl`, `utm_source`, or `utm_medium` in PostHog.
- If `recordPortalCopy` fails after clipboard success, keep copy state as copied and optionally log a non-sensitive warning.
- Do not call the Server Action on manual-copy fallback unless product explicitly wants "copy intent" rather than successful copy.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/dm-links/[portalSlug]/page.tsx` | Modify | Pass copy Server Action |
| `app/dm-links/[portalSlug]/_components/dm-link-portal-client.tsx` | Modify | Audit after successful copy |

---

### 5F — Verification

**Type:** Manual / Full-Stack  
**Parallelizable:** No — runs after audit wiring is complete.

**What:** Verify audit insertion, privacy boundaries, session rejection, and analytics payloads.

**Why:** Audit code touches a public route and must be strict about tenant isolation and data minimization.

**Where:**
- `convex/linkPortal/copyActions.ts` (verify)
- `convex/linkPortal/copyMutations.ts` (verify)
- `app/dm-links/[portalSlug]/_components/dm-link-portal-client.tsx` (verify)

**How:**

**Step 1: Run static checks.**

```bash
# Path: /Users/nimbus/dev/ptdom-crm
npx convex dev --once
pnpm tsc --noEmit
```

**Step 2: Verify successful audit insert.**

Unlock a portal, copy a generated link, and inspect `linkPortalCopyEvents`. The row should include only IDs, session hash, campaign value, and timestamp.

**Step 3: Verify rejection paths.**

Rotate the password or disable the portal, then call the copy Server Action again from the stale page. Convex should reject the session and no row should be inserted.

**Step 4: Verify analytics payload.**

Inspect PostHog debug output, if enabled. Confirm `dm_link_copied` has no generated URL and no raw `utm_source` / `utm_medium` values.

**Key implementation notes:**
- A copy audit failure should not show a destructive user-facing error after a successful clipboard write.
- If PostHog is unavailable, the portal should still copy and audit through Convex.
- Keep audit verification queries bounded.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/linkPortal/copyActions.ts` | Verify | Session validation |
| `convex/linkPortal/copyMutations.ts` | Verify | Tenant ownership checks |
| `app/dm-links/[portalSlug]/_components/dm-link-portal-client.tsx` | Verify | Copy/audit behavior |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/schema.ts` | Modify | 5A |
| `convex/_generated/*` | Generate | 5A |
| `convex/linkPortal/copyMutations.ts` | Create | 5B |
| `convex/linkPortal/copyActions.ts` | Create | 5C |
| `app/dm-links/[portalSlug]/actions.ts` | Modify | 5C |
| `convex/linkPortal/copyQueries.ts` | Create | 5D |
| `app/workspace/settings/_components/portal-usage-card.tsx` | Create | 5D |
| `app/dm-links/[portalSlug]/page.tsx` | Modify | 5E |
| `app/dm-links/[portalSlug]/_components/dm-link-portal-client.tsx` | Modify | 5E |
