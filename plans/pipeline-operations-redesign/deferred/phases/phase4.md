# Phase 4 — Workspace Settings Integration

**Goal:** Expose portal configuration in `/workspace/settings?tab=attribution` so tenant owners/admins can enable the portal, rotate access, manage campaign presets, and publish only ready event types. After this phase, admins can operate the portal without direct Convex console access.

**Prerequisite:** Phase 1 alias UI removal is complete, and Phase 2 portal config/password/campaign APIs compile. Read the repo form-pattern guidance in `AGENTS.md`; workspace forms should use React Hook Form, Zod v4, and `standardSchemaResolver` where validation is non-trivial.

**Runs in PARALLEL with:** Phase 3 after Phase 2 API contracts are stable. Phase 5 can start once the copy UI and event type readiness states are known.

**Skills to invoke:**
- `frontend-design` — Build dense configuration UI for repeated admin work, not a marketing surface.
- `shadcn` — Use existing Card, Table, Dialog, Alert, Button, Switch, Select, Badge, Skeleton, and form primitives.
- `next-best-practices` — Keep `/workspace/settings/page.tsx` as a thin RSC wrapper and all interactions in client components.
- `convex-performance-audit` — Confirm settings reads use tenant-first indexes and bounded lists.

**Acceptance Criteria:**
1. Settings -> Attribution renders `PortalAccessCard` above attribution teams, DM closers, campaign presets, event type readiness, and the booking link matrix.
2. Tenant owner/admin users can enable and disable the public portal; disabling revokes existing sessions through `sessionVersion`.
3. Tenant owner/admin users can rotate the public slug and see the updated `/dm-links/{publicSlug}` path.
4. Tenant owner/admin users can generate or rotate the portal password and see plaintext exactly once in a modal.
5. Session duration is editable within the backend-enforced bounds.
6. Campaign presets can be listed, created, edited, disabled, and marked default while maintaining at least one active default.
7. Event types show readiness states: Ready, Missing URL, Unmapped program, and Hidden.
8. Enabling an event type for the portal fails unless it has a valid `bookingBaseUrl`, mapped `bookingProgramId`, and `bookingProgramMappingStatus === "mapped"`.
9. Booking link matrix highlights portal-visible event types and no longer references aliases.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
4A (config API gaps) ────────────────┬── 4B (PortalAccessCard)
                                    ├── 4C (CampaignPresetsCard)
                                    └── 4D (event type readiness API)

4B + 4C + 4D complete ───────────────→ 4E (AttributionTab composition)

4E complete ─────────────────────────→ 4F (settings verification)
```

**Optimal execution:**
1. Fill any backend gaps for settings mutations first.
2. Build `PortalAccessCard`, campaign management, and event type readiness independently.
3. Compose the cards in `AttributionTab`.
4. Run browser and typecheck verification.

**Estimated time:** 3-4 days

---

## Subphases

### 4A — Settings API Gaps

**Type:** Backend  
**Parallelizable:** No — UI components depend on these mutation names and return shapes.

**What:** Add missing settings mutations for slug rotation, session TTL, campaign editing, and event type portal visibility.

**Why:** Phase 2 created the core credential flow; Settings needs ergonomic tenant-admin mutations that validate admin input and preserve session revocation semantics.

**Where:**
- `convex/linkPortal/configMutations.ts` (modify)
- `convex/linkPortal/slugActions.ts` (create)
- `convex/linkPortal/campaignMutations.ts` (modify)
- `convex/eventTypeConfigs/mutations.ts` (modify)
- `convex/eventTypeConfigs/queries.ts` (modify)

**How:**

**Step 1: Add slug rotation through a Node action and internal mutation.**

```typescript
// Path: convex/linkPortal/configMutations.ts
export const rotatePublicSlug = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    publicSlug: v.string(),
  },
  handler: async (ctx, { tenantId, publicSlug }) => {
    const config = await ctx.db
      .query("linkPortalConfigs")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .unique();
    if (!config) throw new Error("Generate a portal password first.");

    await ctx.db.patch(config._id, {
      publicSlug,
      sessionVersion: config.sessionVersion + 1,
      updatedAt: Date.now(),
    });
    return { portalUrlPath: `/dm-links/${publicSlug}` };
  },
});
```

```typescript
// Path: convex/linkPortal/slugActions.ts
"use node";

