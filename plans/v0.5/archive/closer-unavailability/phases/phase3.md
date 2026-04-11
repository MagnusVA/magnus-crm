# Phase 3 — Redistribution Wizard

**Goal:** Build the full redistribution wizard page at `/workspace/team/redistribute/[unavailabilityId]` that guides admins through reviewing affected meetings, auto-distributing them to available closers via a scoring algorithm, and manually resolving any meetings that couldn't be auto-assigned. After this phase, an admin can complete the entire unavailability → redistribution flow end-to-end.

**Prerequisite:** Phase 2 complete (Mark Unavailable dialog creates `closerUnavailability` records; `getUnavailabilityWithMeetings` and `getAvailableClosersForDate` queries are deployed).

**Runs in PARALLEL with:** Nothing — Phase 4 depends on the reassignment mutations created here (which write `meetingReassignments` audit records and update `opportunity.assignedCloserId`).

> **Critical path:** This phase is on the critical path (Phase 1 → Phase 2 → Phase 3 → Phase 4).

**Skills to invoke:**
- `frontend-design` — Production-grade wizard interface with multi-step flow, responsive layout, and clear visual hierarchy
- `shadcn` — Building wizard UI with Card, Badge, Checkbox, Separator, Alert, Select components and step indicator
- `web-design-guidelines` — WCAG compliance for wizard steps (focus management between steps, keyboard navigation for checkboxes, ARIA live regions for distribution results)
- `vercel-react-best-practices` — Optimizing wizard re-renders (memoization of meeting/closer lists, avoiding unnecessary state updates)
- `convex-performance-audit` — Reviewing `getAvailableClosersForDate` for N+1 query patterns; the auto-distribute mutation touches N meetings × M closers
- `expect` — Browser-based QA for wizard flow, step transitions, auto-distribute results, manual resolution interactions

**Acceptance Criteria:**
1. Navigating to `/workspace/team/redistribute/{unavailabilityId}` renders the wizard with the closer's name, date, and reason displayed in the header.
2. Step 1 (Review) shows all affected meetings with checkboxes, sorted by scheduled time, with "Already Reassigned" badges for previously-handled meetings.
3. Selecting meetings and clicking "Next" advances to Step 2 (Distribute).
4. Step 2 shows available closers with their meeting count for the day, and unavailable closers are shown disabled with the reason.
5. Clicking "Auto-Distribute" calls the backend mutation, which assigns meetings to closers based on workload scoring with a 15-minute buffer between meetings.
6. If all meetings are assigned, the wizard transitions to Step 4 (Complete) with a summary.
7. If some meetings cannot be auto-assigned, the wizard transitions to Step 3 (Resolve) showing the unassigned meetings with per-meeting action options.
8. In the Resolve step, an admin can force-assign a meeting to any available closer (with overlap warning) or cancel the meeting.
9. The "Cancel Meeting" action in the Resolve step updates the meeting and opportunity status to `"canceled"` with a descriptive cancellation reason.
10. After all meetings are resolved, the Complete step shows a summary and a "Back to Team" button.
11. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
3A (Auto-distribute mutation) ───────────────┐
                                              ├── 3D (Wizard page client — wires queries + mutations)
3B (Manual resolve mutation) ────────────────┤
                                              │
3C (Wizard page RSC + route) ────────────────┘
```

**Optimal execution:**
1. Start 3A, 3B, 3C all in parallel (different files).
2. Once all three are done → 3D (build the full wizard client component that connects everything).

**Estimated time:** 2-3 days

---

## Subphases

### 3A — Auto-Distribution Mutation

**Type:** Backend
**Parallelizable:** Yes — new file, no overlap with 3B or 3C.

**What:** Create `convex/unavailability/redistribution.ts` with the `autoDistributeMeetings` mutation that implements the scoring algorithm: for each meeting, score candidate closers by workload and time-gap proximity, assign to the best candidate respecting a 15-minute buffer, and create audit records.

**Why:** This is the core intelligence of the redistribution system. The mutation must be atomic — all assignments in a single transaction — so that partial failures don't leave the system in an inconsistent state. The scoring algorithm ensures fair workload distribution.

**Where:**
- `convex/unavailability/redistribution.ts` (new)

**How:**

**Step 1: Create the redistribution file with helper functions**

```typescript
// Path: convex/unavailability/redistribution.ts

import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

const BUFFER_MINUTES = 15; // Minimum gap between meetings

interface CloserSchedule {
  closerId: string;
  meetings: Array<{ scheduledAt: number; durationMinutes: number }>;
  meetingsToday: number;
}

/**
 * Check if a meeting time slot is free for a closer, respecting the buffer.
 *
 * A slot is "free" if the meeting does not overlap (including buffer)
 * with any existing meeting on the closer's schedule.
 */
function isSlotFree(
  schedule: CloserSchedule,
  meetingStart: number,
  meetingDuration: number,
): boolean {
  const bufferMs = BUFFER_MINUTES * 60 * 1000;
  const meetingEnd = meetingStart + meetingDuration * 60 * 1000;

  for (const existing of schedule.meetings) {
    const existingEnd =
      existing.scheduledAt + existing.durationMinutes * 60 * 1000;

    // Check for overlap with buffer
    const conflictStart = existing.scheduledAt - bufferMs;
    const conflictEnd = existingEnd + bufferMs;

    if (meetingStart < conflictEnd && meetingEnd > conflictStart) {
      return false; // Overlap detected
    }
  }
  return true;
}

