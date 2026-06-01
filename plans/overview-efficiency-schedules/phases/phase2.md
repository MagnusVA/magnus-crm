# Phase 2 — Schedule Management APIs and Settings UI

**Goal:** Add tenant-admin schedule management for Slack qualifiers and DM closers. After this phase, admins can view actor registries, edit weekly scheduled hours, and save schedules without changing overview ranking yet.

**Prerequisite:** Phase 1 complete and generated Convex types include `slackQualifierSchedules` and `dmCloserSchedules`.

**Runs in PARALLEL with:** Phase 3 backend efficiency builders after Phase 1. Phase 2 owns settings/API surfaces; Phase 3 owns overview query surfaces.

**Skills to invoke:**
- `convex-performance-audit` — keep list queries bounded and avoid per-row subscriptions.
- `next-best-practices` — preserve settings Suspense and client boundary behavior.
- `shadcn` — compose Tabs, Select, Field, Input, Button, Skeleton, Empty, and Table from existing primitives.
- `frontend-design` — keep the schedules tab dense and operational, not decorative.

**Acceptance Criteria:**
1. `api.workSchedules.listSlackQualifierSchedules` returns tenant Slack users and schedule rows for admins only.
2. `api.workSchedules.listDmCloserSchedules` returns tenant DM closers, team labels, and schedule rows for admins only.
3. `api.workSchedules.setSlackQualifierWeeklySchedule` validates tenant ownership and every weekday has `0 <= scheduledHours <= 24`.
4. `api.workSchedules.setDmCloserWeeklySchedule` validates tenant ownership and every weekday has `0 <= scheduledHours <= 24`.
5. No schedule mutation accepts `tenantId`, `updatedByUserId`, or role from client arguments.
6. `/workspace/settings?tab=schedules` opens the new schedules tab.
7. The schedules tab uses one query per actor family, not one query per row.
8. Saving a weekly schedule sends one Convex mutation and writes at most seven schedule rows for the selected actor.
9. Existing settings tabs continue to work.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
2A (Convex schedule API) ─────────────┬── 2C (Settings tab wiring) ───┐
                                      │                               ├── 2E (Settings QA)
2B (Weekly editor component) ─────────┘                               │
                                                                      │
2D (Loading/empty/error states) ──────────────────────────────────────┘
```

**Optimal execution:**
1. Build 2A first enough to expose generated API refs.
2. Build 2B and 2D in parallel using local props and existing shadcn primitives.
3. Wire the new settings tab in 2C.
4. Finish with admin-only QA in 2E.

**Estimated time:** 1.5-2.5 days

---

## Subphases

### 2A — Tenant-Admin Schedule API

**Type:** Backend  
**Parallelizable:** No — frontend imports these public function references.

**What:** Create `convex/workSchedules.ts` with bounded list queries and actor+weekly-schedule upsert mutations.

**Why:** Schedule writes are user-managed tenant data and need server-side auth, tenant validation, and consistent update metadata.

**Where:**
- `convex/workSchedules.ts` (create)

**How:**

**Step 1: Add validators and helpers.**

```typescript
// Path: convex/workSchedules.ts
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { weekdays, type Weekday } from "./lib/workSchedule";
import { requireTenantUser } from "./requireTenantUser";

const weeklyScheduledHoursValidator = v.object({
  monday: v.number(),
  tuesday: v.number(),
  wednesday: v.number(),
  thursday: v.number(),
  friday: v.number(),
  saturday: v.number(),
  sunday: v.number(),
});

type WeeklyScheduledHours = Record<Weekday, number>;

function validateScheduledHours(hours: number) {
  if (!Number.isFinite(hours) || hours < 0 || hours > 24) {
    throw new Error("Scheduled hours must be between 0 and 24");
  }
}

function validateWeeklyScheduledHours(schedule: WeeklyScheduledHours) {
  for (const weekday of weekdays) {
    validateScheduledHours(schedule[weekday]);
  }
}
```

**Step 2: Add Slack qualifier list and mutation.**

```typescript
// Path: convex/workSchedules.ts
export const listSlackQualifierSchedules = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const [slackUsers, schedules] = await Promise.all([
      ctx.db
        .query("slackUsers")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
        .take(300),
      ctx.db
        .query("slackQualifierSchedules")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
        .take(2_100),
    ]);

    return { slackUsers, schedules };
  },
});