import { randomBytes } from "node:crypto";
import { action } from "../_generated/server";
import { internal } from "../_generated/api";

function randomPortalSlug() {
  return `lp_${randomBytes(18).toString("base64url")}`;
}

export const rotatePortalSlug = action({
  args: {},
  handler: async (ctx) => {
    const access = await ctx.runQuery(
      internal.linkPortal.authz.requireTenantAdminForPortal,
      {},
    );
    return await ctx.runMutation(
      internal.linkPortal.configMutations.rotatePublicSlug,
      {
        tenantId: access.tenantId,
        publicSlug: randomPortalSlug(),
      },
    );
  },
});
```

**Step 2: Add TTL mutation.**

```typescript
// Path: convex/linkPortal/configMutations.ts
export const updateSessionTtl = mutation({
  args: { sessionTtlSeconds: v.number() },
  handler: async (ctx, { sessionTtlSeconds }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const config = await ctx.db
      .query("linkPortalConfigs")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .unique();
    if (!config) throw new Error("Portal configuration not found.");

    await ctx.db.patch(config._id, {
      sessionTtlSeconds: normalizeTtl(sessionTtlSeconds),
      sessionVersion: config.sessionVersion + 1,
      updatedAt: Date.now(),
    });
  },
});
```

**Step 3: Add event type portal toggle.**

```typescript
// Path: convex/eventTypeConfigs/mutations.ts
export const setLinkPortalEnabled = mutation({
  args: {
    eventTypeConfigId: v.id("eventTypeConfigs"),
    linkPortalEnabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const config = await ctx.db.get(args.eventTypeConfigId);
    if (!config || config.tenantId !== tenantId) {
      throw new Error("Event type configuration not found.");
    }

    if (args.linkPortalEnabled) {
      if (
        !config.bookingBaseUrl ||
        !config.bookingProgramId ||
        config.bookingProgramMappingStatus !== "mapped"
      ) {
        throw new Error("Add a booking URL and mapped program before publishing.");
      }
    }

    await ctx.db.patch(config._id, {
      linkPortalEnabled: args.linkPortalEnabled,
      updatedAt: Date.now(),
    });
  },
});
```

**Step 4: Return readiness from event type queries.**

```typescript
// Path: convex/eventTypeConfigs/queries.ts
function portalReadiness(config: {
  linkPortalEnabled?: boolean;
  bookingBaseUrl?: string;
  bookingProgramId?: unknown;
  bookingProgramMappingStatus?: "mapped" | "unmapped";
}) {
  if (!config.linkPortalEnabled) return "hidden" as const;
  if (!config.bookingBaseUrl) return "missing_url" as const;
  if (!config.bookingProgramId || config.bookingProgramMappingStatus !== "mapped") {
    return "unmapped_program" as const;
  }
  return "ready" as const;
}
```

**Key implementation notes:**
- Public slug rotation uses a Node action so random bytes come from `node:crypto`; the database write stays in an internal mutation.
- Session TTL changes revoke existing sessions because they change `sessionVersion`.
- Event type enabling validates state at mutation time; UI badges are not a security boundary.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/linkPortal/configMutations.ts` | Modify | Slug and TTL mutations |
| `convex/linkPortal/slugActions.ts` | Create | Random public slug rotation action |
| `convex/linkPortal/campaignMutations.ts` | Modify | Campaign CRUD |
| `convex/eventTypeConfigs/mutations.ts` | Modify | Portal visibility toggle |
| `convex/eventTypeConfigs/queries.ts` | Modify | Readiness derivation |

---

### 4B — Portal Access Card

**Type:** Frontend  
**Parallelizable:** Yes — depends on 4A config mutation names.