/**
 * Compute a priority score for assigning a meeting to a closer.
 *
 * Higher score = better candidate.
 * Factors:
 *   1. Fewer meetings today → higher score (base: 100 - meetingsToday * 10)
 *   2. Largest gap around the meeting time → bonus (up to 20 points)
 */
function computeScore(
  schedule: CloserSchedule,
  meetingStart: number,
  meetingDuration: number,
): number {
  // Base score: inversely proportional to meeting count
  const baseScore = Math.max(0, 100 - schedule.meetingsToday * 10);

  // Gap bonus: find the nearest existing meeting and reward larger gaps
  const meetingEnd = meetingStart + meetingDuration * 60 * 1000;
  let minGap = Number.MAX_SAFE_INTEGER;

  for (const existing of schedule.meetings) {
    const existingEnd =
      existing.scheduledAt + existing.durationMinutes * 60 * 1000;

    const gapBefore = existing.scheduledAt - meetingEnd;
    const gapAfter = meetingStart - existingEnd;

    const gap = Math.max(gapBefore, gapAfter);
    if (gap >= 0 && gap < minGap) {
      minGap = gap;
    }
  }

  // No existing meetings = maximum gap bonus
  const gapBonus =
    minGap === Number.MAX_SAFE_INTEGER
      ? 20
      : Math.min(20, Math.floor(minGap / (15 * 60 * 1000)) * 5);

  return baseScore + gapBonus;
}
```

**Step 2: Implement the autoDistributeMeetings mutation**

```typescript
// Path: convex/unavailability/redistribution.ts (continued)

