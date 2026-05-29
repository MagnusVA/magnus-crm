# Phase 2 — Overview UI Composition

**Goal:** Replace the current tenant owner/admin `/workspace` dashboard with a compact operations overview that consumes the Phase 1 overview query. After this phase, the page has one shared range control, three mini dashboards, two full-width operational tables, stable loading states, and responsive behavior verified at mobile and desktop sizes.

**Prerequisite:** Phase 1A DTOs are stable for UI scaffolding. Final query wiring requires Phase 1E complete and Convex generated API types refreshed.

**Runs in PARALLEL with:** Late Phase 1 helper work after DTOs stabilize. Phase 2A-2E can use typed fixtures or local component props while Phase 1 finishes; Phase 2F final wiring waits for `api.dashboard.overview.getOverviewDashboard`.

**Skills to invoke:**
- `frontend-design` — craft a dense, refined operations dashboard instead of a generic card grid.
- `shadcn` — compose existing `Card`, `Table`, `Badge`, `Alert`, `Empty`, `Popover`, `Calendar`, `ToggleGroup`, `Tooltip`, and `Skeleton` primitives.
- `next-best-practices` — keep `app/workspace/page.tsx` as a thin server component and interactivity inside client components.
- `vercel-react-best-practices` — reduce subscriptions, keep props small, avoid unnecessary effects, and memoize only where useful.
- `browser:browser` — verify final responsive layout, popover usability, and table overflow.

**Acceptance Criteria:**
1. `/workspace` still uses a thin server page with `unstable_instant = false`, `requireWorkspaceUser()`, and role redirects for `closer` and `lead_generator`.
2. `DashboardPageClient` calls only `api.dashboard.overview.getOverviewDashboard` for dashboard data and removes the old `getCurrentUser`, `getAdminDashboardStats`, `getTimePeriodStats`, and fixed-window Slack metric subscriptions from this page.
3. The shared range control supports Day, Week, Month, and Custom, with client-side validation for incomplete, reversed, or over-120-day custom ranges.
4. While a custom range is incomplete or invalid, the last successful overview remains visible and no Convex query is fired for invalid args.
5. Lead Gen, Top Qualifiers, and Top DM Closers render as compact top cards with consistent `ready`, `empty`, `capped`, and `error` states.
6. Phone Closer Operations renders a full-width table with totals, stable horizontal overflow, and no revenue or sales columns.
7. Top Posts & Reels renders a full-width table ranked by submissions and includes origin, kind, submissions, and unique prospects.
8. Loading skeletons match final dashboard dimensions closely enough to avoid visible layout shift.
9. Mobile width around 390px and desktop width around 1440px show no overlapping text, clipped controls, or page-level horizontal overflow outside table wrappers.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
2A (frontend types + state primitives) ─────┬── 2B (range control)
                                           ├── 2C (top cards)
                                           ├── 2D (phone operations table)
                                           └── 2E (top origins table)

2B + 2C + 2D + 2E ─────────────────────────── 2F (page client + skeleton wiring)

2F complete ───────────────────────────────── 2G (responsive polish pass)
```

**Optimal execution:**
1. Start 2A immediately after Phase 1A so every UI stream shares the same `OverviewDashboard` and `SectionResult` aliases.
2. Run 2B, 2C, 2D, and 2E in parallel. They touch separate component files and can be built against mocked props.
3. Run 2F once the range control and section components exist and Phase 1E exposes the generated query reference.
4. Finish with 2G in the browser after the real dashboard page renders.

**Estimated time:** 3-5 days

---

## Subphases

### 2A — Frontend Types, Formatters, and Section State Primitives

**Type:** Frontend
**Parallelizable:** No — all UI subphases should import the same type aliases, number formatters, and section-state components.

**What:** Add local UI type aliases derived from the generated Convex API, shared formatting helpers, and reusable section-state renderers for `empty`, `capped`, and `error` envelopes.

**Why:** The top cards and tables need consistent status handling and numeric formatting. A small shared layer prevents each component from inventing its own capped/error UI.

**Where:**
- `app/workspace/_components/overview-dashboard-types.ts` (new)
- `app/workspace/_components/overview-formatters.ts` (new)
- `app/workspace/_components/overview-section-state.tsx` (new)

**How:**

**Step 1: Derive frontend types from the Convex query.**

```typescript
// Path: app/workspace/_components/overview-dashboard-types.ts
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";

export type OverviewDashboard = FunctionReturnType<
  typeof api.dashboard.overview.getOverviewDashboard
>;

export type OverviewSection<T extends keyof OverviewDashboard> =
  OverviewDashboard[T];

export type LeadGenOverviewSection = OverviewSection<"leadGen">;
export type TopQualifiersSection = OverviewSection<"topQualifiers">;
export type TopDmClosersSection = OverviewSection<"topDmClosers">;
export type PhoneCloserOperationsSectionData =
  OverviewSection<"phoneCloserOperations">;
export type TopOriginsSection = OverviewSection<"topOrigins">;
```

**Step 2: Add deterministic number and rate formatters.**

```typescript
// Path: app/workspace/_components/overview-formatters.ts
const numberFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
});