**What:** Build a settings card for enabled state, portal URL, slug rotation, password rotation, last rotated timestamps, and session duration.

**Why:** Portal access must be operable by tenant admins without exposing password hashes or requiring manual Convex commands.

**Where:**
- `app/workspace/settings/_components/portal-access-card.tsx` (create)
- `app/workspace/settings/_components/one-time-password-dialog.tsx` (create)

**How:**

**Step 1: Create the card shell and data hooks.**

```tsx
// Path: app/workspace/settings/_components/portal-access-card.tsx
"use client";

import { useAction, useMutation, useQuery } from "convex/react";
import { CopyIcon, KeyRoundIcon, RotateCcwIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";

export function PortalAccessCard() {
  const config = useQuery(api.linkPortal.configQueries.getPortalConfigForSettings, {});
  const setPortalEnabled = useMutation(api.linkPortal.configMutations.setPortalEnabled);
  const rotateSlug = useAction(api.linkPortal.slugActions.rotatePortalSlug);
  const rotatePassword = useAction(api.linkPortal.passwordActions.rotatePortalPassword);

  if (config === undefined) return <Skeleton className="h-64 w-full" />;

  const portalPath = config ? `/dm-links/${config.publicSlug}` : "";

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">DM Link Portal</CardTitle>
        <Badge variant={config?.isEnabled ? "secondary" : "outline"}>
          {config?.isEnabled ? "Enabled" : "Disabled"}
        </Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground">Public access</span>
          <Switch
            checked={config?.isEnabled ?? false}
            disabled={!config}
            onCheckedChange={(isEnabled) => setPortalEnabled({ isEnabled })}
          />
        </div>
        <div className="flex gap-2">
          <Input value={portalPath} readOnly disabled={!portalPath} />
          <Button type="button" size="icon" variant="outline" aria-label="Copy portal URL">
            <CopyIcon />
          </Button>
          <Button type="button" size="icon" variant="outline" aria-label="Rotate portal URL">
            <RotateCcwIcon />
          </Button>
        </div>
        <Button type="button" variant="outline">
          <KeyRoundIcon data-icon="inline-start" />
          Generate or rotate password
        </Button>
      </CardContent>
    </Card>
  );
}
```

**Step 2: Show the one-time plaintext password in a dialog.**

```tsx
// Path: app/workspace/settings/_components/one-time-password-dialog.tsx
"use client";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function OneTimePasswordDialog({
  open,
  password,
  portalUrlPath,
  onOpenChange,
}: {
  open: boolean;
  password: string;
  portalUrlPath: string;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Portal password generated</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input value={portalUrlPath} readOnly onFocus={(event) => event.currentTarget.select()} />
          <Input value={password} readOnly onFocus={(event) => event.currentTarget.select()} />
          <Button type="button" onClick={() => onOpenChange(false)}>Done</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

**Key implementation notes:**
- Do not store one-time plaintext password in Convex or localStorage.
- Use `useAction` for `rotatePortalPassword`; it is a Convex action, not a mutation.
- Disable portal toggle until a config exists.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/settings/_components/portal-access-card.tsx` | Create | Portal access settings |
| `app/workspace/settings/_components/one-time-password-dialog.tsx` | Create | One-time password display |

---

### 4C — Campaign Presets Card

**Type:** Full-Stack  
**Parallelizable:** Yes — depends on 4A campaign mutations.

**What:** Add campaign preset CRUD in Settings -> Attribution with validation for max length, normalized uniqueness, active/default rules, and disabled states.

**Why:** Campaign values need tenant control without code deploys, while generated links must remain clean and predictable.

**Where:**
- `convex/linkPortal/campaignMutations.ts` (modify)
- `app/workspace/settings/_components/campaign-presets-card.tsx` (create)
- `app/workspace/settings/_components/campaign-preset-dialog.tsx` (create)

**How:**

**Step 1: Enforce campaign mutation rules.**