export const autoDistributeMeetings = mutation({
  args: {
    unavailabilityId: v.id("closerUnavailability"),
    meetingIds: v.array(v.id("meetings")),
    candidateCloserIds: v.array(v.id("users")),
  },
  handler: async (ctx, args) => {
    console.log("[Redistribution] autoDistributeMeetings called", {
      unavailabilityId: args.unavailabilityId,
      meetingCount: args.meetingIds.length,
      candidateCount: args.candidateCloserIds.length,
    });

    const { userId, tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    // Validate unavailability record
    const unavailability = await ctx.db.get(args.unavailabilityId);
    if (!unavailability || unavailability.tenantId !== tenantId) {
      throw new Error("Unavailability record not found");
    }

    // Build schedules for each candidate closer
    const dayStart = unavailability.date;
    const dayEnd = unavailability.date + 24 * 60 * 60 * 1000;

    const schedules: Map<string, CloserSchedule> = new Map();

    for (const closerId of args.candidateCloserIds) {
      const closer = await ctx.db.get(closerId);
      if (
        !closer ||
        closer.tenantId !== tenantId ||
        closer.role !== "closer"
      ) {
        continue;
      }

      // Get this closer's existing meetings for the day
      const closerOpps = await ctx.db
        .query("opportunities")
        .withIndex("by_tenantId_and_assignedCloserId", (q) =>
          q
            .eq("tenantId", tenantId)
            .eq("assignedCloserId", closerId),
        )
        .collect();

      const activeOppIds = new Set(
        closerOpps
          .filter(
            (opp) =>
              opp.status === "scheduled" ||
              opp.status === "in_progress",
          )
          .map((opp) => opp._id),
      );

      const meetings: Array<{
        scheduledAt: number;
        durationMinutes: number;
      }> = [];

      const dayMeetings = ctx.db
        .query("meetings")
        .withIndex("by_tenantId_and_scheduledAt", (q) =>
          q.eq("tenantId", tenantId).gte("scheduledAt", dayStart),
        );

      for await (const meeting of dayMeetings) {
        if (meeting.scheduledAt >= dayEnd) break;
        if (!activeOppIds.has(meeting.opportunityId)) continue;
        if (meeting.status !== "scheduled") continue;

        meetings.push({
          scheduledAt: meeting.scheduledAt,
          durationMinutes: meeting.durationMinutes,
        });
      }

      schedules.set(closerId as string, {
        closerId: closerId as string,
        meetings,
        meetingsToday: meetings.length,
      });
    }

    // Load meetings to redistribute, sorted by time
    const meetingsToAssign: Array<{
      meetingId: (typeof args.meetingIds)[0];
      scheduledAt: number;
      durationMinutes: number;
      opportunityId: string;
    }> = [];

    for (const meetingId of args.meetingIds) {
      const meeting = await ctx.db.get(meetingId);
      if (!meeting || meeting.tenantId !== tenantId) continue;
      if (meeting.status !== "scheduled") continue;

      meetingsToAssign.push({
        meetingId,
        scheduledAt: meeting.scheduledAt,
        durationMinutes: meeting.durationMinutes,
        opportunityId: meeting.opportunityId as string,
      });
    }

    meetingsToAssign.sort((a, b) => a.scheduledAt - b.scheduledAt);

    // Run the assignment algorithm
    const assigned: Array<{
      meetingId: string;
      toCloserId: string;
      toCloserName: string;
    }> = [];
    const unassigned: Array<{
      meetingId: string;
      reason: string;
    }> = [];

    const now = Date.now();
    const reasonLabel =
      unavailability.reason.charAt(0).toUpperCase() +
      unavailability.reason.slice(1);

    for (const meeting of meetingsToAssign) {
      // Score each candidate
      let bestCandidate: {
        closerId: string;
        score: number;
      } | null = null;

      for (const [closerId, schedule] of schedules) {
        if (
          !isSlotFree(
            schedule,
            meeting.scheduledAt,
            meeting.durationMinutes,
          )
        ) {
          continue;
        }

        const score = computeScore(
          schedule,
          meeting.scheduledAt,
          meeting.durationMinutes,
        );

        if (!bestCandidate || score > bestCandidate.score) {
          bestCandidate = { closerId, score };
        }
      }

      if (bestCandidate) {
        const opp = await ctx.db.get(meeting.opportunityId as any);

        if (opp) {
          const fromCloserId = opp.assignedCloserId;

          // Update opportunity assignment
          await ctx.db.patch(opp._id, {
            assignedCloserId: bestCandidate.closerId as any,
            updatedAt: now,
          });

          // Set denormalized reassignment field on meeting
          await ctx.db.patch(meeting.meetingId, {
            reassignedFromCloserId: fromCloserId,
          });

          // Create audit record
          await ctx.db.insert("meetingReassignments", {
            tenantId,
            meetingId: meeting.meetingId,
            opportunityId: opp._id,
            fromCloserId: fromCloserId!,
            toCloserId: bestCandidate.closerId as any,
            reason: `${reasonLabel} - auto-distributed`,
            unavailabilityId: args.unavailabilityId,
            reassignedByUserId: userId,
            reassignedAt: now,
          });

          // Update the candidate's schedule so subsequent assignments
          // account for this newly assigned meeting
          const schedule = schedules.get(bestCandidate.closerId)!;
          schedule.meetings.push({
            scheduledAt: meeting.scheduledAt,
            durationMinutes: meeting.durationMinutes,
          });
          schedule.meetingsToday++;

          const closer = await ctx.db.get(
            bestCandidate.closerId as any,
          );
          assigned.push({
            meetingId: meeting.meetingId as string,
            toCloserId: bestCandidate.closerId,
            toCloserName:
              closer?.fullName ?? closer?.email ?? "Unknown",
          });
        }
      } else {
        unassigned.push({
          meetingId: meeting.meetingId as string,
          reason: "No available closer with a free time slot",
        });
      }
    }

    console.log("[Redistribution] autoDistributeMeetings completed", {
      assignedCount: assigned.length,
      unassignedCount: unassigned.length,
    });

    return { assigned, unassigned };
  },
});
```

**Key implementation notes:**
- The `isSlotFree` function uses the 15-minute buffer as a **hard constraint**, not just a scoring factor. If a meeting would land within 15 minutes of an existing one, the closer is disqualified for that slot.
- The algorithm processes meetings chronologically (earliest first). After each assignment, the candidate's schedule is updated in-memory so subsequent assignments account for it.
- Scoring: base score (100 - meetingsToday * 10) strongly favors closers with fewer meetings. Gap bonus (up to 20 points) rewards more breathing room.
- All data mutations (opportunity patch, meeting patch, audit insert) happen in a single Convex transaction — either all succeed or none do.
- The mutation re-validates `meeting.status === "scheduled"` at execution time to handle race conditions where a meeting was canceled between wizard load and distribution.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/unavailability/redistribution.ts` | Create | `autoDistributeMeetings` mutation + scoring helpers |

---

### 3B — Manual Resolution Mutation

**Type:** Backend
**Parallelizable:** Yes — same file as 3A but logically independent. Can be added to the same file after 3A is complete, or developed in parallel if using separate feature branches.

**What:** Add the `manuallyResolveMeeting` mutation to `convex/unavailability/redistribution.ts` that handles two actions: force-assign a meeting to a specific closer (even with overlap), or cancel the meeting in the CRM.

**Why:** Not all meetings can be auto-distributed (no available closer with a free slot). The manual resolution path gives admins explicit control over edge cases. Force-assign allows assignment with an acknowledged overlap; cancel removes the meeting from the pipeline.

**Where:**
- `convex/unavailability/redistribution.ts` (modify — add to the file created in 3A)

**How:**

**Step 1: Add the manuallyResolveMeeting mutation**

```typescript
// Path: convex/unavailability/redistribution.ts (addition)

/**
 * Manually resolve a single meeting that could not be auto-distributed.
 *
 * Actions:
 * - "assign": Force-assign to a specific closer (even with overlap warning)
 * - "cancel": Cancel the meeting in the CRM
 */
export const manuallyResolveMeeting = mutation({
  args: {
    meetingId: v.id("meetings"),
    unavailabilityId: v.id("closerUnavailability"),
    action: v.union(v.literal("assign"), v.literal("cancel")),
    targetCloserId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    console.log("[Redistribution] manuallyResolveMeeting called", {
      meetingId: args.meetingId,
      action: args.action,
      targetCloserId: args.targetCloserId,
    });

    const { userId, tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const meeting = await ctx.db.get(args.meetingId);
    if (!meeting || meeting.tenantId !== tenantId) {
      throw new Error("Meeting not found");
    }

    const opportunity = await ctx.db.get(meeting.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }

    const unavailability = await ctx.db.get(args.unavailabilityId);
    if (!unavailability || unavailability.tenantId !== tenantId) {
      throw new Error("Unavailability record not found");
    }

    const now = Date.now();
    const reasonLabel =
      unavailability.reason.charAt(0).toUpperCase() +
      unavailability.reason.slice(1);

    if (args.action === "assign") {
      if (!args.targetCloserId) {
        throw new Error(
          "targetCloserId is required for assign action",
        );
      }

      // Prevent assigning back to the unavailable closer
      if (args.targetCloserId === unavailability.closerId) {
        throw new Error(
          "Cannot assign to the unavailable closer",
        );
      }

      const targetCloser = await ctx.db.get(args.targetCloserId);
      if (
        !targetCloser ||
        targetCloser.tenantId !== tenantId ||
        targetCloser.role !== "closer"
      ) {
        throw new Error("Target closer not found or not a closer");
      }

      const fromCloserId = opportunity.assignedCloserId;

      // Update opportunity assignment
      await ctx.db.patch(opportunity._id, {
        assignedCloserId: args.targetCloserId,
        updatedAt: now,
      });

      // Set denormalized reassignment field
      await ctx.db.patch(args.meetingId, {
        reassignedFromCloserId: fromCloserId,
      });

      // Create audit record
      await ctx.db.insert("meetingReassignments", {
        tenantId,
        meetingId: args.meetingId,
        opportunityId: opportunity._id,
        fromCloserId: fromCloserId!,
        toCloserId: args.targetCloserId,
        reason: `${reasonLabel} - manually assigned`,
        unavailabilityId: args.unavailabilityId,
        reassignedByUserId: userId,
        reassignedAt: now,
      });

      console.log("[Redistribution] Meeting manually assigned", {
        meetingId: args.meetingId,
        fromCloserId,
        toCloserId: args.targetCloserId,
      });

      return {
        action: "assigned" as const,
        targetCloserName:
          targetCloser.fullName ?? targetCloser.email,
      };
    }

    if (args.action === "cancel") {
      // Cancel the meeting in the CRM (not in Calendly)
      await ctx.db.patch(args.meetingId, { status: "canceled" });
      await ctx.db.patch(opportunity._id, {
        status: "canceled",
        cancellationReason: `Canceled due to closer unavailability (${reasonLabel})`,
        updatedAt: now,
      });

      console.log("[Redistribution] Meeting canceled", {
        meetingId: args.meetingId,
      });

      return { action: "canceled" as const };
    }

    throw new Error(`Unknown action: ${args.action}`);
  },
});
```

**Key implementation notes:**
- Force-assign does NOT check for schedule overlap — that's the point of force-assign. The UI shows a warning, but the mutation proceeds regardless.
- The `targetCloserId !== unavailability.closerId` check prevents accidentally assigning back to the unavailable closer.
- Cancel updates both the `meeting.status` and `opportunity.status` to `"canceled"`, with a descriptive `cancellationReason`.
- No audit record is created for cancellations — only for reassignments. The cancellation is visible through the opportunity's `cancellationReason` field.
- The mutation returns a discriminated result (`{ action: "assigned" }` or `{ action: "canceled" }`) so the UI can display appropriate feedback.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/unavailability/redistribution.ts` | Modify | Add `manuallyResolveMeeting` mutation |

---

### 3C — Wizard Route & Page RSC

**Type:** Frontend
**Parallelizable:** Yes — creates new route files, no overlap with 3A or 3B.

**What:** Create the Next.js route structure for `/workspace/team/redistribute/[unavailabilityId]` with a thin RSC page wrapper and a loading skeleton.

**Why:** The route structure must exist before the wizard client component can be wired up. The RSC page extracts the `unavailabilityId` route parameter and passes it to the client component. No server-side auth check is needed because the parent workspace layout already gates access.

**Where:**
- `app/workspace/team/redistribute/[unavailabilityId]/page.tsx` (new)
- `app/workspace/team/redistribute/[unavailabilityId]/loading.tsx` (new)

**How:**

**Step 1: Create the page RSC**

```typescript
// Path: app/workspace/team/redistribute/[unavailabilityId]/page.tsx

import type { Id } from "@/convex/_generated/dataModel";
import { RedistributeWizardPageClient } from "./_components/redistribute-wizard-page-client";

export const unstable_instant = false;

export default async function RedistributePage({
  params,
}: {
  params: Promise<{ unavailabilityId: string }>;
}) {
  const { unavailabilityId } = await params;

  return (
    <RedistributeWizardPageClient
      unavailabilityId={
        unavailabilityId as Id<"closerUnavailability">
      }
    />
  );
}
```

**Step 2: Create the loading skeleton**

```typescript
// Path: app/workspace/team/redistribute/[unavailabilityId]/loading.tsx

import { Skeleton } from "@/components/ui/skeleton";

export default function RedistributeLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96" />
      </div>
      <div className="flex items-center gap-2">
        <Skeleton className="h-6 w-20 rounded-full" />
        <Skeleton className="h-4 w-4" />
        <Skeleton className="h-6 w-24 rounded-full" />
        <Skeleton className="h-4 w-4" />
        <Skeleton className="h-6 w-22 rounded-full" />
      </div>
      <Skeleton className="h-px w-full" />
      <Skeleton className="h-[400px] w-full rounded-xl" />
    </div>
  );
}
```

**Key implementation notes:**
- `unstable_instant = false` follows the codebase's PPR-ready page convention.
- `params` is `Promise<{ unavailabilityId: string }>` — Next.js 16 async params pattern.
- The `as Id<"closerUnavailability">` cast is safe here because the Convex query will validate the ID format and return an error if invalid.
- No `requireRole` call — the parent `/workspace` layout gates all workspace routes, and each Convex query re-validates via `requireTenantUser`.
- The loading skeleton matches the wizard's visual structure (header + step indicator + content area).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/team/redistribute/[unavailabilityId]/page.tsx` | Create | Thin RSC wrapper |
| `app/workspace/team/redistribute/[unavailabilityId]/loading.tsx` | Create | Streaming skeleton |