export const setSlackQualifierWeeklySchedule = mutation({
  args: {
    slackUserId: v.string(),
    scheduledHours: weeklyScheduledHoursValidator,
  },
  handler: async (ctx, args) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    validateWeeklyScheduledHours(args.scheduledHours);

    const slackUser = await ctx.db
      .query("slackUsers")
      .withIndex("by_tenantId_and_slackUserId", (q) =>
        q.eq("tenantId", tenantId).eq("slackUserId", args.slackUserId),
      )
      .unique();
    if (!slackUser) throw new Error("Slack qualifier not found.");

    const now = Date.now();
    let changedRows = 0;

    for (const weekday of weekdays) {
      const scheduledHours = args.scheduledHours[weekday];
      const existing = await ctx.db
        .query("slackQualifierSchedules")
        .withIndex("by_tenantId_and_slackUserId_and_weekday", (q) =>
          q
            .eq("tenantId", tenantId)
            .eq("slackUserId", args.slackUserId)
            .eq("weekday", weekday),
        )
        .unique();

      if (existing && existing.scheduledHours === scheduledHours) continue;

      const patch = {
        scheduledHours,
        updatedByUserId: userId,
        updatedAt: now,
      };

      if (existing) {
        await ctx.db.patch(existing._id, patch);
      } else {
        await ctx.db.insert("slackQualifierSchedules", {
          tenantId,
          slackUserId: args.slackUserId,
          weekday,
          ...patch,
        });
      }

      changedRows += 1;
    }

    return { changedRows };
  },
});
```

**Step 3: Add DM closer list and mutation.**

```typescript
// Path: convex/workSchedules.ts
export const listDmCloserSchedules = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const [dmClosers, attributionTeams, schedules] = await Promise.all([
      ctx.db
        .query("dmClosers")
        .withIndex("by_tenantId_and_teamId", (q) => q.eq("tenantId", tenantId))
        .take(300),
      ctx.db
        .query("attributionTeams")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
        .take(300),
      ctx.db
        .query("dmCloserSchedules")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
        .take(2_100),
    ]);

    return { dmClosers, attributionTeams, schedules };
  },
});

export const setDmCloserWeeklySchedule = mutation({
  args: {
    dmCloserId: v.id("dmClosers"),
    scheduledHours: weeklyScheduledHoursValidator,
  },
  handler: async (ctx, args) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    validateWeeklyScheduledHours(args.scheduledHours);

    const dmCloser = await ctx.db.get(args.dmCloserId);
    if (!dmCloser || dmCloser.tenantId !== tenantId) {
      throw new Error("DM closer not found.");
    }

    const now = Date.now();
    let changedRows = 0;

    for (const weekday of weekdays) {
      const scheduledHours = args.scheduledHours[weekday];
      const existing = await ctx.db
        .query("dmCloserSchedules")
        .withIndex("by_tenantId_and_dmCloserId_and_weekday", (q) =>
          q
            .eq("tenantId", tenantId)
            .eq("dmCloserId", args.dmCloserId)
            .eq("weekday", weekday),
        )
        .unique();

      if (existing && existing.scheduledHours === scheduledHours) continue;

      const patch = {
        scheduledHours,
        updatedByUserId: userId,
        updatedAt: now,
      };

      if (existing) {
        await ctx.db.patch(existing._id, patch);
      } else {
        await ctx.db.insert("dmCloserSchedules", {
          tenantId,
          dmCloserId: args.dmCloserId,
          weekday,
          ...patch,
        });
      }

      changedRows += 1;
    }

    return { changedRows };
  },
});
```

**Key implementation notes:**
- Use `Promise.all` in list queries for independent reads.
- Map returned rows to smaller UI shapes if full docs are not needed.
- Save weekly schedules through one mutation per actor, not seven client-side mutation calls.
- Skip no-op patches when stored hours already match the submitted value.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/workSchedules.ts` | Create | Public admin schedule API |