```typescript
// Path: convex/linkPortal/campaignMutations.ts
function normalizeCampaignInput(args: { label: string; utmCampaign: string }) {
  const label = args.label.trim();
  const utmCampaign = args.utmCampaign.trim();
  if (!label) throw new Error("Campaign label is required.");
  if (!utmCampaign) throw new Error("UTM campaign is required.");
  if (utmCampaign.length > 40) {
    throw new Error("UTM campaign must be 40 characters or fewer.");
  }
  const normalizedUtmCampaign = normalizeUtmValue(utmCampaign);
  if (!normalizedUtmCampaign) throw new Error("UTM campaign is required.");
  return {
    label,
    utmCampaign,
    normalizedUtmCampaign,
    slug: slugifyAttributionLabel(label || utmCampaign),
  };
}
```

**Step 2: Use React Hook Form with Zod v4.**

```tsx
// Path: app/workspace/settings/_components/campaign-preset-dialog.tsx
"use client";

import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { useForm } from "react-hook-form";
import { z } from "zod";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";

const campaignPresetSchema = z.object({
  label: z.string().min(1, "Label is required").max(40),
  utmCampaign: z.string().min(1, "UTM campaign is required").max(40),
});

export function CampaignPresetDialog() {
  const form = useForm({
    resolver: standardSchemaResolver(campaignPresetSchema),
    defaultValues: { label: "", utmCampaign: "" },
  });

  return (
    <Form {...form}>
      <form className="flex flex-col gap-4">
        <FormField
          control={form.control}
          name="label"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Label</FormLabel>
              <FormControl><Input {...field} /></FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </form>
    </Form>
  );
}
```

**Step 3: Render campaign rows with default and active controls.**

```tsx
// Path: app/workspace/settings/_components/campaign-presets-card.tsx
<Card>
  <CardHeader className="flex flex-row items-center justify-between">
    <CardTitle className="text-base">Campaign Presets</CardTitle>
    <Button size="sm" onClick={() => setDialogOpen(true)}>New Campaign</Button>
  </CardHeader>
  <CardContent>
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Label</TableHead>
          <TableHead>UTM Campaign</TableHead>
          <TableHead>Status</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {campaigns.map((campaign) => (
          <TableRow key={campaign._id}>
            <TableCell>{campaign.label}</TableCell>
            <TableCell className="font-mono text-xs">
              {campaign.utmCampaign}
            </TableCell>
            <TableCell>
              <Badge variant={campaign.isActive ? "secondary" : "outline"}>
                {campaign.isDefault ? "Default" : campaign.isActive ? "Active" : "Disabled"}
              </Badge>
            </TableCell>
            <TableCell className="text-right">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditingCampaign(campaign)}
              >
                Edit
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </CardContent>
</Card>
```

**Key implementation notes:**
- Use `standardSchemaResolver`, not `zodResolver`.
- Backend validation remains authoritative; client validation improves ergonomics only.
- Prevent disabling the last active default.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/linkPortal/campaignMutations.ts` | Modify | CRUD validation and default enforcement |
| `app/workspace/settings/_components/campaign-presets-card.tsx` | Create | Campaign table |
| `app/workspace/settings/_components/campaign-preset-dialog.tsx` | Create | Campaign create/edit form |

---

### 4D — Portal Event Type Readiness

**Type:** Full-Stack  
**Parallelizable:** Yes — depends on 4A event type API.

**What:** Add a readiness card and update event type UI to show portal status and toggle visibility.

**Why:** Admins need to know which Calendly event types are safe to expose before the public portal lists them.

**Where:**
- `app/workspace/settings/_components/portal-event-type-readiness-card.tsx` (create)
- `app/workspace/settings/_components/event-type-config-list.tsx` (modify)
- `app/workspace/settings/_components/event-type-config-dialog.tsx` (modify if inline toggle is added there)

**How:**

**Step 1: Define readiness display mapping.**

```tsx
// Path: app/workspace/settings/_components/portal-event-type-readiness-card.tsx
type PortalReadiness = "ready" | "missing_url" | "unmapped_program" | "hidden";