---

### 3D — Wizard Client Component

**Type:** Frontend
**Parallelizable:** No — depends on 3A (auto-distribute mutation), 3B (manual resolve mutation), and 3C (route structure).

**What:** Create the full wizard client component at `app/workspace/team/redistribute/[unavailabilityId]/_components/redistribute-wizard-page-client.tsx` with four steps: Review, Distribute, Resolve, Complete. The component connects to the queries from Phase 2 and mutations from 3A/3B.

**Why:** This is the primary user-facing interface for the redistribution flow. It must handle complex state transitions (step advancement, meeting selection, distribution results, manual resolution), display real-time reactive data from Convex, and provide clear feedback at each step.

**Where:**
- `app/workspace/team/redistribute/[unavailabilityId]/_components/redistribute-wizard-page-client.tsx` (new)

**How:**

**Step 1: Create the wizard component with step management**

```tsx
// Path: app/workspace/team/redistribute/[unavailabilityId]/_components/redistribute-wizard-page-client.tsx

"use client";

import { useState, useMemo } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePageTitle } from "@/hooks/use-page-title";
import { useRole } from "@/components/auth/role-context";
import { useRouter } from "next/navigation";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowRightIcon,
  ArrowLeftIcon,
  ShuffleIcon,
  UserIcon,
  AlertTriangleIcon,
  CheckCircle2Icon,
  XCircleIcon,
  CalendarIcon,
  ClockIcon,
} from "lucide-react";
import { format } from "date-fns";

type WizardStep = "review" | "distribute" | "resolve" | "complete";

interface RedistributeWizardProps {
  unavailabilityId: Id<"closerUnavailability">;
}

export function RedistributeWizardPageClient({
  unavailabilityId,
}: RedistributeWizardProps) {
  usePageTitle("Redistribute Meetings");
  const router = useRouter();
  const { isAdmin } = useRole();

  const [step, setStep] = useState<WizardStep>("review");
  const [selectedMeetingIds, setSelectedMeetingIds] = useState<
    Set<string>
  >(new Set());
  const [selectedCloserIds, setSelectedCloserIds] = useState<
    Set<string>
  >(new Set());
  const [isDistributing, setIsDistributing] = useState(false);
  const [distributionResult, setDistributionResult] = useState<{
    assigned: Array<{
      meetingId: string;
      toCloserId: string;
      toCloserName: string;
    }>;
    unassigned: Array<{ meetingId: string; reason: string }>;
  } | null>(null);

  // Queries
  const data = useQuery(
    api.unavailability.queries.getUnavailabilityWithMeetings,
    { unavailabilityId },
  );
  const availableClosers = useQuery(
    api.unavailability.queries.getAvailableClosersForDate,
    data
      ? {
          date: data.unavailability.date,
          excludeCloserId: data.unavailability.closerId as Id<"users">,
        }
      : "skip",
  );

  // Mutations
  const autoDistribute = useMutation(
    api.unavailability.redistribution.autoDistributeMeetings,
  );
  const manualResolve = useMutation(
    api.unavailability.redistribution.manuallyResolveMeeting,
  );

  if (
    !isAdmin ||
    data === undefined ||
    availableClosers === undefined
  ) {
    return <WizardSkeleton />;
  }

  const { unavailability, affectedMeetings } = data;
  const pendingMeetings = affectedMeetings.filter(
    (m) => !m.alreadyReassigned,
  );
  const availableOnly = availableClosers.filter(
    (c) => c.isAvailable,
  );

  // Step handlers
  const handleAutoDistribute = async () => {
    setIsDistributing(true);
    try {
      const meetingIds = Array.from(
        selectedMeetingIds,
      ) as Id<"meetings">[];
      const candidateCloserIds = Array.from(
        selectedCloserIds,
      ) as Id<"users">[];

      const result = await autoDistribute({
        unavailabilityId,
        meetingIds,
        candidateCloserIds,
      });

      setDistributionResult(result);
      if (result.unassigned.length > 0) {
        setStep("resolve");
      } else {
        setStep("complete");
      }
    } catch (error) {
      console.error("[Redistribution] Auto-distribute failed", error);
    } finally {
      setIsDistributing(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          Redistribute Meetings
        </h1>
        <p className="text-sm text-muted-foreground">
          {unavailability.closerName} is unavailable on{" "}
          {format(
            new Date(unavailability.date),
            "EEEE, MMMM d",
          )}{" "}
          — {unavailability.reason}
        </p>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-2 text-sm">
        <StepBadge
          label="Review"
          active={step === "review"}
          done={step !== "review"}
        />
        <ArrowRightIcon className="size-4 text-muted-foreground" />
        <StepBadge
          label="Distribute"
          active={step === "distribute"}
          done={
            step === "resolve" || step === "complete"
          }
        />
        <ArrowRightIcon className="size-4 text-muted-foreground" />
        <StepBadge
          label="Resolve"
          active={step === "resolve"}
          done={step === "complete"}
        />
        <ArrowRightIcon className="size-4 text-muted-foreground" />
        <StepBadge
          label="Complete"
          active={step === "complete"}
          done={false}
        />
      </div>

      <Separator />

      {/* Step content */}
      {step === "review" && (
        <ReviewStep
          meetings={pendingMeetings}
          alreadyReassignedCount={
            affectedMeetings.length - pendingMeetings.length
          }
          selectedIds={selectedMeetingIds}
          onSelectionChange={setSelectedMeetingIds}
          onNext={() => setStep("distribute")}
        />
      )}

      {step === "distribute" && (
        <DistributeStep
          closers={availableClosers}
          selectedCloserIds={selectedCloserIds}
          onCloserSelectionChange={setSelectedCloserIds}
          selectedMeetingCount={selectedMeetingIds.size}
          onAutoDistribute={handleAutoDistribute}
          isDistributing={isDistributing}
          onBack={() => setStep("review")}
        />
      )}

      {step === "resolve" && (
        <ResolveStep
          unassignedMeetings={
            distributionResult?.unassigned ??
            Array.from(selectedMeetingIds).map((id) => ({
              meetingId: id,
              reason: "Manual assignment selected",
            }))
          }
          allMeetings={affectedMeetings}
          availableClosers={availableOnly}
          unavailabilityId={unavailabilityId}
          onManualResolve={manualResolve}
          onComplete={() => setStep("complete")}
        />
      )}

      {step === "complete" && (
        <CompleteStep
          assignedCount={distributionResult?.assigned.length ?? 0}
          onDone={() => router.push("/workspace/team")}
        />
      )}
    </div>
  );
}

// --- Subcomponents ---

function StepBadge({
  label,
  active,
  done,
}: {
  label: string;
  active: boolean;
  done: boolean;
}) {
  return (
    <Badge
      variant={active ? "default" : done ? "secondary" : "outline"}
    >
      {done && <CheckCircle2Icon className="mr-1 size-3" />}
      {label}
    </Badge>
  );
}

function WizardSkeleton() {
  return (
    <div className="flex flex-col gap-6" role="status" aria-label="Loading redistribution wizard">
      <div className="space-y-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96" />
      </div>
      <Skeleton className="h-[400px] w-full rounded-xl" />
    </div>
  );
}
```