### 2B — Shared Weekly Schedule Editor

**Type:** Frontend  
**Parallelizable:** Yes — can be built against typed props while 2A stabilizes.

**What:** Create a reusable editor for one actor’s Monday-Sunday scheduled hours.

**Why:** Slack qualifier and DM closer schedules share the exact interaction pattern. One editor reduces UI drift and keeps validation consistent.

**Where:**
- `app/workspace/settings/_components/weekly-schedule-editor.tsx` (create)

**How:**

**Step 1: Build the editor with existing shadcn primitives.**

```tsx
// Path: app/workspace/settings/_components/weekly-schedule-editor.tsx
"use client";

import { SaveIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

const weekdays = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export type Weekday = (typeof weekdays)[number];
export type ScheduleDraft = Record<Weekday, string>;

export function WeeklyScheduleEditor(props: {
  value: ScheduleDraft;
  onChange: (next: ScheduleDraft) => void;
  onSave: () => void;
  isSaving: boolean;
}) {
  return (
    <FieldGroup>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {weekdays.map((weekday) => (
          <Field key={weekday}>
            <FieldLabel htmlFor={`schedule-${weekday}`}>{weekday}</FieldLabel>
            <Input
              id={`schedule-${weekday}`}
              inputMode="decimal"
              min={0}
              max={24}
              step={0.25}
              type="number"
              value={props.value[weekday]}
              onChange={(event) =>
                props.onChange({
                  ...props.value,
                  [weekday]: event.target.value,
                })
              }
            />
          </Field>
        ))}
      </div>
      <Button type="button" onClick={props.onSave} disabled={props.isSaving}>
        {props.isSaving ? <Spinner data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />}
        Save schedule
      </Button>
    </FieldGroup>
  );
}
```

**Key implementation notes:**
- Use `FieldGroup` and `Field`, not raw `div` form groups.
- Use `data-icon` on lucide icons inside buttons.
- Keep draft values as strings so partial decimal input does not fight the browser.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/settings/_components/weekly-schedule-editor.tsx` | Create | Shared editor |

### 2C — Schedules Settings Tab

**Type:** Frontend  
**Parallelizable:** Yes — depends on 2A API refs and 2B editor.

**What:** Add `WorkSchedulesTab` and wire it into settings tabs.

**Why:** Admins need a single place to maintain Slack qualifier and DM closer schedules before efficiency ranking is enabled.

**Where:**
- `app/workspace/settings/_components/work-schedules-tab.tsx` (create)
- `app/workspace/settings/_components/settings-page-client.tsx` (modify)

**How:**

**Step 1: Create the tab component.**

```tsx
// Path: app/workspace/settings/_components/work-schedules-tab.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  WeeklyScheduleEditor,
  type ScheduleDraft,
  type Weekday,
} from "./weekly-schedule-editor";

const emptyDraft: ScheduleDraft = {
  monday: "0",
  tuesday: "0",
  wednesday: "0",
  thursday: "0",
  friday: "0",
  saturday: "0",
  sunday: "0",
};

const weekdays = Object.keys(emptyDraft) as Weekday[];

function draftFromSchedules(
  schedules: Array<{ weekday: Weekday; scheduledHours: number }>,
): ScheduleDraft {
  const next = { ...emptyDraft };
  for (const schedule of schedules) {
    next[schedule.weekday] = String(schedule.scheduledHours);
  }
  return next;
}

function draftToScheduledHours(draft: ScheduleDraft): Record<Weekday, number> {
  const scheduledHours = {} as Record<Weekday, number>;
  for (const weekday of weekdays) {
    scheduledHours[weekday] = Number(draft[weekday] || 0);
  }
  return scheduledHours;
}