const compactNumberFormatter = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

const rateFormatter = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 0,
});

export function formatWholeNumber(value: number) {
  return numberFormatter.format(value);
}

export function formatCompactNumber(value: number) {
  return compactNumberFormatter.format(value);
}

export function formatDecimal(value: number | null, digits = 1) {
  if (value === null || !Number.isFinite(value)) return "N/A";
  return value.toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

export function formatRate(value: number | null) {
  return value === null || !Number.isFinite(value)
    ? "N/A"
    : rateFormatter.format(value);
}

export function formatOriginValue(originValue: string) {
  try {
    const url = new URL(originValue);
    return `${url.hostname.replace(/^www\./, "")}${url.pathname}`;
  } catch {
    return originValue;
  }
}
```

**Step 3: Add reusable section-state UI.**

```tsx
// Path: app/workspace/_components/overview-section-state.tsx
import { AlertCircleIcon, InfoIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";

export function OverviewEmptyState({ message }: { message: string | null }) {
  return (
    <Empty className="py-8">
      <EmptyHeader>
        <EmptyTitle>No activity</EmptyTitle>
      </EmptyHeader>
      <EmptyContent>{message ?? "No activity for this range."}</EmptyContent>
    </Empty>
  );
}

export function OverviewCappedState({ message }: { message: string | null }) {
  return (
    <Alert variant="destructive">
      <AlertCircleIcon aria-hidden="true" />
      <AlertTitle>Range too large</AlertTitle>
      <AlertDescription>
        {message ?? "Narrow the date range to load this section."}
      </AlertDescription>
    </Alert>
  );
}

export function OverviewErrorState({ message }: { message: string | null }) {
  return (
    <Alert variant="destructive">
      <AlertCircleIcon aria-hidden="true" />
      <AlertTitle>Section unavailable</AlertTitle>
      <AlertDescription>
        {message ?? "This section could not be loaded."}
      </AlertDescription>
    </Alert>
  );
}

export function OverviewTruncatedNote() {
  return (
    <Alert>
      <InfoIcon aria-hidden="true" />
      <AlertTitle>Partial data</AlertTitle>
      <AlertDescription>
        This range hit the Slack event cap. Rankings use the available sample.
      </AlertDescription>
    </Alert>
  );
}
```

**Key implementation notes:**
- Keep this layer presentation-only. It should not know how to fetch data or interpret roles.
- Use semantic shadcn variants and existing icons; do not introduce raw status colors.
- `FunctionReturnType` keeps frontend props aligned with generated Convex output and avoids duplicating DTOs in the app tree.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/overview-dashboard-types.ts` | Create | Generated API-derived dashboard types |
| `app/workspace/_components/overview-formatters.ts` | Create | Shared number, rate, and origin formatters |
| `app/workspace/_components/overview-section-state.tsx` | Create | Reusable section empty/capped/error/truncated UI |

---

### 2B — Dashboard Date Range Control

**Type:** Frontend
**Parallelizable:** Yes — depends on 2A type conventions but does not touch cards, tables, or page wiring.

**What:** Build a compact Day/Week/Month/Custom range control using `ToggleGroup`, `Popover`, and `Calendar`, with local validation and explicit business-date strings.

**Why:** One shared range controls every section. The client should prevent obvious invalid requests, while Convex remains the authority for canonical boundaries.

**Where:**
- `app/workspace/_components/dashboard-date-utils.ts` (new)
- `app/workspace/_components/dashboard-date-range-filter.tsx` (new)

**How:**

**Step 1: Add client-side business-date utilities.**

```typescript
// Path: app/workspace/_components/dashboard-date-utils.ts
const DAY_MS = 24 * 60 * 60 * 1000;
const BUSINESS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_DASHBOARD_CUSTOM_DAYS = 120;

export function calendarDateToBusinessDate(date: Date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export function businessDateToCalendarDate(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function countCalendarDaysInclusive(start: string, end: string) {
  if (!BUSINESS_DATE_PATTERN.test(start) || !BUSINESS_DATE_PATTERN.test(end)) {
    return null;
  }

  const startDate = businessDateToCalendarDate(start).getTime();
  const endDate = businessDateToCalendarDate(end).getTime();
  return Math.floor((endDate - startDate) / DAY_MS) + 1;
}

export function validateCustomDashboardRange(args: {
  startBusinessDate?: string;
  endBusinessDateInclusive?: string;
}) {
  if (!args.startBusinessDate || !args.endBusinessDateInclusive) {
    return "Choose a start and end date.";
  }
  if (args.startBusinessDate > args.endBusinessDateInclusive) {
    return "Choose an end date on or after the start date.";
  }

  const days = countCalendarDaysInclusive(
    args.startBusinessDate,
    args.endBusinessDateInclusive,
  );
  if (days === null) return "Choose valid calendar dates.";
  if (days > MAX_DASHBOARD_CUSTOM_DAYS) {
    return `Choose ${MAX_DASHBOARD_CUSTOM_DAYS} days or fewer.`;
  }

  return null;
}
```

**Step 2: Build the range filter.**

```tsx
// Path: app/workspace/_components/dashboard-date-range-filter.tsx
"use client";

import { useMemo, useState } from "react";
import type { DateRange } from "react-day-picker";
import { CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  businessDateToCalendarDate,
  calendarDateToBusinessDate,
  validateCustomDashboardRange,
} from "./dashboard-date-utils";

export type DashboardRangeInput =
  | { kind: "preset"; preset: "today" | "this_week" | "this_month" }
  | {
      kind: "custom";
      startBusinessDate: string;
      endBusinessDateInclusive: string;
    };

type Props = {
  value: DashboardRangeInput;
  onChange: (value: DashboardRangeInput) => void;
  validationMessage: string | null;
};

export function DashboardDateRangeFilter({
  value,
  onChange,
  validationMessage,
}: Props) {
  const [draftRange, setDraftRange] = useState<DateRange | undefined>(() =>
    value.kind === "custom"
      ? {
          from: businessDateToCalendarDate(value.startBusinessDate),
          to: businessDateToCalendarDate(value.endBusinessDateInclusive),
        }
      : undefined,
  );
  const presetValue = value.kind === "preset" ? value.preset : "custom";
  const draftBusinessRange = useMemo(
    () => ({
      startBusinessDate: draftRange?.from
        ? calendarDateToBusinessDate(draftRange.from)
        : undefined,
      endBusinessDateInclusive: draftRange?.to
        ? calendarDateToBusinessDate(draftRange.to)
        : undefined,
    }),
    [draftRange],
  );
  const draftError = validateCustomDashboardRange(draftBusinessRange);

  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          type="single"
          value={presetValue}
          onValueChange={(next) => {
            if (next === "today" || next === "this_week" || next === "this_month") {
              onChange({ kind: "preset", preset: next });
            }
          }}
          variant="outline"
          size="sm"
          aria-label="Dashboard range"
        >
          <ToggleGroupItem value="today" aria-label="Day">Day</ToggleGroupItem>
          <ToggleGroupItem value="this_week" aria-label="Week">Week</ToggleGroupItem>
          <ToggleGroupItem value="this_month" aria-label="Month">Month</ToggleGroupItem>
        </ToggleGroup>

        <Popover>
          <PopoverTrigger asChild>
            <Button variant={presetValue === "custom" ? "default" : "outline"} size="sm">
              <CalendarIcon data-icon="inline-start" />
              Custom
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-auto p-2">
            <Calendar
              mode="range"
              selected={draftRange}
              onSelect={setDraftRange}
              numberOfMonths={2}
            />
            <div className="flex items-center justify-between gap-3 border-t px-2 pt-2">
              <p className="min-w-0 text-xs text-muted-foreground">
                {draftError ?? "Range ready."}
              </p>
              <Button
                size="sm"
                disabled={draftError !== null}
                onClick={() => {
                  if (!draftBusinessRange.startBusinessDate || !draftBusinessRange.endBusinessDateInclusive) {
                    return;
                  }
                  onChange({
                    kind: "custom",
                    startBusinessDate: draftBusinessRange.startBusinessDate,
                    endBusinessDateInclusive:
                      draftBusinessRange.endBusinessDateInclusive,
                  });
                }}
              >
                Apply
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>
      {validationMessage ? (
        <p className="text-xs text-destructive">{validationMessage}</p>
      ) : null}
    </div>
  );
}
```

**Step 3: Use the range only when it is valid in the page client.**

```tsx
// Path: app/workspace/_components/dashboard-page-client.tsx
const rangeValidationMessage =
  range.kind === "custom"
    ? validateCustomDashboardRange({
        startBusinessDate: range.startBusinessDate,
        endBusinessDateInclusive: range.endBusinessDateInclusive,
      })
    : null;
const overview = useQuery(
  api.dashboard.overview.getOverviewDashboard,
  isAdmin && rangeValidationMessage === null ? { range } : "skip",
);
```

**Key implementation notes:**
- Keep `Custom` as a button plus popover, not a fourth toggle value that fires invalid half-ranges.
- The page owns the last successful overview state so this component stays stateless beyond the popover draft.
- `Calendar` can render two months on desktop; if mobile width is cramped during 2G, reduce to one month below `sm`.
- The visible copy should be operational and compact; do not add in-app tutorial text.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/dashboard-date-utils.ts` | Create | Client-side date conversion and validation |
| `app/workspace/_components/dashboard-date-range-filter.tsx` | Create | Day/Week/Month/Custom range control |
| `app/workspace/_components/dashboard-page-client.tsx` | Modify | Skip invalid custom ranges and pass validation state |

---

### 2C — Top Mini Dashboard Cards

**Type:** Frontend
**Parallelizable:** Yes — consumes 2A primitives and can be built independently from tables.

**What:** Build the top row: Lead Gen Overview, Top Qualifiers, and Top DM Closers, each with compact ranked rows and consistent section-state handling.

**Why:** These are glanceable operational summaries, not marketing cards. They should prioritize scan speed, stable row height, and clear ranking context.

**Where:**
- `app/workspace/_components/overview-top-cards.tsx` (new)
- `app/workspace/_components/lead-gen-overview-card.tsx` (new)
- `app/workspace/_components/top-qualifiers-card.tsx` (new)
- `app/workspace/_components/top-dm-closers-card.tsx` (new)

**How:**

**Step 1: Add the responsive top-card grid.**

```tsx
// Path: app/workspace/_components/overview-top-cards.tsx
import type { OverviewDashboard } from "./overview-dashboard-types";
import { LeadGenOverviewCard } from "./lead-gen-overview-card";
import { TopDmClosersCard } from "./top-dm-closers-card";
import { TopQualifiersCard } from "./top-qualifiers-card";

export function OverviewTopCards({ overview }: { overview: OverviewDashboard }) {
  return (
    <section
      className="grid grid-cols-1 gap-4 lg:grid-cols-3"
      aria-label="Overview highlights"
    >
      <LeadGenOverviewCard section={overview.leadGen} />
      <TopQualifiersCard section={overview.topQualifiers} />
      <TopDmClosersCard section={overview.topDmClosers} />
    </section>
  );
}
```

**Step 2: Build the Lead Gen card.**

```tsx
// Path: app/workspace/_components/lead-gen-overview-card.tsx
import { ClipboardListIcon } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { LeadGenOverviewSection } from "./overview-dashboard-types";
import { formatDecimal, formatWholeNumber } from "./overview-formatters";
import {
  OverviewCappedState,
  OverviewEmptyState,
  OverviewErrorState,
} from "./overview-section-state";

export function LeadGenOverviewCard({
  section,
}: {
  section: LeadGenOverviewSection;
}) {
  return (
    <Card className="min-w-0" size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ClipboardListIcon aria-hidden="true" />
          Lead Gen
        </CardTitle>
        <CardDescription>Submissions, uniqueness, and top generators</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {section.status === "capped" ? (
          <OverviewCappedState message={section.message} />
        ) : section.status === "error" ? (
          <OverviewErrorState message={section.message} />
        ) : section.status === "empty" ? (
          <OverviewEmptyState message={section.message} />
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3">
              <Metric label="Submissions" value={formatWholeNumber(section.data.totalSubmissions)} />
              <Metric label="Unique" value={formatWholeNumber(section.data.uniqueProspects)} />
              <Metric label="Leads/hr" value={formatDecimal(section.data.leadsPerHour)} />
            </div>
            <ol className="flex flex-col gap-2" aria-label="Top lead generators">
              {section.data.topWorkers.map((worker, index) => (
                <li
                  key={worker.workerId}
                  className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-2 text-sm"
                >
                  <span className="text-muted-foreground tabular-nums">{index + 1}</span>
                  <span className="truncate font-medium">{worker.displayName}</span>
                  <span className="tabular-nums">
                    {formatWholeNumber(worker.submissions)}
                  </span>
                </li>
              ))}
            </ol>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}
```

**Step 3: Build the Top Qualifiers card with truncation awareness.**

```tsx
// Path: app/workspace/_components/top-qualifiers-card.tsx
import { MessageSquareCheckIcon } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { TopQualifiersSection } from "./overview-dashboard-types";
import { formatRate, formatWholeNumber } from "./overview-formatters";
import {
  OverviewCappedState,
  OverviewEmptyState,
  OverviewErrorState,
  OverviewTruncatedNote,
} from "./overview-section-state";

export function TopQualifiersCard({ section }: { section: TopQualifiersSection }) {
  return (
    <Card className="min-w-0" size="sm">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2">
              <MessageSquareCheckIcon aria-hidden="true" />
              Top Qualifiers
            </CardTitle>
            <CardDescription>Slack-qualified opportunity activity</CardDescription>
          </div>
          {section.status === "ready" && section.truncated ? (
            <Badge variant="secondary">Partial</Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {section.status === "capped" ? (
          <OverviewCappedState message={section.message} />
        ) : section.status === "error" ? (
          <OverviewErrorState message={section.message} />
        ) : section.status === "empty" ? (
          <OverviewEmptyState message={section.message} />
        ) : (
          <>
            {section.truncated ? <OverviewTruncatedNote /> : null}
            <ol className="flex flex-col gap-3" aria-label="Top Slack qualifiers">
              {section.data.rows.map((row, index) => (
                <li
                  key={row.slackUserId}
                  className="grid grid-cols-[1.5rem_auto_minmax(0,1fr)_auto] items-center gap-2"
                >
                  <span className="text-sm text-muted-foreground tabular-nums">
                    {index + 1}
                  </span>
                  <Avatar className="size-7">
                    <AvatarImage src={row.avatarUrl ?? undefined} alt="" />
                    <AvatarFallback>
                      {(row.displayName ?? "?").slice(0, 1).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {row.displayName ?? row.slackUserId}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {formatWholeNumber(row.booked)} booked /{" "}
                      {formatWholeNumber(row.uniqueOpportunityCount)} opps
                    </p>
                  </div>
                  <span className="text-sm font-medium tabular-nums">
                    {formatRate(row.ratio)}
                  </span>
                </li>
              ))}
            </ol>
          </>
        )}
      </CardContent>
    </Card>
  );
}
```

**Step 4: Build the Top DM Closers card.**

```tsx
// Path: app/workspace/_components/top-dm-closers-card.tsx
import { SendIcon } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { TopDmClosersSection } from "./overview-dashboard-types";
import { formatRate, formatWholeNumber } from "./overview-formatters";
import {
  OverviewCappedState,
  OverviewEmptyState,
  OverviewErrorState,
} from "./overview-section-state";

export function TopDmClosersCard({ section }: { section: TopDmClosersSection }) {
  return (
    <Card className="min-w-0" size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SendIcon aria-hidden="true" />
          Top DM Closers
        </CardTitle>
        <CardDescription>Ranked by booked-call attribution</CardDescription>
      </CardHeader>
      <CardContent>
        {section.status === "capped" ? (
          <OverviewCappedState message={section.message} />
        ) : section.status === "error" ? (
          <OverviewErrorState message={section.message} />
        ) : section.status === "empty" ? (
          <OverviewEmptyState message={section.message} />
        ) : (
          <ol className="flex flex-col gap-3" aria-label="Top DM closers">
            {section.data.rows.map((row, index) => (
              <li
                key={row.dmCloserId}
                className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-2 text-sm"
              >
                <span className="text-muted-foreground tabular-nums">{index + 1}</span>
                <div className="min-w-0">
                  <p className="truncate font-medium">{row.displayName}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {row.teamName ?? "No team"} · {formatRate(row.showRate)} show
                  </p>
                </div>
                <span className="font-medium tabular-nums">
                  {formatWholeNumber(row.scheduled)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
```

**Key implementation notes:**
- Top cards should have similar internal spacing, but do not force equal heights with fixed pixel values until 2G verifies content.
- Use ranked `ol` elements for semantic order.
- Keep labels short enough for mobile. Long explanatory text belongs in the design doc, not the UI.
- Use `AvatarFallback` for Slack users; shadcn `Avatar` always needs a fallback.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/overview-top-cards.tsx` | Create | Responsive top-card grid |
| `app/workspace/_components/lead-gen-overview-card.tsx` | Create | Lead Gen overview card |
| `app/workspace/_components/top-qualifiers-card.tsx` | Create | Slack qualifier leaderboard card |
| `app/workspace/_components/top-dm-closers-card.tsx` | Create | DM closer leaderboard card |

---

### 2D — Phone Closer Operations Section

**Type:** Frontend
**Parallelizable:** Yes — consumes 2A primitives and is independent of top cards and top origins.

**What:** Create a full-width Phone Closer Operations section and table using the Phase 1 `phoneCloserOperations` envelope.

**Why:** The redesigned dashboard centers the operations table as the primary repeated-use surface. It needs dense columns, totals, and controlled overflow without inheriting the full team report.

**Where:**
- `app/workspace/_components/phone-closer-operations-section.tsx` (new)
- `app/workspace/_components/phone-closer-operations-table.tsx` (new)

**How:**

**Step 1: Add the section wrapper.**

```tsx
// Path: app/workspace/_components/phone-closer-operations-section.tsx
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { PhoneCloserOperationsSectionData } from "./overview-dashboard-types";
import {
  OverviewCappedState,
  OverviewEmptyState,
  OverviewErrorState,
} from "./overview-section-state";
import { PhoneCloserOperationsTable } from "./phone-closer-operations-table";

export function PhoneCloserOperationsSection({
  section,
}: {
  section: PhoneCloserOperationsSectionData;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Phone Closer Operations</CardTitle>
        <CardDescription>
          Booked-call outcomes by assigned phone closer.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {section.status === "capped" ? (
          <OverviewCappedState message={section.message} />
        ) : section.status === "error" ? (
          <OverviewErrorState message={section.message} />
        ) : section.status === "empty" ? (
          <OverviewEmptyState message={section.message} />
        ) : (
          <PhoneCloserOperationsTable data={section.data} />
        )}
      </CardContent>
    </Card>
  );
}
```

**Step 2: Add the table with internal horizontal overflow.**

```tsx
// Path: app/workspace/_components/phone-closer-operations-table.tsx
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { PhoneCloserOperationsSectionData } from "./overview-dashboard-types";
import { formatRate, formatWholeNumber } from "./overview-formatters";

type ReadyData = Extract<
  PhoneCloserOperationsSectionData,
  { status: "ready" }
>["data"];

export function PhoneCloserOperationsTable({ data }: { data: ReadyData }) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table className="min-w-[52rem]">
        <TableHeader>
          <TableRow>
            <TableHead>Phone closer</TableHead>
            <TableHead className="text-right">Booked calls</TableHead>
            <TableHead className="text-right">Completed</TableHead>
            <TableHead className="text-right">No shows</TableHead>
            <TableHead className="text-right">Review req.</TableHead>
            <TableHead className="text-right">Show rate</TableHead>
            <TableHead className="text-right">No-show rate</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.rows.map((row) => (
            <TableRow key={row.closerId}>
              <TableCell className="max-w-64 truncate font-medium">
                {row.closerName}
              </TableCell>
              <NumericCell value={formatWholeNumber(row.scheduled)} />
              <NumericCell value={formatWholeNumber(row.completed)} />
              <NumericCell value={formatWholeNumber(row.noShows)} />
              <NumericCell value={formatWholeNumber(row.reviewRequired)} />
              <NumericCell value={formatRate(row.showRate)} />
              <NumericCell value={formatRate(row.noShowRate)} />
            </TableRow>
          ))}
          <TableRow>
            <TableCell className="font-semibold">Total</TableCell>
            <NumericCell strong value={formatWholeNumber(data.totals.scheduled)} />
            <NumericCell strong value={formatWholeNumber(data.totals.completed)} />
            <NumericCell strong value={formatWholeNumber(data.totals.noShows)} />
            <NumericCell strong value={formatWholeNumber(data.totals.reviewRequired)} />
            <NumericCell strong value={formatRate(data.totals.showRate)} />
            <NumericCell strong value={formatRate(data.totals.noShowRate)} />
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}

function NumericCell({ value, strong = false }: { value: string; strong?: boolean }) {
  return (
    <TableCell className={strong ? "text-right font-semibold tabular-nums" : "text-right tabular-nums"}>
      {value}
    </TableCell>
  );
}
```

**Key implementation notes:**
- Keep page-level width stable; only the table wrapper should scroll horizontally.
- Do not include sales, revenue, payment, or close-rate columns in this overview table.
- The totals row is always rendered for ready data, even when there is one closer.
- If 2G finds text clipping in table cells, widen `min-w-[52rem]` or reduce header copy before shrinking font sizes.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/phone-closer-operations-section.tsx` | Create | Section wrapper and state handling |
| `app/workspace/_components/phone-closer-operations-table.tsx` | Create | Dense operations table |

---

### 2E — Top Posts & Reels Section

**Type:** Frontend
**Parallelizable:** Yes — consumes 2A primitives and is independent of top cards and phone operations.

**What:** Create the Top Posts & Reels full-width section and table using the `topOrigins` envelope.

**Why:** Admins need to see which posts/reels drive submissions in the same operational range as the other dashboard sections. The dashboard table should be compact and purpose-built instead of importing a route-local lead-gen table directly.

**Where:**
- `app/workspace/_components/top-origins-overview-section.tsx` (new)
- `app/workspace/_components/top-origins-overview-table.tsx` (new)

**How:**

**Step 1: Add the section wrapper.**

```tsx
// Path: app/workspace/_components/top-origins-overview-section.tsx
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { TopOriginsSection } from "./overview-dashboard-types";
import {
  OverviewCappedState,
  OverviewEmptyState,
  OverviewErrorState,
} from "./overview-section-state";
import { TopOriginsOverviewTable } from "./top-origins-overview-table";

export function TopOriginsOverviewSection({
  section,
}: {
  section: TopOriginsSection;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Top Posts & Reels</CardTitle>
        <CardDescription>
          Ranked by submissions for the selected range.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {section.status === "capped" ? (
          <OverviewCappedState message={section.message} />
        ) : section.status === "error" ? (
          <OverviewErrorState message={section.message} />
        ) : section.status === "empty" ? (
          <OverviewEmptyState message={section.message} />
        ) : (
          <TopOriginsOverviewTable rows={section.data.rows} />
        )}
      </CardContent>
    </Card>
  );
}
```

**Step 2: Add the table with external-link affordances.**

```tsx
// Path: app/workspace/_components/top-origins-overview-table.tsx
import { ExternalLinkIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatOriginValue, formatWholeNumber } from "./overview-formatters";
import type { TopOriginsSection } from "./overview-dashboard-types";

type ReadyRows = Extract<TopOriginsSection, { status: "ready" }>["data"]["rows"];

export function TopOriginsOverviewTable({ rows }: { rows: ReadyRows }) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table className="min-w-[44rem] table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[56%]">Origin</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead className="text-right">Submissions</TableHead>
            <TableHead className="text-right">Unique prospects</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={`${row.source}:${row.originKey}`}>
              <TableCell className="max-w-0">
                <a
                  className="flex min-w-0 items-center gap-2 truncate underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  href={row.originValue}
                  rel="noreferrer"
                  target="_blank"
                  title={row.originValue}
                >
                  <span className="truncate">{formatOriginValue(row.originValue)}</span>
                  <ExternalLinkIcon aria-hidden="true" />
                </a>
              </TableCell>
              <TableCell>
                <Badge variant="outline">{formatOriginKind(row.originKind)}</Badge>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatWholeNumber(row.submissions)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatWholeNumber(row.uniqueProspects)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function formatOriginKind(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
```

**Key implementation notes:**
- This table intentionally ranks by submissions. Do not reorder client-side by unique prospects.
- Use a shared workspace component rather than importing from `app/workspace/lead-gen/_components` unless that table is deliberately moved to shared ownership.
- Links should be focusable and have visible focus rings.
- If an origin value is not a URL, the `<a>` should be replaced with non-link text during implementation to avoid invalid navigation.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/top-origins-overview-section.tsx` | Create | Section wrapper and state handling |
| `app/workspace/_components/top-origins-overview-table.tsx` | Create | Top posts/reels table |

---

### 2F — Page Client, Query Wiring, and Dashboard Skeleton

**Type:** Frontend
**Parallelizable:** No — integrates all Phase 2 components with the real Phase 1 API.

**What:** Replace the old dashboard client with the new overview layout, one Convex query, last-good-data handling, and a matching skeleton.

**Why:** This is the user-facing cutover from the old dashboard to the redesigned overview. It must preserve route auth, reduce subscriptions, and keep the page usable while range changes load.

**Where:**
- `app/workspace/_components/dashboard-page-client.tsx` (modify)
- `app/workspace/_components/skeletons/overview-dashboard-skeleton.tsx` (new)
- `app/workspace/page.tsx` (verify only; no change expected)

**How:**

**Step 1: Add the skeleton.**

```tsx
// Path: app/workspace/_components/skeletons/overview-dashboard-skeleton.tsx
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function OverviewDashboardSkeleton() {
  return (
    <div
      className="mx-auto flex w-full max-w-[1500px] flex-col gap-5"
      role="status"
      aria-label="Loading overview dashboard"
    >
      <div className="flex flex-col gap-3 border-b pb-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-44" />
          <Skeleton className="h-4 w-64 max-w-full" />
        </div>
        <Skeleton className="h-9 w-72 max-w-full" />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <Card key={index} size="sm">
            <CardHeader>
              <Skeleton className="h-5 w-36" />
              <Skeleton className="h-4 w-52 max-w-full" />
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-24 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Skeleton className="h-[360px] w-full rounded-lg" />
      <Skeleton className="h-[320px] w-full rounded-lg" />
    </div>
  );
}
```

**Step 2: Replace old dashboard queries with the overview query.**

```tsx
// Path: app/workspace/_components/dashboard-page-client.tsx
"use client";

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePageTitle } from "@/hooks/use-page-title";
import { useRole } from "@/components/auth/role-context";
import {
  DashboardDateRangeFilter,
  type DashboardRangeInput,
} from "./dashboard-date-range-filter";
import { validateCustomDashboardRange } from "./dashboard-date-utils";
import type { OverviewDashboard } from "./overview-dashboard-types";
import { OverviewTopCards } from "./overview-top-cards";
import { PhoneCloserOperationsSection } from "./phone-closer-operations-section";
import { TopOriginsOverviewSection } from "./top-origins-overview-section";
import { OverviewDashboardSkeleton } from "./skeletons/overview-dashboard-skeleton";

export function DashboardPageClient() {
  usePageTitle("Overview");
  const { isAdmin } = useRole();
  const [range, setRange] = useState<DashboardRangeInput>({
    kind: "preset",
    preset: "today",
  });
  const [lastOverview, setLastOverview] = useState<OverviewDashboard | null>(null);
  const rangeValidationMessage =
    range.kind === "custom"
      ? validateCustomDashboardRange({
          startBusinessDate: range.startBusinessDate,
          endBusinessDateInclusive: range.endBusinessDateInclusive,
        })
      : null;
  const overview = useQuery(
    api.dashboard.overview.getOverviewDashboard,
    isAdmin && rangeValidationMessage === null ? { range } : "skip",
  );

  useEffect(() => {
    if (overview) {
      setLastOverview(overview);
    }
  }, [overview]);

  const visibleOverview = overview ?? lastOverview;

  if (!isAdmin || !visibleOverview) {
    return <OverviewDashboardSkeleton />;
  }

  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-5">
      <header className="flex flex-col gap-3 border-b pb-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-normal">Overview</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {visibleOverview.range.label}
          </p>
        </div>
        <DashboardDateRangeFilter
          value={range}
          onChange={setRange}
          validationMessage={rangeValidationMessage}
        />
      </header>

      <OverviewTopCards overview={visibleOverview} />
      <PhoneCloserOperationsSection
        section={visibleOverview.phoneCloserOperations}
      />
      <TopOriginsOverviewSection section={visibleOverview.topOrigins} />
    </div>
  );
}
```

**Step 3: Verify the server page stays thin.**

```tsx
// Path: app/workspace/page.tsx
import { redirect } from "next/navigation";
import { requireWorkspaceUser } from "@/lib/auth";
import { DashboardPageClient } from "./_components/dashboard-page-client";

export const unstable_instant = false;

export default async function WorkspaceIndexPage() {
  const access = await requireWorkspaceUser();

  if (access.crmUser.role === "lead_generator") {
    redirect("/workspace/lead-gen/capture");
  }
  if (access.crmUser.role === "closer") {
    redirect("/workspace/closer");
  }

  return <DashboardPageClient />;
}
```

**Key implementation notes:**
- Remove imports for `useRouter`, `StatsRow`, `SlackMetricsSection`, `PipelineSummary`, `SystemHealth`, `TimePeriodFilter`, and old inline skeletons from `dashboard-page-client.tsx`.
- The RSC route is already correctly gated; avoid duplicating redirects in client effects.
- Last-good-data state is only for invalid/incomplete custom ranges and in-flight refetches. It should update as soon as a new overview arrives.
- If Phase 1 decides to split the query into per-section queries, preserve this component structure and move section fetching behind a small hook.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/dashboard-page-client.tsx` | Modify | Replace old dashboard with overview composition |
| `app/workspace/_components/skeletons/overview-dashboard-skeleton.tsx` | Create | Route-level dashboard skeleton |
| `app/workspace/page.tsx` | Verify | No change expected unless route has drifted |

---

### 2G — Responsive Polish and Interaction QA Fixes

**Type:** Frontend / Manual
**Parallelizable:** No — runs after the integrated page exists.

**What:** Run the page in browser viewports, inspect layout, and fix responsive, accessibility, and interaction issues.

**Why:** Dense dashboards fail through small details: clipped labels, tables forcing page overflow, awkward range popovers, and state messages that push content unpredictably. This pass makes the UI production-grade.

**Where:**
- `app/workspace/_components/*.tsx` (modify as needed)
- `app/workspace/_components/skeletons/overview-dashboard-skeleton.tsx` (modify as needed)

**How:**

**Step 1: Run static checks before browser QA.**

```bash
# Path: terminal
pnpm tsc --noEmit
pnpm lint
```

**Step 2: Start the app and open `/workspace` with Browser.**

```bash
# Path: terminal
pnpm dev
```

Verify these viewports:

```text
# Path: Browser
Desktop: 1440x1000
Mobile: 390x844
```

**Step 3: Fix common responsive issues.**

```tsx
// Path: app/workspace/_components/phone-closer-operations-table.tsx
// If the table causes page-level overflow, keep overflow on this wrapper only.
<div className="overflow-x-auto rounded-md border">
  <Table className="min-w-[52rem]">
    {/* table */}
  </Table>
</div>
```

```tsx
// Path: app/workspace/_components/dashboard-date-range-filter.tsx
// If the two-month calendar is too wide on mobile, use the existing hook.
const isMobile = useIsMobile();

<Calendar
  mode="range"
  selected={draftRange}
  onSelect={setDraftRange}
  numberOfMonths={isMobile ? 1 : 2}
/>
```

**Step 4: Verify interaction states.**

```text
# Path: Browser
1. Switch Day -> Week -> Month and confirm the range label updates.
2. Open Custom, select a valid range, apply, and confirm the query refetches.
3. Select an incomplete custom range and confirm the previous overview remains visible.
4. Tab through the range control and table links.
5. Confirm capped/error/empty states do not overlap headers or controls.
```

**Key implementation notes:**
- Do not solve mobile crowding by scaling fonts with viewport width. Adjust layout, wrapping, or table min widths instead.
- Prefer stable dimensions, `truncate`, `min-w-0`, and table wrappers over ad hoc `overflow-hidden` on parent sections.
- Cards should be 8px radius or match the existing shadcn Card primitive; do not introduce nested cards.
- Keep the visual palette within existing semantic tokens and avoid adding decorative backgrounds to this operational surface.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/*.tsx` | Modify | Responsive and accessibility fixes discovered in QA |
| `app/workspace/_components/skeletons/overview-dashboard-skeleton.tsx` | Modify | Skeleton dimension fixes if needed |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/_components/overview-dashboard-types.ts` | Create | 2A |
| `app/workspace/_components/overview-formatters.ts` | Create | 2A |
| `app/workspace/_components/overview-section-state.tsx` | Create | 2A |
| `app/workspace/_components/dashboard-date-utils.ts` | Create | 2B |
| `app/workspace/_components/dashboard-date-range-filter.tsx` | Create | 2B |
| `app/workspace/_components/overview-top-cards.tsx` | Create | 2C |
| `app/workspace/_components/lead-gen-overview-card.tsx` | Create | 2C |
| `app/workspace/_components/top-qualifiers-card.tsx` | Create | 2C |
| `app/workspace/_components/top-dm-closers-card.tsx` | Create | 2C |
| `app/workspace/_components/phone-closer-operations-section.tsx` | Create | 2D |
| `app/workspace/_components/phone-closer-operations-table.tsx` | Create | 2D |
| `app/workspace/_components/top-origins-overview-section.tsx` | Create | 2E |
| `app/workspace/_components/top-origins-overview-table.tsx` | Create | 2E |
| `app/workspace/_components/dashboard-page-client.tsx` | Modify | 2B, 2F, 2G |
| `app/workspace/_components/skeletons/overview-dashboard-skeleton.tsx` | Create | 2F |
| `app/workspace/page.tsx` | Verify | 2F |