**Step 2: Implement the ReviewStep subcomponent**

```tsx
// Path: (continued in the same file)

function ReviewStep({
  meetings,
  alreadyReassignedCount,
  selectedIds,
  onSelectionChange,
  onNext,
}: {
  meetings: Array<{
    meetingId: string;
    scheduledAt: number;
    durationMinutes: number;
    leadName: string | undefined;
    status: string;
  }>;
  alreadyReassignedCount: number;
  selectedIds: Set<string>;
  onSelectionChange: (ids: Set<string>) => void;
  onNext: () => void;
}) {
  const allSelected =
    meetings.length > 0 && selectedIds.size === meetings.length;

  const toggleAll = () => {
    if (allSelected) {
      onSelectionChange(new Set());
    } else {
      onSelectionChange(
        new Set(meetings.map((m) => m.meetingId)),
      );
    }
  };

  const toggleMeeting = (meetingId: string) => {
    const next = new Set(selectedIds);
    if (next.has(meetingId)) {
      next.delete(meetingId);
    } else {
      next.add(meetingId);
    }
    onSelectionChange(next);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Review Affected Meetings</CardTitle>
        <CardDescription>
          {meetings.length} meeting{meetings.length !== 1 ? "s" : ""}{" "}
          need redistribution.
          {alreadyReassignedCount > 0 && (
            <> ({alreadyReassignedCount} already reassigned)</>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {meetings.length === 0 ? (
          <Alert>
            <CheckCircle2Icon className="size-4" />
            <AlertDescription>
              No meetings need redistribution. All meetings have
              already been handled.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <Checkbox
                checked={allSelected}
                onCheckedChange={toggleAll}
                aria-label="Select all meetings"
              />
              <span className="text-sm font-medium">
                Select All ({selectedIds.size}/{meetings.length})
              </span>
            </div>

            <div className="space-y-2">
              {meetings.map((meeting) => (
                <div
                  key={meeting.meetingId}
                  className="flex items-center gap-3 rounded-lg border p-3"
                >
                  <Checkbox
                    checked={selectedIds.has(meeting.meetingId)}
                    onCheckedChange={() =>
                      toggleMeeting(meeting.meetingId)
                    }
                    aria-label={`Select meeting with ${meeting.leadName ?? "unknown lead"}`}
                  />
                  <div className="flex flex-1 items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">
                        {meeting.leadName ?? "Unknown Lead"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        <CalendarIcon className="mr-1 inline size-3" />
                        {format(
                          new Date(meeting.scheduledAt),
                          "h:mm a",
                        )}{" "}
                        ·{" "}
                        <ClockIcon className="mr-1 inline size-3" />
                        {meeting.durationMinutes} min
                      </p>
                    </div>
                    <Badge variant="outline">
                      {meeting.status}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>

            <Alert>
              <AlertTriangleIcon className="size-4" />
              <AlertDescription>
                Reassigning a meeting transfers the entire opportunity
                to the new closer.
              </AlertDescription>
            </Alert>
          </>
        )}

        <div className="flex justify-end">
          <Button
            onClick={onNext}
            disabled={selectedIds.size === 0}
          >
            Next: Choose Distribution
            <ArrowRightIcon className="ml-2 size-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
```