export function WorkSchedulesTab() {
  const qualifierData = useQuery(api.workSchedules.listSlackQualifierSchedules, {});
  const dmCloserData = useQuery(api.workSchedules.listDmCloserSchedules, {});
  const setQualifierWeeklySchedule = useMutation(
    api.workSchedules.setSlackQualifierWeeklySchedule,
  );
  const setDmCloserWeeklySchedule = useMutation(
    api.workSchedules.setDmCloserWeeklySchedule,
  );
  const [selectedSlackUserId, setSelectedSlackUserId] = useState<string | null>(null);
  const [selectedDmCloserId, setSelectedDmCloserId] = useState<Id<"dmClosers"> | null>(null);
  const [qualifierDraft, setQualifierDraft] = useState<ScheduleDraft>(emptyDraft);
  const [dmCloserDraft, setDmCloserDraft] = useState<ScheduleDraft>(emptyDraft);
  const [savingTarget, setSavingTarget] = useState<"slack" | "dm" | null>(null);

  const slackOptions = useMemo(
    () =>
      qualifierData?.slackUsers.map((user) => ({
        id: user.slackUserId,
        label: user.displayName ?? user.realName ?? user.username ?? user.slackUserId,
      })) ?? [],
    [qualifierData],
  );

  const dmOptions = useMemo(() => {
    if (!dmCloserData) return [];
    const teamNameById = new Map(
      dmCloserData.attributionTeams.map((team) => [team._id, team.displayName]),
    );
    return dmCloserData.dmClosers.map((closer) => ({
      id: closer._id,
      label: `${teamNameById.get(closer.teamId) ?? "Unknown team"} / ${closer.displayName}`,
    }));
  }, [dmCloserData]);

  useEffect(() => {
    if (!selectedSlackUserId && slackOptions[0]) {
      setSelectedSlackUserId(slackOptions[0].id);
    }
  }, [selectedSlackUserId, slackOptions]);

  useEffect(() => {
    if (!selectedDmCloserId && dmOptions[0]) {
      setSelectedDmCloserId(dmOptions[0].id);
    }
  }, [selectedDmCloserId, dmOptions]);

  useEffect(() => {
    setQualifierDraft(
      draftFromSchedules(
        qualifierData?.schedules.filter(
          (schedule) => schedule.slackUserId === selectedSlackUserId,
        ) ?? [],
      ),
    );
  }, [qualifierData, selectedSlackUserId]);

  useEffect(() => {
    setDmCloserDraft(
      draftFromSchedules(
        dmCloserData?.schedules.filter(
          (schedule) => schedule.dmCloserId === selectedDmCloserId,
        ) ?? [],
      ),
    );
  }, [dmCloserData, selectedDmCloserId]);

  if (qualifierData === undefined || dmCloserData === undefined) {
    return (
      <Skeleton className="h-64 w-full" role="status" aria-label="Loading schedules" />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-4">
        <Select
          value={selectedSlackUserId ?? ""}
          onValueChange={(value) => setSelectedSlackUserId(value)}
        >
          <SelectTrigger aria-label="Select Slack qualifier">
            <SelectValue placeholder="Select Slack qualifier" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {slackOptions.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <WeeklyScheduleEditor
          value={qualifierDraft}
          onChange={setQualifierDraft}
          isSaving={savingTarget === "slack"}
          onSave={async () => {
            if (!selectedSlackUserId) return;
            setSavingTarget("slack");
            try {
              await setQualifierWeeklySchedule({
                slackUserId: selectedSlackUserId,
                scheduledHours: draftToScheduledHours(qualifierDraft),
              });
              toast.success("Slack qualifier schedule saved.");
            } catch (error) {
              toast.error(error instanceof Error ? error.message : "Could not save schedule.");
            } finally {
              setSavingTarget(null);
            }
          }}
        />
      </section>

      <section className="flex flex-col gap-4">
        <Select
          value={selectedDmCloserId ?? ""}
          onValueChange={(value) => setSelectedDmCloserId(value as Id<"dmClosers">)}
        >
          <SelectTrigger aria-label="Select DM closer">
            <SelectValue placeholder="Select DM closer" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {dmOptions.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <WeeklyScheduleEditor
          value={dmCloserDraft}
          onChange={setDmCloserDraft}
          isSaving={savingTarget === "dm"}
          onSave={async () => {
            if (!selectedDmCloserId) return;
            setSavingTarget("dm");
            try {
              await setDmCloserWeeklySchedule({
                dmCloserId: selectedDmCloserId,
                scheduledHours: draftToScheduledHours(dmCloserDraft),
              });
              toast.success("DM closer schedule saved.");
            } catch (error) {
              toast.error(error instanceof Error ? error.message : "Could not save schedule.");
            } finally {
              setSavingTarget(null);
            }
          }}
        />
      </section>
    </div>
  );
}
```

**Step 2: Add the settings tab.**

```tsx
// Path: app/workspace/settings/_components/settings-page-client.tsx
import { WorkSchedulesTab } from "./work-schedules-tab";

const defaultTab =
  tabParam === "event-types" ||
  tabParam === "field-mappings" ||
  tabParam === "programs" ||
  tabParam === "integrations" ||
  tabParam === "attribution" ||
  tabParam === "schedules"
    ? tabParam
    : "calendly";

// Inside TabsList:
<TabsTrigger value="schedules">Schedules</TabsTrigger>

// Inside Tabs:
<TabsContent value="schedules" className="mt-6">
  <WorkSchedulesTab />
</TabsContent>
```

**Key implementation notes:**
- Use one selected Slack user and one selected DM closer, not a giant editable matrix.
- Show inactive/deleted state with existing `Badge` variants.
- Use `toast.success` / `toast.error` for save feedback.
- Do not query per actor row; load schedules once and build `Map`s in `useMemo`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/settings/_components/work-schedules-tab.tsx` | Create | Schedule management surface |
| `app/workspace/settings/_components/settings-page-client.tsx` | Modify | Add tab |

### 2D — Loading, Empty, and Error States

**Type:** Frontend  
**Parallelizable:** Yes — can run with 2C.

**What:** Add accessible loading and empty states for the schedules tab.

**Why:** Admin settings pages should not collapse or shift while Convex data loads, and empty registries should be understandable.

**Where:**
- `app/workspace/settings/_components/work-schedules-tab.tsx` (modify)

**How:**

**Step 1: Use stable skeleton dimensions.**

```tsx
// Path: app/workspace/settings/_components/work-schedules-tab.tsx
function WorkSchedulesSkeleton() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-label="Loading work schedules">
      <Skeleton className="h-10 w-72" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
```

**Step 2: Use `Empty` for missing actor registries.**

```tsx
// Path: app/workspace/settings/_components/work-schedules-tab.tsx
if (qualifierData.slackUsers.length === 0 && dmCloserData.dmClosers.length === 0) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>No schedulable actors</EmptyTitle>
        <EmptyDescription>
          Slack qualifiers and DM closers appear here after they are synced or configured.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
```

**Key implementation notes:**
- Match shadcn composition rules; do not build custom card-like wrappers inside cards.
- Skeletons need `role="status"` and an accessible label.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/settings/_components/work-schedules-tab.tsx` | Modify | Loading/empty/error polish |

### 2E — Settings QA

**Type:** QA  
**Parallelizable:** No — validates 2A-2D together.

**What:** Verify admin-only behavior, tab routing, save behavior, and no regression to existing settings tabs.

**Why:** Settings is a shared admin surface with multiple existing tabs and Convex subscriptions.

**Where:**
- `/workspace/settings?tab=schedules`
- `/workspace/settings?tab=attribution`
- `/workspace/settings?tab=integrations`

**How:**

1. Sign in as tenant admin/master and open `/workspace/settings?tab=schedules`.
2. Confirm Slack and DM actor selectors load.
3. Save a schedule with decimals and verify values persist after reload.
4. Try invalid values below 0 or above 24 and confirm clear rejection.
5. Confirm existing `calendly`, `event-types`, `field-mappings`, `programs`, `attribution`, and `integrations` tabs still route and render.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| None | QA only | Manual/browser verification |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/workSchedules.ts` | Create | 2A |
| `app/workspace/settings/_components/weekly-schedule-editor.tsx` | Create | 2B |
| `app/workspace/settings/_components/work-schedules-tab.tsx` | Create | 2C, 2D |
| `app/workspace/settings/_components/settings-page-client.tsx` | Modify | 2C |
