# Phase 5 — Progressive Enhancements: Table Sorting, Notification Center, Data Export, Profile Page, Keyboard Shortcuts, Settings Restructure

**Goal:** Add power-user features and scalability improvements that elevate Magnus CRM from functional to delightful: sortable tables, a notification center, CSV export, user self-service, keyboard shortcuts, and a settings page structure that scales with future features.

**Prerequisite:** Phases 1–3 complete (design tokens, layout, and state management patterns must be stable). Phase 4 recommended but not required.

**Runs in PARALLEL with:** Phase 4 (no file conflicts).

**Skills to invoke:**
- `shadcn` — Table, DropdownMenu, Tabs, Popover, Sheet, Kbd components
- `frontend-design` — notification center design, settings layout
- `vercel-react-best-practices` — `bundle-dynamic-imports`, `rerender-use-deferred-value`
- `vercel-composition-patterns` — `architecture-compound-components` for settings

**Acceptance Criteria:**
1. Pipeline and Team tables support column sorting (click header to toggle asc/desc) with visual indicators.
2. A notification bell in the workspace header shows a count badge and a popover with recent events.
3. Pipeline and Team tables have an "Export CSV" button that downloads the current view as a .csv file.
4. A `/workspace/profile` page allows users to view their account info (display name, email, role).
5. Keyboard shortcuts (`Cmd+K` for palette, `Escape` to close) work application-wide, with hints shown via `Kbd`.
6. The settings page uses a tabbed layout that can accommodate future settings sections.
7. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
5A (Table sorting) ──────────────────────────────┐
                                                   │
5B (Notification center) ────────────────────────┤  All independent,
                                                   │  run in PARALLEL
5C (CSV export) ─────────────────────────────────┤
                                                   │
5D (Profile page) ──────────────────────────────┤
                                                   │
5E (Keyboard shortcuts) ────────────────────────┤
                                                   │
5F (Settings restructure) ──────────────────────┘
```

**Optimal execution:**
All 6 subphases are independent and can run in PARALLEL.
However, 5E (keyboard shortcuts) has a soft dependency on Phase 2's command palette — it extends rather than creates the shortcut system.

**Estimated time:** 5–7 days (largest phase, all subphases are medium effort)

---

### 5A — Table Sorting

**Type:** Frontend
**Parallelizable:** Yes — touches table components independently

**What:** Add client-side column sorting to the pipeline and team tables. Clicking a column header toggles between ascending, descending, and default order. A visual indicator (chevron) shows the current sort direction.

**Why:** Both pipeline tables (admin and closer) return data in insertion order. Users need to sort by status, date, name, or amount to find relevant records quickly. This becomes essential as data grows.

**Where:**
- `hooks/use-table-sort.ts` (new)
- `app/workspace/pipeline/_components/opportunities-table.tsx`
- `app/workspace/closer/pipeline/_components/opportunity-table.tsx`
- `app/workspace/team/_components/team-members-table.tsx`

**How:**

**Step 1: Create sorting hook**

```typescript
// Path: hooks/use-table-sort.ts
"use client";

import { useMemo, useState } from "react";

export type SortDirection = "asc" | "desc" | null;

export type SortState<K extends string> = {
  key: K | null;
  direction: SortDirection;
};

/**
 * Client-side table sorting hook.
 *
 * Cycles through: null → asc → desc → null on each toggle.
 * Returns sorted data and the toggle handler.
 */
export function useTableSort<T, K extends string>(
  data: T[],
  comparators: Record<K, (a: T, b: T) => number>,
) {
  const [sort, setSort] = useState<SortState<K>>({ key: null, direction: null });

  const toggle = (key: K) => {
    setSort((prev) => {
      if (prev.key !== key) return { key, direction: "asc" };
      if (prev.direction === "asc") return { key, direction: "desc" };
      return { key: null, direction: null }; // Reset
    });
  };

  const sorted = useMemo(() => {
    if (!sort.key || !sort.direction) return data;
    const comparator = comparators[sort.key];
    const multiplier = sort.direction === "asc" ? 1 : -1;
    return [...data].sort((a, b) => comparator(a, b) * multiplier);
  }, [data, sort, comparators]);

  return { sorted, sort, toggle };
}
```

**Step 2: Create sortable header component**

```tsx
// Inline in each table, or extracted to a shared component:

function SortableHeader<K extends string>({
  label,
  sortKey,
  sort,
  onToggle,
}: {
  label: string;
  sortKey: K;
  sort: SortState<K>;
  onToggle: (key: K) => void;
}) {
  const isActive = sort.key === sortKey;
  return (
    <TableHead>
      <button
        className="flex items-center gap-1 text-left"
        onClick={() => onToggle(sortKey)}
        aria-sort={isActive ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
      >
        {label}
        {isActive && sort.direction === "asc" && <ChevronUpIcon className="size-3" />}
        {isActive && sort.direction === "desc" && <ChevronDownIcon className="size-3" />}
        {!isActive && <ChevronsUpDownIcon className="size-3 text-muted-foreground/40" />}
      </button>
    </TableHead>
  );
}
```

**Step 3: Apply to pipeline table**

```tsx
// Path: app/workspace/pipeline/_components/opportunities-table.tsx

const comparators = {
  lead: (a, b) => (a.leadName ?? "").localeCompare(b.leadName ?? ""),
  status: (a, b) => a.status.localeCompare(b.status),
  closer: (a, b) => (a.closerName ?? "").localeCompare(b.closerName ?? ""),
  created: (a, b) => a._creationTime - b._creationTime,
  meeting: (a, b) => (a.nextMeetingAt ?? 0) - (b.nextMeetingAt ?? 0),
};

const { sorted, sort, toggle } = useTableSort(opportunities, comparators);

// Replace static <TableHead> with <SortableHeader>:
<SortableHeader label="Lead" sortKey="lead" sort={sort} onToggle={toggle} />
<SortableHeader label="Status" sortKey="status" sort={sort} onToggle={toggle} />
// etc.
```

**Key implementation notes:**
- `aria-sort` attribute on `<th>` is a WCAG requirement for sortable tables
- The three-state cycle (null → asc → desc → null) lets users reset to default order
- `ChevronsUpDownIcon` is the unsorted indicator (subtle, shows the column IS sortable)
- Sorting is client-side because both tables already load all visible data upfront
- For paginated tables (admin tenant list), sorting should happen server-side — out of scope for this subphase
- The `comparators` object is hoisted outside the component per `rendering-hoist-jsx`

**Files touched:**

| File | Action | Notes |
|------|--------|-------|
| `hooks/use-table-sort.ts` | Created | Client-side sorting hook |
| `app/workspace/pipeline/_components/opportunities-table.tsx` | Modified | Sortable headers |
| `app/workspace/closer/pipeline/_components/opportunity-table.tsx` | Modified | Sortable headers |
| `app/workspace/team/_components/team-members-table.tsx` | Modified | Sortable headers |

---

### 5B — Notification Center

**Type:** Frontend
**Parallelizable:** Yes — creates new components

**What:** Add a notification bell icon to the workspace header that shows a count badge of unread events and opens a popover with recent notifications (new meetings, payments, connection issues).

**Why:** Currently, status changes and new meetings are only visible via ephemeral toasts or by navigating to the relevant page. Admins and closers have no passive awareness of events that happened while they were on a different page.

**Where:**
- `components/notification-center.tsx` (new)
- `app/workspace/layout.tsx` (add to header)

**How:**

**Step 1: Create notification center component**

```tsx
// Path: components/notification-center.tsx
"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { BellIcon } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

/**
 * Notification bell with popover.
 *
 * Queries recent events for the current user and displays
 * them in a scrollable popover.
 *
 * NOTE: This requires a backend query `getRecentNotifications`
 * to be created. For the MVP, we can derive notifications from
 * existing data (recent meetings, recent status changes).
 */
export function NotificationCenter() {
  const [open, setOpen] = useState(false);

  // TODO: Replace with actual notification query once backend is ready
  // For now, this is a placeholder that shows the UI structure
  const notifications: Array<{
    id: string;
    title: string;
    description: string;
    timestamp: number;
    read: boolean;
  }> = [];

  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="relative" aria-label="Notifications">
          <BellIcon />
          {unreadCount > 0 && (
            <Badge
              variant="destructive"
              className="absolute -right-1 -top-1 flex size-4 items-center justify-center p-0 text-[10px]"
            >
              {unreadCount > 9 ? "9+" : unreadCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h3 className="text-sm font-semibold">Notifications</h3>
          {unreadCount > 0 && (
            <Button variant="ghost" size="sm" className="text-xs">
              Mark all read
            </Button>
          )}
        </div>
        <ScrollArea className="max-h-80">
          {notifications.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              No notifications yet
            </div>
          ) : (
            <div className="flex flex-col">
              {notifications.map((notification) => (
                <div
                  key={notification.id}
                  className="flex flex-col gap-1 border-b px-4 py-3 last:border-b-0"
                >
                  <p className="text-sm font-medium">{notification.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {notification.description}
                  </p>
                  <p className="text-[10px] text-muted-foreground/60">
                    {formatDistanceToNow(notification.timestamp, { addSuffix: true })}
                  </p>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
```

**Step 2: Add to workspace header**

```tsx
// Path: app/workspace/layout.tsx — inside the header's right-aligned container:
<div className="ml-auto flex items-center gap-2">
  <CommandPaletteTrigger />
  <NotificationCenter />
</div>
```

**Key implementation notes:**
- This subphase creates the **frontend shell** for notifications. The backend query (`getRecentNotifications`) is not part of this frontend redesign — it requires backend work
- The notification list is derived from existing data patterns: new meetings (from `meetings` table, last 24h), payment records, Calendly connection changes
- `ScrollArea` (already installed) prevents the popover from growing too tall
- The badge uses `variant="destructive"` for the red dot — standard notification pattern
- Future enhancement: mark individual notifications as read, link each notification to the relevant page
- Dynamically import this component if the notification query is expensive

**Files touched:**

| File | Action | Notes |
|------|--------|-------|
| `components/notification-center.tsx` | Created | Notification bell + popover |
| `app/workspace/layout.tsx` | Modified | Add NotificationCenter to header |

---

### 5C — CSV Data Export

**Type:** Frontend
**Parallelizable:** Yes — adds export buttons to tables

**What:** Add "Export CSV" buttons to the pipeline and team tables that download the currently visible data as a .csv file.

**Why:** B2B admins frequently need to export data for reporting, sharing with stakeholders, or import into other tools. There's no export capability in the current app.

**Where:**
- `lib/export-csv.ts` (new utility)
- `app/workspace/pipeline/page.tsx`
- `app/workspace/team/page.tsx`

**How:**

**Step 1: Create CSV utility**

```typescript
// Path: lib/export-csv.ts

/**
 * Generates a CSV string from headers and rows, then triggers a download.
 */
export function downloadCSV(
  filename: string,
  headers: string[],
  rows: string[][],
) {
  const escape = (value: string) => {
    if (value.includes(",") || value.includes('"') || value.includes("\n")) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  };

  const csv = [
    headers.map(escape).join(","),
    ...rows.map((row) => row.map(escape).join(",")),
  ].join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${filename}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
```

**Step 2: Add export button to pipeline page**

```tsx
// Path: app/workspace/pipeline/page.tsx

import { downloadCSV } from "@/lib/export-csv";
import { DownloadIcon } from "lucide-react";
import { format } from "date-fns";

// In the page header, alongside existing title:
<Button
  variant="outline"
  size="sm"
  onClick={() => {
    if (!opportunities) return;
    downloadCSV(
      `pipeline-${format(new Date(), "yyyy-MM-dd")}`,
      ["Lead", "Email", "Status", "Closer", "Created"],
      opportunities.map((opp) => [
        opp.leadName ?? "",
        opp.leadEmail ?? "",
        opp.status,
        opp.closerName ?? "Unassigned",
        format(opp._creationTime, "yyyy-MM-dd HH:mm"),
      ]),
    );
  }}
>
  <DownloadIcon data-icon="inline-start" />
  Export CSV
</Button>
```

**Step 3: Add export button to team page**

```tsx
// Path: app/workspace/team/page.tsx — same pattern:
downloadCSV(
  `team-${format(new Date(), "yyyy-MM-dd")}`,
  ["Name", "Email", "Role", "Calendly Status"],
  members.map((m) => [
    m.fullName ?? "",
    m.email,
    m.role.replace(/_/g, " "),
    m.calendlyMemberName ?? "Not linked",
  ]),
);
```

**Key implementation notes:**
- The CSV utility handles proper escaping (commas, quotes, newlines in values)
- `Blob` + `URL.createObjectURL` triggers a download without a server round-trip
- The filename includes the current date for easy organization
- The export captures the CURRENT VIEW (including filters) — not all data
- For large datasets, consider streaming via a backend action instead. For the MVP, client-side is sufficient since both tables load all visible data
- No external dependencies needed — this is pure browser APIs

**Files touched:**

| File | Action | Notes |
|------|--------|-------|
| `lib/export-csv.ts` | Created | CSV generation + download utility |
| `app/workspace/pipeline/page.tsx` | Modified | Add Export CSV button |
| `app/workspace/team/page.tsx` | Modified | Add Export CSV button |

---

### 5D — Profile Page

**Type:** Frontend
**Parallelizable:** Yes — creates a new route

**What:** Add a `/workspace/profile` page that shows the current user's account info (name, email, role, Calendly link status) and a link to manage their account in WorkOS.

**Why:** Users currently can't view or manage their own profile within the CRM. Any changes (name, email) require a WorkOS admin portal visit. A profile page provides at minimum a read-only view with a link to self-service.

**Where:**
- `app/workspace/profile/page.tsx` (new)
- `app/workspace/layout.tsx` (add nav link for profile)

**How:**

```tsx
// Path: app/workspace/profile/page.tsx
"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { usePageTitle } from "@/hooks/use-page-title";
import { UserIcon, MailIcon, ShieldIcon, CalendarIcon } from "lucide-react";

export default function ProfilePage() {
  usePageTitle("Profile");
  const user = useQuery(api.users.queries.getCurrentUser);

  if (user === undefined) {
    return <ProfileSkeleton />;
  }

  if (user === null) {
    return null;
  }

  return (
    <div className="mx-auto max-w-2xl flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">My Profile</h1>
        <p className="text-sm text-muted-foreground">
          Your account information and settings
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>
            Your profile is managed through your organization&apos;s identity provider.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4">
            <InfoRow icon={UserIcon} label="Name" value={user.fullName ?? "Not set"} />
            <Separator />
            <InfoRow icon={MailIcon} label="Email" value={user.email} />
            <Separator />
            <InfoRow
              icon={ShieldIcon}
              label="Role"
              value={
                <Badge variant="secondary" className="capitalize">
                  {user.role.replace(/_/g, " ")}
                </Badge>
              }
            />
            <Separator />
            <InfoRow
              icon={CalendarIcon}
              label="Calendly"
              value={
                user.calendlyMemberId ? (
                  <Badge variant="default">Linked</Badge>
                ) : (
                  <Badge variant="outline">Not linked</Badge>
                )
              }
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function InfoRow({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3 text-sm">
        <Icon />
        <span className="text-muted-foreground">{label}</span>
      </div>
      <div className="text-sm font-medium">{value}</div>
    </div>
  );
}

function ProfileSkeleton() {
  return (
    <div className="mx-auto max-w-2xl flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-64" />
      </div>
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}
```

**Add profile link to sidebar:**

```tsx
// Path: app/workspace/layout.tsx — in SidebarFooter, above Sign Out:

<SidebarMenuItem>
  <SidebarMenuButton asChild tooltip="Profile">
    <Link href="/workspace/profile">
      <UserCircleIcon />
      <span>Profile</span>
    </Link>
  </SidebarMenuButton>
</SidebarMenuItem>
```

**Key implementation notes:**
- The profile page is READ-ONLY in the MVP — editing requires WorkOS admin portal
- The `CardDescription` explains that profile management is through the identity provider
- Future enhancement: add a "Manage Account" button that links to WorkOS self-service portal
- The profile route works for both admin and closer roles — it uses `getCurrentUser` which is role-agnostic
- Adding the nav item to `SidebarFooter` (near Sign Out) keeps the main navigation clean
- `max-w-2xl` centers the card for a comfortable reading width

**Files touched:**

| File | Action | Notes |
|------|--------|-------|
| `app/workspace/profile/page.tsx` | Created | Profile page |
| `app/workspace/layout.tsx` | Modified | Add Profile link to sidebar footer |

---

### 5E — Keyboard Shortcuts System

**Type:** Frontend
**Parallelizable:** Yes — extends the command palette from Phase 2

**What:** Establish a keyboard shortcut system with application-wide shortcuts and visible hints via the `Kbd` component. Document all shortcuts in the command palette.

**Why:** B2B CRM users perform repetitive tasks hundreds of times per day. Keyboard shortcuts dramatically improve efficiency. The `Kbd` component is installed but unused.

**Where:**
- `hooks/use-keyboard-shortcut.ts` (new)
- `components/command-palette.tsx` (extend with shortcut hints)
- Various components (add tooltip hints)

**How:**

**Step 1: Create keyboard shortcut hook**

```typescript
// Path: hooks/use-keyboard-shortcut.ts
"use client";

import { useEffect } from "react";

type Modifier = "meta" | "ctrl" | "shift" | "alt";

interface ShortcutOptions {
  key: string;
  modifiers?: Modifier[];
  handler: () => void;
  enabled?: boolean;
}

/**
 * Registers a global keyboard shortcut.
 * Automatically handles Mac (Meta) vs Windows (Ctrl).
 */
export function useKeyboardShortcut({
  key,
  modifiers = [],
  handler,
  enabled = true,
}: ShortcutOptions) {
  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== key.toLowerCase()) return;

      const modifierCheck = modifiers.every((mod) => {
        switch (mod) {
          case "meta": return e.metaKey || e.ctrlKey; // Mac or Windows
          case "ctrl": return e.ctrlKey;
          case "shift": return e.shiftKey;
          case "alt": return e.altKey;
        }
      });

      if (modifierCheck) {
        e.preventDefault();
        handler();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [key, modifiers, handler, enabled]);
}
```

**Step 2: Add shortcut hints to the command palette**

Extend `components/command-palette.tsx` to show keyboard shortcuts alongside each action:

```tsx
<CommandItem onSelect={() => navigate("/workspace/team")}>
  <UsersIcon />
  <span>Team</span>
  <CommandShortcut>
    <Kbd className="ml-auto text-[10px]">&#8984;T</Kbd>
  </CommandShortcut>
</CommandItem>
```

> Note: `CommandShortcut` is a built-in shadcn command component for right-aligned shortcut hints.

**Step 3: Register navigation shortcuts in workspace layout**

```tsx
// Path: app/workspace/layout.tsx

// Register shortcuts for quick navigation:
useKeyboardShortcut({ key: "1", modifiers: ["meta"], handler: () => router.push(navItems[0]?.href ?? "/workspace") });
useKeyboardShortcut({ key: "2", modifiers: ["meta"], handler: () => router.push(navItems[1]?.href ?? "/workspace") });
// etc.
```

**Keyboard shortcut inventory:**

| Shortcut | Action | Scope |
|----------|--------|-------|
| `Cmd+K` | Open command palette | Global (already in Phase 2) |
| `Escape` | Close dialog/palette | Global (handled by Radix) |
| `Cmd+1` | Navigate to first nav item | Workspace |
| `Cmd+2` | Navigate to second nav item | Workspace |
| `Cmd+3` | Navigate to third nav item | Workspace |
| `Cmd+4` | Navigate to fourth nav item | Workspace |

**Key implementation notes:**
- `Meta` key maps to `Cmd` on Mac and `Windows` key on PC — the hook checks both
- Shortcuts are only registered when `enabled` is true (prevents conflicts in dialogs)
- The command palette already handles `Cmd+K` — this subphase adds the numbered shortcuts
- Shortcuts that conflict with browser defaults (Cmd+1 = first tab) need careful handling — consider using `Cmd+Shift+1` instead if conflicts arise
- `Kbd` component provides the visual hint styling

**Files touched:**

| File | Action | Notes |
|------|--------|-------|
| `hooks/use-keyboard-shortcut.ts` | Created | Global keyboard shortcut hook |
| `components/command-palette.tsx` | Modified | Add shortcut hints |
| `app/workspace/layout.tsx` | Modified | Register navigation shortcuts |

---

### 5F — Settings Page Restructure

**Type:** Frontend
**Parallelizable:** Yes — touches only the settings page

**What:** Restructure the settings page from a flat two-section layout to a tabbed layout using shadcn `Tabs` that can accommodate future settings sections (notifications, billing, integrations).

**Why:** The current settings page has only "Calendly Connection" and "Event Type Config" in a flat vertical layout. As features grow (Phase 2 of the product — notifications, analytics, billing), the page will become unmanageably long. Tabs provide scalable organization.

**Where:**
- `app/workspace/settings/page.tsx`

**How:**

```tsx
// Path: app/workspace/settings/page.tsx
"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePageTitle } from "@/hooks/use-page-title";
import { CalendlyConnection } from "./_components/calendly-connection";
import { EventTypeConfigList } from "./_components/event-type-config-list";

export default function SettingsPage() {
  usePageTitle("Settings");

  // ... existing auth checks ...

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage your workspace configuration
        </p>
      </div>

      <Tabs defaultValue="calendly" className="w-full">
        <TabsList>
          <TabsTrigger value="calendly">Calendly</TabsTrigger>
          <TabsTrigger value="event-types">Event Types</TabsTrigger>
          {/* Future tabs: */}
          {/* <TabsTrigger value="notifications">Notifications</TabsTrigger> */}
          {/* <TabsTrigger value="billing">Billing</TabsTrigger> */}
        </TabsList>

        <TabsContent value="calendly" className="mt-6">
          <CalendlyConnection />
        </TabsContent>

        <TabsContent value="event-types" className="mt-6">
          <EventTypeConfigList />
        </TabsContent>
      </Tabs>
    </div>
  );
}
```

**Expected layout:**

```
┌────────────────────────────────────────────────────┐
│ Settings                                           │
│ Manage your workspace configuration                │
│                                                    │
│ [Calendly]  [Event Types]  [Notifications]...     │
│ ────────────────────────────────────────────────   │
│                                                    │
│ [Active tab content renders here]                  │
│                                                    │
└────────────────────────────────────────────────────┘
```

**Key implementation notes:**
- `defaultValue="calendly"` shows the most important section first
- Future tabs are commented out with placeholder text for developers to uncomment
- `TabsContent` wraps the existing section components without changes
- The existing `CalendlyConnection` and `EventTypeConfigList` components remain unchanged — only their parent container changes
- URL-syncing the active tab (via `?tab=event-types`) is optional but recommended for shareability. Use the same pattern as the pipeline filters if desired
- `TabsTrigger` must be inside `TabsList` — this is a shadcn critical rule

**Files touched:**

| File | Action | Notes |
|------|--------|-------|
| `app/workspace/settings/page.tsx` | Modified | Tabs layout, import Tabs components |

---

## Phase 5 Summary

| File | Action | Subphase |
|------|--------|----------|
| `hooks/use-table-sort.ts` | Created | 5A |
| `app/workspace/pipeline/_components/opportunities-table.tsx` | Modified | 5A |
| `app/workspace/closer/pipeline/_components/opportunity-table.tsx` | Modified | 5A |
| `app/workspace/team/_components/team-members-table.tsx` | Modified | 5A |
| `components/notification-center.tsx` | Created | 5B |
| `app/workspace/layout.tsx` | Modified | 5B, 5D, 5E |
| `lib/export-csv.ts` | Created | 5C |
| `app/workspace/pipeline/page.tsx` | Modified | 5C |
| `app/workspace/team/page.tsx` | Modified | 5C |
| `app/workspace/profile/page.tsx` | Created | 5D |
| `hooks/use-keyboard-shortcut.ts` | Created | 5E |
| `components/command-palette.tsx` | Modified | 5E |
| `app/workspace/settings/page.tsx` | Modified | 5F |

---

## Cross-Phase File Impact Summary

The following table shows every file touched across all 5 phases, making it easy to identify merge conflict risk and sequencing:

| File | Phase 1 | Phase 2 | Phase 3 | Phase 4 | Phase 5 |
|------|---------|---------|---------|---------|---------|
| `app/layout.tsx` | 1A | — | — | — | — |
| `app/globals.css` | 1A, 1C | — | — | — | — |
| `app/page.tsx` | — | — | — | 4D | — |
| `app/workspace/layout.tsx` | — | 2A, 2E | — | 4A, 4B | 5B, 5D, 5E |
| `app/workspace/page.tsx` | — | 2D | 3A | — | — |
| `app/workspace/team/page.tsx` | — | 2D | 3B, 3F | — | 5C |
| `app/workspace/pipeline/page.tsx` | — | 2D | 3C | — | 5C |
| `app/workspace/settings/page.tsx` | — | 2D | — | — | 5F |
| `app/workspace/closer/page.tsx` | — | 2D | 3A | — | — |
| `app/workspace/closer/pipeline/page.tsx` | — | 2D | 3D | — | — |
| `app/workspace/closer/meetings/[meetingId]/page.tsx` | 1B | 2D | 3A | — | — |
| `app/admin/page.tsx` | 1B | 2D | 3F | — | — |
| `DESIGN_SYSTEM.md` | 1E | — | — | — | — |
| `lib/status-config.ts` | 1B | — | — | — | — |
| `components/status-badge.tsx` | 1B | — | — | — | — |

> **Key risk areas:** `app/workspace/layout.tsx` is touched by Phases 2, 4, and 5. These should be sequenced (Phase 2 first, then 4, then 5) or carefully coordinated to avoid conflicts.