**Step 3: Implement the DistributeStep subcomponent**

```tsx
// Path: (continued in the same file)

function DistributeStep({
  closers,
  selectedCloserIds,
  onCloserSelectionChange,
  selectedMeetingCount,
  onAutoDistribute,
  isDistributing,
  onBack,
}: {
  closers: Array<{
    closerId: string;
    closerName: string;
    isAvailable: boolean;
    unavailabilityReason: string | null;
    meetingsToday: number;
  }>;
  selectedCloserIds: Set<string>;
  onCloserSelectionChange: (ids: Set<string>) => void;
  selectedMeetingCount: number;
  onAutoDistribute: () => void;
  isDistributing: boolean;
  onBack: () => void;
}) {
  const availableClosers = closers.filter((c) => c.isAvailable);
  const allAvailableSelected =
    availableClosers.length > 0 &&
    availableClosers.every((c) =>
      selectedCloserIds.has(c.closerId),
    );

  const toggleAll = () => {
    if (allAvailableSelected) {
      onCloserSelectionChange(new Set());
    } else {
      onCloserSelectionChange(
        new Set(availableClosers.map((c) => c.closerId)),
      );
    }
  };

  const toggleCloser = (closerId: string) => {
    const next = new Set(selectedCloserIds);
    if (next.has(closerId)) {
      next.delete(closerId);
    } else {
      next.add(closerId);
    }
    onCloserSelectionChange(next);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Choose Distribution</CardTitle>
        <CardDescription>
          Select candidate closers for {selectedMeetingCount}{" "}
          meeting{selectedMeetingCount !== 1 ? "s" : ""}.
          The algorithm distributes based on workload and schedule
          availability.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <Checkbox
            checked={allAvailableSelected}
            onCheckedChange={toggleAll}
            aria-label="Select all available closers"
          />
          <span className="text-sm font-medium">
            Select All Available (
            {
              availableClosers.filter((c) =>
                selectedCloserIds.has(c.closerId),
              ).length
            }
            /{availableClosers.length})
          </span>
        </div>

        <div className="space-y-2">
          {closers.map((closer) => (
            <div
              key={closer.closerId}
              className={`flex items-center gap-3 rounded-lg border p-3 ${
                !closer.isAvailable ? "opacity-50" : ""
              }`}
            >
              <Checkbox
                checked={selectedCloserIds.has(closer.closerId)}
                onCheckedChange={() =>
                  toggleCloser(closer.closerId)
                }
                disabled={!closer.isAvailable}
                aria-label={`Select ${closer.closerName}`}
              />
              <div className="flex flex-1 items-center justify-between">
                <div>
                  <p className="text-sm font-medium">
                    <UserIcon className="mr-1 inline size-3" />
                    {closer.closerName}
                  </p>
                  {closer.isAvailable ? (
                    <p className="text-xs text-muted-foreground">
                      {closer.meetingsToday} meeting
                      {closer.meetingsToday !== 1 ? "s" : ""} today
                    </p>
                  ) : (
                    <p className="text-xs text-destructive">
                      Unavailable — {closer.unavailabilityReason}
                    </p>
                  )}
                </div>
                {closer.isAvailable && (
                  <Badge
                    variant={
                      closer.meetingsToday === 0
                        ? "default"
                        : closer.meetingsToday <= 3
                          ? "secondary"
                          : "outline"
                    }
                  >
                    {closer.meetingsToday === 0
                      ? "Free"
                      : `${closer.meetingsToday} meetings`}
                  </Badge>
                )}
              </div>
            </div>
          ))}
        </div>

        {availableClosers.length === 0 && (
          <Alert variant="destructive">
            <AlertTriangleIcon className="size-4" />
            <AlertDescription>
              No closers are available on this date. All meetings
              will need manual resolution.
            </AlertDescription>
          </Alert>
        )}

        <div className="flex justify-between">
          <Button variant="outline" onClick={onBack}>
            <ArrowLeftIcon className="mr-2 size-4" />
            Back
          </Button>
          <Button
            onClick={onAutoDistribute}
            disabled={
              selectedCloserIds.size === 0 || isDistributing
            }
          >
            <ShuffleIcon className="mr-2 size-4" />
            {isDistributing
              ? "Distributing..."
              : "Auto-Distribute"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
```