const READINESS_LABEL: Record<PortalReadiness, string> = {
  ready: "Ready",
  missing_url: "Missing URL",
  unmapped_program: "Unmapped program",
  hidden: "Hidden",
};

function readinessFor(config: {
  linkPortalEnabled?: boolean;
  bookingBaseUrl?: string;
  bookingProgramId?: string;
  bookingProgramMappingStatus?: "mapped" | "unmapped";
}): PortalReadiness {
  if (!config.linkPortalEnabled) return "hidden";
  if (!config.bookingBaseUrl) return "missing_url";
  if (!config.bookingProgramId || config.bookingProgramMappingStatus !== "mapped") {
    return "unmapped_program";
  }
  return "ready";
}
```

**Step 2: Render readiness rows and toggles.**

```tsx
// Path: app/workspace/settings/_components/portal-event-type-readiness-card.tsx
export function PortalEventTypeReadinessCard({
  eventTypeConfigs,
}: {
  eventTypeConfigs: EventTypeConfig[];
}) {
  const setLinkPortalEnabled = useMutation(
    api.eventTypeConfigs.mutations.setLinkPortalEnabled,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Portal Event Types</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Event Type</TableHead>
              <TableHead>Booked Program</TableHead>
              <TableHead>Readiness</TableHead>
              <TableHead>Visible</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {eventTypeConfigs.map((config) => {
              const readiness = readinessFor(config);
              return (
                <TableRow key={config._id}>
                  <TableCell>{config.displayName}</TableCell>
                  <TableCell>{config.bookingProgramName ?? "Unmapped"}</TableCell>
                  <TableCell>
                    <Badge variant={readiness === "ready" ? "secondary" : "outline"}>
                      {READINESS_LABEL[readiness]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={config.linkPortalEnabled === true}
                      onCheckedChange={(linkPortalEnabled) =>
                        setLinkPortalEnabled({
                          eventTypeConfigId: config._id,
                          linkPortalEnabled,
                        })
                      }
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
```

**Key implementation notes:**
- A disabled/hidden event type can still be configured; it just does not appear in the public portal.
- The toggle should optimistically fail with a toast if backend validation rejects an unsafe publish.
- If multiple event types map to one program, display event type name alongside program name.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/settings/_components/portal-event-type-readiness-card.tsx` | Create | Readiness UI |
| `app/workspace/settings/_components/event-type-config-list.tsx` | Modify | Display portal state |
| `app/workspace/settings/_components/event-type-config-dialog.tsx` | Modify | Optional inline portal control |

---

### 4E — Attribution Tab Composition

**Type:** Frontend  
**Parallelizable:** No — depends on 4B-4D components.

**What:** Compose portal access, team/closer management, campaign presets, event type readiness, unmapped UTMs, and booking matrix in the Attribution tab.

**Why:** The feature should have a single admin workflow surface with portal controls first and canonical attribution management below.

**Where:**
- `app/workspace/settings/_components/attribution-tab.tsx` (modify)
- `app/workspace/settings/_components/booking-link-matrix.tsx` (modify)

**How:**

**Step 1: Add new cards above the existing registry UI.**

```tsx
// Path: app/workspace/settings/_components/attribution-tab.tsx
import { CampaignPresetsCard } from "./campaign-presets-card";
import { PortalAccessCard } from "./portal-access-card";
import { PortalEventTypeReadinessCard } from "./portal-event-type-readiness-card";

return (
  <div className="flex flex-col gap-4">
    <PortalAccessCard />
    <CampaignPresetsCard />
    <PortalEventTypeReadinessCard eventTypeConfigs={eventTypeConfigs} />
    <AttributionUnmappedPanel />
    <BookingLinkMatrix
      teams={teams}
      closers={closers}
      eventTypeConfigs={eventTypeConfigs}
    />
  </div>
);
```

Keep the current DM Teams and DM Closers card JSX between `PortalAccessCard` and `CampaignPresetsCard`; remove only the alias card and dialog from Phase 1.

**Step 2: Update booking matrix to mark portal-ready rows.**

```tsx
// Path: app/workspace/settings/_components/booking-link-matrix.tsx
<TableHead>Portal</TableHead>
```

```tsx
// Path: app/workspace/settings/_components/booking-link-matrix.tsx
<TableCell>
  <Badge variant={config.linkPortalEnabled ? "secondary" : "outline"}>
    {config.linkPortalEnabled ? "Visible" : "Hidden"}
  </Badge>
</TableCell>
```

**Key implementation notes:**
- Do not reintroduce alias dialog state from Phase 1.
- Keep `AttributionTabSkeleton` dimensions close to the real cards to avoid layout shift.
- The portal card should remain usable even when teams/closers/event types are still loading if its own query has completed.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/settings/_components/attribution-tab.tsx` | Modify | Compose portal settings cards |
| `app/workspace/settings/_components/booking-link-matrix.tsx` | Modify | Portal visibility/readiness column |

---

### 4F — Settings Verification

**Type:** Manual / Full-Stack  
**Parallelizable:** No — runs after the Settings flow is wired.

**What:** Verify admin-only access, UI flows, session revocation effects, campaign rules, and event type readiness validation.

**Why:** These controls govern a public portal; Settings mistakes either expose links too broadly or leave operators blocked.

**Where:**
- `app/workspace/settings/_components/*portal*.tsx` (verify)
- `convex/linkPortal/*` (verify)
- `convex/eventTypeConfigs/*` (verify)

**How:**

**Step 1: Run static checks.**

```bash
# Path: /Users/nimbus/dev/ptdom-crm
npx convex dev --once
pnpm tsc --noEmit
```

**Step 2: Verify role behavior.**

Sign in as `tenant_master` or `tenant_admin` and open `/workspace/settings?tab=attribution`. The portal cards should render. Sign in as `closer`; Settings should redirect through the existing workspace auth flow.

**Step 3: Verify password and session revocation.**

Generate a password, unlock `/dm-links/{slug}`, then disable the portal or rotate password in Settings. Refresh the public portal; it should return to the password screen.

**Step 4: Verify event type validation.**

Attempt to enable an event type with no booking URL or unmapped program. The mutation should fail and leave the row hidden.

**Key implementation notes:**
- Do not expose password hashes or salts in client queries.
- Avoid logging plaintext passwords in action handlers or UI error handlers.
- Use toasts for failed mutations but keep inline state clear enough for admins to recover.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/settings/_components/*portal*.tsx` | Verify | Settings UI |
| `convex/linkPortal/*` | Verify | Config and campaign APIs |
| `convex/eventTypeConfigs/*` | Verify | Readiness toggles |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/linkPortal/configMutations.ts` | Modify | 4A |
| `convex/linkPortal/slugActions.ts` | Create | 4A |
| `convex/linkPortal/campaignMutations.ts` | Modify | 4A, 4C |
| `convex/eventTypeConfigs/mutations.ts` | Modify | 4A |
| `convex/eventTypeConfigs/queries.ts` | Modify | 4A |
| `app/workspace/settings/_components/portal-access-card.tsx` | Create | 4B |
| `app/workspace/settings/_components/one-time-password-dialog.tsx` | Create | 4B |
| `app/workspace/settings/_components/campaign-presets-card.tsx` | Create | 4C |
| `app/workspace/settings/_components/campaign-preset-dialog.tsx` | Create | 4C |
| `app/workspace/settings/_components/portal-event-type-readiness-card.tsx` | Create | 4D |
| `app/workspace/settings/_components/event-type-config-list.tsx` | Modify | 4D |
| `app/workspace/settings/_components/event-type-config-dialog.tsx` | Modify | 4D |
| `app/workspace/settings/_components/attribution-tab.tsx` | Modify | 4E |
| `app/workspace/settings/_components/booking-link-matrix.tsx` | Modify | 4E |