**Step 4: Implement the ResolveStep and CompleteStep subcomponents**

```tsx
// Path: (continued in the same file)

function ResolveStep({
  unassignedMeetings,
  allMeetings,
  availableClosers,
  unavailabilityId,
  onManualResolve,
  onComplete,
}: {
  unassignedMeetings: Array<{
    meetingId: string;
    reason: string;
  }>;
  allMeetings: Array<{
    meetingId: string;
    scheduledAt: number;
    durationMinutes: number;
    leadName: string | undefined;
  }>;
  availableClosers: Array<{
    closerId: string;
    closerName: string;
  }>;
  unavailabilityId: Id<"closerUnavailability">;
  onManualResolve: (args: {
    meetingId: Id<"meetings">;
    unavailabilityId: Id<"closerUnavailability">;
    action: "assign" | "cancel";
    targetCloserId?: Id<"users">;
  }) => Promise<any>;
  onComplete: () => void;
}) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedCloserId, setSelectedCloserId] = useState<
    string | undefined
  >(undefined);
  const [isResolving, setIsResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(
    null,
  );

  const currentUnassigned = unassignedMeetings[currentIndex];
  if (!currentUnassigned) {
    // All resolved
    onComplete();
    return null;
  }

  const meetingDetails = allMeetings.find(
    (m) => m.meetingId === currentUnassigned.meetingId,
  );

  const handleAssign = async () => {
    if (!selectedCloserId) return;
    setIsResolving(true);
    setResolveError(null);
    try {
      await onManualResolve({
        meetingId: currentUnassigned.meetingId as Id<"meetings">,
        unavailabilityId,
        action: "assign",
        targetCloserId: selectedCloserId as Id<"users">,
      });
      setSelectedCloserId(undefined);
      setCurrentIndex((i) => i + 1);
    } catch (error) {
      setResolveError(
        error instanceof Error
          ? error.message
          : "Failed to assign meeting",
      );
    } finally {
      setIsResolving(false);
    }
  };

  const handleCancel = async () => {
    setIsResolving(true);
    setResolveError(null);
    try {
      await onManualResolve({
        meetingId: currentUnassigned.meetingId as Id<"meetings">,
        unavailabilityId,
        action: "cancel",
      });
      setCurrentIndex((i) => i + 1);
    } catch (error) {
      setResolveError(
        error instanceof Error
          ? error.message
          : "Failed to cancel meeting",
      );
    } finally {
      setIsResolving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Manual Resolution</CardTitle>
        <CardDescription>
          {unassignedMeetings.length - currentIndex} meeting
          {unassignedMeetings.length - currentIndex !== 1
            ? "s"
            : ""}{" "}
          remaining. {currentUnassigned.reason}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {meetingDetails && (
          <div className="rounded-lg border p-4">
            <p className="text-sm font-medium">
              {meetingDetails.leadName ?? "Unknown Lead"}
            </p>
            <p className="text-xs text-muted-foreground">
              <CalendarIcon className="mr-1 inline size-3" />
              {format(
                new Date(meetingDetails.scheduledAt),
                "h:mm a",
              )}{" "}
              · <ClockIcon className="mr-1 inline size-3" />
              {meetingDetails.durationMinutes} min
            </p>
          </div>
        )}

        {resolveError && (
          <Alert variant="destructive">
            <AlertTriangleIcon className="size-4" />
            <AlertDescription>{resolveError}</AlertDescription>
          </Alert>
        )}

        <div className="space-y-3">
          <p className="text-sm font-medium">
            Assign to a closer:
          </p>
          <Select
            value={selectedCloserId}
            onValueChange={setSelectedCloserId}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select a closer" />
            </SelectTrigger>
            <SelectContent>
              {availableClosers.map((closer) => (
                <SelectItem
                  key={closer.closerId}
                  value={closer.closerId}
                >
                  {closer.closerName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex gap-2">
            <Button
              onClick={handleAssign}
              disabled={!selectedCloserId || isResolving}
            >
              <UserIcon className="mr-2 size-4" />
              {isResolving ? "Assigning..." : "Force Assign"}
            </Button>
            <Button
              variant="destructive"
              onClick={handleCancel}
              disabled={isResolving}
            >
              <XCircleIcon className="mr-2 size-4" />
              Cancel Meeting
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function CompleteStep({
  assignedCount,
  onDone,
}: {
  assignedCount: number;
  onDone: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <CheckCircle2Icon className="size-8 text-emerald-500" />
          <div>
            <CardTitle>Redistribution Complete</CardTitle>
            <CardDescription>
              {assignedCount} meeting
              {assignedCount !== 1 ? "s" : ""} have been
              redistributed successfully.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <Button onClick={onDone}>Back to Team</Button>
      </CardContent>
    </Card>
  );
}
```

**Key implementation notes:**
- The wizard uses local `useState` for step management — not URL-based routing — because the steps are sequential and don't benefit from deep linking.
- `useQuery` with `"skip"` pattern: `availableClosers` query is skipped until the unavailability data loads (avoids sending a query with missing args).
- The `ReviewStep` includes the "Reassigning a meeting transfers the entire opportunity" warning per the design doc's edge case 12.6.
- The `ResolveStep` processes unassigned meetings one at a time with a `currentIndex` counter — simpler than trying to manage parallel resolution.
- `isDistributing` state disables the Auto-Distribute button during the mutation to prevent double-clicks.
- Convex reactivity: if a meeting gets canceled by a Calendly webhook while the wizard is open, the `getUnavailabilityWithMeetings` query auto-updates and the meeting disappears from the list.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/team/redistribute/[unavailabilityId]/_components/redistribute-wizard-page-client.tsx` | Create | Full wizard with 4 steps + 5 subcomponents |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/unavailability/redistribution.ts` | Create | 3A |
| `convex/unavailability/redistribution.ts` | Modify | 3B |
| `app/workspace/team/redistribute/[unavailabilityId]/page.tsx` | Create | 3C |
| `app/workspace/team/redistribute/[unavailabilityId]/loading.tsx` | Create | 3C |
| `app/workspace/team/redistribute/[unavailabilityId]/_components/redistribute-wizard-page-client.tsx` | Create | 3D |
