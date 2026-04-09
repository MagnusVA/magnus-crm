# Phase 1 — Critical Fixes: Typography, Status Config, Design System, Color Audit

**Goal:** Resolve the four critical-severity issues that affect every page: fix the global monospace font, unify fragmented status configurations, update the stale design system document, and eliminate raw Tailwind color violations.

**Prerequisite:** None — this is the foundation phase.

**Runs in PARALLEL with:** Nothing. All subsequent phases depend on the design tokens and shared config established here.

**Skills to invoke:**
- `frontend-design` — typography direction, color palette decisions
- `shadcn` — semantic color tokens, component styling rules
- `web-design-guidelines` — WCAG contrast verification

**Acceptance Criteria:**
1. The entire app renders body text in Geist Sans (`font-sans`), not JetBrains Mono.
2. JetBrains Mono is used only for code-like elements: invite URLs, IDs, tabular numbers, timestamps.
3. A single `lib/status-config.ts` exports all status types, configs, and a `<StatusBadge>` component. No other file re-declares status colors.
4. `app/workspace/pipeline/_components/status-badge.tsx` is deleted.
5. `DESIGN_SYSTEM.md` accurately describes the OKLch color system, font stack, loading patterns, and component patterns actually in use.
6. No raw Tailwind color classes (`bg-blue-500`, `text-red-400`, etc.) remain outside of the centralized status config or explicit CSS custom properties.
7. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
1A (Typography fix)  ─────────────────────────┐
                                               ├──→ 1D (Color audit — depends on 1B, 1C)
1B (Status config unification) ───────────────┤
                                               │
1C (CSS custom properties for status colors) ──┘
                                               
1D complete ──→ 1E (DESIGN_SYSTEM.md rewrite)
```

**Optimal execution:**
1. Start 1A, 1B, 1C all in parallel (they touch different files).
2. Once 1B and 1C are done → start 1D (color audit of all remaining files).
3. Once 1D is done → start 1E (document the final state).

**Estimated time:** 2–3 days

---

### 1A — Typography Fix: Sans-Serif Default, Mono for Data

**Type:** Frontend
**Parallelizable:** Yes — touches only font-related files, no overlap with 1B/1C

**What:** Change the global font stack from JetBrains Mono (monospace) to Geist Sans (sans-serif) as the default. Apply monospace selectively to code-like elements.

**Why:** Monospace fonts reduce content density by ~20-30%, degrade readability for long-form text (meeting notes, descriptions), and prevent headings from achieving typographic authority. The current setup contradicts the DESIGN_SYSTEM.md.

**Where:**
- `app/layout.tsx`
- `app/globals.css`

**How:**

**Step 1: Fix `app/layout.tsx`**

Remove `Geist_Mono` import entirely (unused). Change the HTML class from `font-mono` to `font-sans`:

```tsx
// Path: app/layout.tsx

import { Geist, JetBrains_Mono } from "next/font/google";
// REMOVED: import { Geist_Mono } from "next/font/google";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

// In the return JSX:
<html
  lang="en"
  suppressHydrationWarning
  className={cn(
    "h-full",
    "antialiased",
    geistSans.variable,
    jetbrainsMono.variable,
    "font-sans",  // ← Changed from "font-mono"
  )}
>
```

**Step 2: Fix `app/globals.css`**

Update the `@theme inline` block and `@layer base`:

```css
/* Path: app/globals.css */

@theme inline {
  --font-sans: var(--font-geist-sans);
  --font-mono: var(--font-mono);
  --font-heading: var(--font-geist-sans);  /* ← Changed from var(--font-mono) */
  /* ... rest unchanged ... */
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply bg-background text-foreground;
  }
  html {
    @apply font-sans;  /* ← Changed from font-mono */
  }
}
```

**Step 3: Apply mono selectively**

Add utility class applications where monospace is appropriate. These are inline changes in specific components:

| Component | Element | Apply `font-mono` |
|-----------|---------|-------------------|
| `admin/_components/invite-banner.tsx` | Invite URL display | `className="font-mono text-xs"` on the URL `<code>` element |
| `pipeline/_components/opportunities-table.tsx` | Date columns | Already uses `tabular-nums` — add `font-mono` |
| `closer/_components/featured-meeting-card.tsx` | Countdown badge | `className="font-mono tabular-nums"` |
| `closer/_components/pipeline-strip.tsx` | Count numbers | Already uses `tabular-nums` — add `font-mono` |
| `workspace/_components/stats-card.tsx` | Stat value | `className="text-3xl font-bold font-mono tabular-nums"` |

**Key implementation notes:**
- `Geist` is already imported and the CSS variable `--font-geist-sans` is already defined — it was just being overridden by `font-mono` on `<html>`
- Removing `Geist_Mono` eliminates one network request (the font was imported but never actually referenced by any component)
- `tabular-nums` should always accompany `font-mono` on numeric displays to ensure digit alignment

**Files touched:**

| File | Action | Notes |
|------|--------|-------|
| `app/layout.tsx` | Modified | Remove Geist_Mono import, change `font-mono` → `font-sans` |
| `app/globals.css` | Modified | Change `--font-heading` and `html` class |
| `app/admin/_components/invite-banner.tsx` | Modified | Add `font-mono` to URL display |
| `app/workspace/pipeline/_components/opportunities-table.tsx` | Modified | Add `font-mono` to date cells |
| `app/workspace/closer/_components/featured-meeting-card.tsx` | Modified | Add `font-mono tabular-nums` to countdown |
| `app/workspace/closer/_components/pipeline-strip.tsx` | Modified | Add `font-mono` to count values |
| `app/workspace/_components/stats-card.tsx` | Modified | Add `font-mono tabular-nums` to stat value |

---

### 1B — Status Config Unification

**Type:** Frontend
**Parallelizable:** Yes — touches status config files, no overlap with 1A/1C

**What:** Create a single shared status configuration at `lib/status-config.ts` that serves both admin and closer views. Delete the duplicate `pipeline/_components/status-badge.tsx`. Create a shared `<StatusBadge>` component.

**Why:** Two competing status config systems exist: `closer/_components/status-config.ts` (uses `bg-500/10` opacity pattern) and `pipeline/_components/status-badge.tsx` (uses `bg-100` solid pattern). The same "In Progress" status renders as amber in one view and yellow in the other. A third inline mapping exists in `admin/page.tsx` for tenant statuses.

**Where:**
- `lib/status-config.ts` (new)
- `components/status-badge.tsx` (new)
- `app/workspace/pipeline/_components/status-badge.tsx` (delete)
- `app/workspace/closer/_components/status-config.ts` (delete)
- All files importing from either of the above (update imports)

**How:**

**Step 1: Create `lib/status-config.ts`**

Consolidate ALL status types and visual config into one file. Use the closer config's `bg-500/10` opacity pattern as the canonical style (it's more refined and consistent with dark mode):

```typescript
// Path: lib/status-config.ts

/**
 * Centralised status configuration for the entire application.
 *
 * Every surface that renders a status (badges, dots, calendar blocks,
 * pipeline strips, admin tables) MUST use this config to ensure
 * visual consistency.
 */

// ─── Opportunity statuses ────────────────────────────────────────────

export const OPPORTUNITY_STATUSES = [
  "scheduled",
  "in_progress",
  "payment_received",
  "follow_up_scheduled",
  "lost",
  "canceled",
  "no_show",
] as const;

export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

export function isValidOpportunityStatus(
  value: string,
): value is OpportunityStatus {
  return (OPPORTUNITY_STATUSES as readonly string[]).includes(value);
}

// ─── Meeting statuses ────────────────────────────────────────────────

export const MEETING_STATUSES = [
  "scheduled",
  "in_progress",
  "completed",
  "canceled",
  "no_show",
] as const;

export type MeetingStatus = (typeof MEETING_STATUSES)[number];

// ─── Tenant statuses ────────────────────────────────────────────────

export const TENANT_STATUSES = [
  "pending_signup",
  "active",
  "calendly_disconnected",
] as const;

export type TenantStatus = (typeof TENANT_STATUSES)[number];

// ─── Opportunity display config ──────────────────────────────────────

type StatusVisualConfig = {
  label: string;
  /** Badge background + text classes. */
  badgeClass: string;
  /** Small status dot fill. */
  dotClass: string;
  /** Pipeline strip card background. */
  stripBg: string;
};

export const opportunityStatusConfig: Record<
  OpportunityStatus,
  StatusVisualConfig
> = {
  scheduled: {
    label: "Scheduled",
    badgeClass:
      "bg-blue-500/10 text-blue-700 border-blue-200 dark:text-blue-400 dark:border-blue-900",
    dotClass: "bg-blue-500",
    stripBg:
      "bg-blue-500/5 hover:bg-blue-500/10 border-blue-200/60 dark:border-blue-900/60",
  },
  in_progress: {
    label: "In Progress",
    badgeClass:
      "bg-amber-500/10 text-amber-700 border-amber-200 dark:text-amber-400 dark:border-amber-900",
    dotClass: "bg-amber-500",
    stripBg:
      "bg-amber-500/5 hover:bg-amber-500/10 border-amber-200/60 dark:border-amber-900/60",
  },
  follow_up_scheduled: {
    label: "Follow-up",
    badgeClass:
      "bg-violet-500/10 text-violet-700 border-violet-200 dark:text-violet-400 dark:border-violet-900",
    dotClass: "bg-violet-500",
    stripBg:
      "bg-violet-500/5 hover:bg-violet-500/10 border-violet-200/60 dark:border-violet-900/60",
  },
  payment_received: {
    label: "Won",
    badgeClass:
      "bg-emerald-500/10 text-emerald-700 border-emerald-200 dark:text-emerald-400 dark:border-emerald-900",
    dotClass: "bg-emerald-500",
    stripBg:
      "bg-emerald-500/5 hover:bg-emerald-500/10 border-emerald-200/60 dark:border-emerald-900/60",
  },
  lost: {
    label: "Lost",
    badgeClass:
      "bg-red-500/10 text-red-700 border-red-200 dark:text-red-400 dark:border-red-900",
    dotClass: "bg-red-500",
    stripBg:
      "bg-red-500/5 hover:bg-red-500/10 border-red-200/60 dark:border-red-900/60",
  },
  canceled: {
    label: "Canceled",
    badgeClass: "bg-muted text-muted-foreground border-border",
    dotClass: "bg-muted-foreground",
    stripBg: "bg-muted/50 hover:bg-muted border-border/60",
  },
  no_show: {
    label: "No Show",
    badgeClass:
      "bg-orange-500/10 text-orange-700 border-orange-200 dark:text-orange-400 dark:border-orange-900",
    dotClass: "bg-orange-500",
    stripBg:
      "bg-orange-500/5 hover:bg-orange-500/10 border-orange-200/60 dark:border-orange-900/60",
  },
};

// ─── Meeting block config (calendar) ─────────────────────────────────

type MeetingBlockConfig = {
  label: string;
  blockClass: string;
  textClass: string;
};

export const meetingStatusConfig: Record<MeetingStatus, MeetingBlockConfig> = {
  scheduled: {
    label: "Scheduled",
    blockClass: "bg-blue-500/10 border-l-blue-500",
    textClass: "text-blue-700 dark:text-blue-300",
  },
  in_progress: {
    label: "In Progress",
    blockClass: "bg-amber-500/10 border-l-amber-500",
    textClass: "text-amber-700 dark:text-amber-300",
  },
  completed: {
    label: "Completed",
    blockClass: "bg-emerald-500/10 border-l-emerald-500",
    textClass: "text-emerald-700 dark:text-emerald-300",
  },
  canceled: {
    label: "Canceled",
    blockClass: "bg-muted/60 border-l-muted-foreground",
    textClass: "text-muted-foreground line-through",
  },
  no_show: {
    label: "No Show",
    blockClass: "bg-orange-500/10 border-l-orange-500",
    textClass: "text-orange-700 dark:text-orange-300",
  },
};

// ─── Tenant status config ────────────────────────────────────────────

type TenantStatusConfig = {
  label: string;
  badgeVariant: "default" | "secondary" | "outline" | "destructive";
};

export const tenantStatusConfig: Record<TenantStatus, TenantStatusConfig> = {
  pending_signup: { label: "Pending", badgeVariant: "outline" },
  active: { label: "Active", badgeVariant: "default" },
  calendly_disconnected: { label: "Disconnected", badgeVariant: "destructive" },
};

// ─── Pipeline display order ──────────────────────────────────────────

export const PIPELINE_DISPLAY_ORDER: OpportunityStatus[] = [
  "scheduled",
  "in_progress",
  "follow_up_scheduled",
  "payment_received",
  "lost",
  "canceled",
  "no_show",
];
```

**Step 2: Create shared `<StatusBadge>` component**

```tsx
// Path: components/status-badge.tsx
"use client";

import { Badge } from "@/components/ui/badge";
import {
  opportunityStatusConfig,
  type OpportunityStatus,
} from "@/lib/status-config";
import { cn } from "@/lib/utils";

interface StatusBadgeProps {
  status: OpportunityStatus;
  className?: string;
}

/**
 * Unified status badge used across admin and closer views.
 * Always renders the same visual for the same status.
 */
export function StatusBadge({ status, className }: StatusBadgeProps) {
  const config = opportunityStatusConfig[status];

  if (!config) {
    return <Badge variant="secondary">{status}</Badge>;
  }

  return (
    <Badge variant="secondary" className={cn(config.badgeClass, className)}>
      {config.label}
    </Badge>
  );
}
```

**Step 3: Update all imports**

Every file that currently imports from `closer/_components/status-config.ts` or `pipeline/_components/status-badge.tsx` must be updated:

| File | Old import | New import |
|------|-----------|------------|
| `closer/_components/meeting-block.tsx` | `from "../_components/status-config"` | `from "@/lib/status-config"` |
| `closer/_components/pipeline-strip.tsx` | `from "./status-config"` | `from "@/lib/status-config"` |
| `closer/_components/status-tabs.tsx` | `from "./status-config"` | `from "@/lib/status-config"` |
| `closer/pipeline/_components/opportunity-row.tsx` | `from "../../_components/status-config"` | `from "@/lib/status-config"` |
| `closer/pipeline/_components/status-tabs.tsx` | `from "../../_components/status-config"` | `from "@/lib/status-config"` |
| `closer/meetings/[meetingId]/page.tsx` | `from "../../_components/status-config"` | `from "@/lib/status-config"` |
| `closer/meetings/_components/meeting-history-timeline.tsx` | `from "../../_components/status-config"` | `from "@/lib/status-config"` |
| `pipeline/_components/opportunities-table.tsx` | `from "./status-badge"` | `from "@/components/status-badge"` |
| `pipeline/page.tsx` | (if importing StatusBadge) | `from "@/components/status-badge"` |
| `admin/page.tsx` | Inline status config | `from "@/lib/status-config"` |

**Step 4: Delete old files**

- Delete `app/workspace/pipeline/_components/status-badge.tsx`
- Delete `app/workspace/closer/_components/status-config.ts`

**Key implementation notes:**
- The `bg-500/10` opacity pattern (from closer config) is used as the canonical style because it creates cleaner contrast ratios in dark mode than `bg-100` solid fills
- Tenant status config uses Badge `variant` props instead of raw color classes — this is the shadcn-compliant approach
- The `admin/page.tsx` inline tenant status mapping (if present) should also use `tenantStatusConfig` from the shared file

**Files touched:**

| File | Action | Notes |
|------|--------|-------|
| `lib/status-config.ts` | Created | Unified status config for all status types |
| `components/status-badge.tsx` | Created | Shared StatusBadge component |
| `app/workspace/pipeline/_components/status-badge.tsx` | Deleted | Replaced by shared component |
| `app/workspace/closer/_components/status-config.ts` | Deleted | Replaced by lib/status-config.ts |
| `app/workspace/closer/_components/meeting-block.tsx` | Modified | Update import path |
| `app/workspace/closer/_components/pipeline-strip.tsx` | Modified | Update import path |
| `app/workspace/closer/_components/status-tabs.tsx` | Modified | Update import path |
| `app/workspace/closer/pipeline/_components/opportunity-row.tsx` | Modified | Update import path |
| `app/workspace/closer/pipeline/_components/status-tabs.tsx` | Modified | Update import path |
| `app/workspace/closer/meetings/[meetingId]/page.tsx` | Modified | Update import path |
| `app/workspace/closer/meetings/_components/meeting-history-timeline.tsx` | Modified | Update import path |
| `app/workspace/pipeline/_components/opportunities-table.tsx` | Modified | Use shared StatusBadge |
| `app/admin/page.tsx` | Modified | Use tenantStatusConfig from shared file |

---

### 1C — CSS Custom Properties for Semantic Status Colors

**Type:** Frontend
**Parallelizable:** Yes — touches only `app/globals.css`, no overlap with 1A/1B

**What:** Define CSS custom properties for status-related colors in `globals.css` so that status colors are part of the theme layer and can be toggled with dark mode automatically.

**Why:** The status config in 1B still uses raw Tailwind classes like `bg-blue-500/10`. While centralized, these bypass the theme system. Defining CSS variables means future theme changes (light mode, custom tenant themes) propagate to status colors automatically.

**Where:**
- `app/globals.css`

**How:**

Add status color variables to both `:root` and `.dark` blocks:

```css
/* Path: app/globals.css — append to :root block */

/* Status colors — used by lib/status-config.ts */
--status-scheduled: oklch(0.623 0.214 259.1);       /* blue-500 */
--status-in-progress: oklch(0.769 0.188 70.08);     /* amber-500 */
--status-follow-up: oklch(0.606 0.25 292.717);      /* violet-500 */
--status-won: oklch(0.696 0.17 162.48);             /* emerald-500 */
--status-lost: oklch(0.637 0.237 25.331);           /* red-500 */
--status-canceled: var(--muted-foreground);
--status-no-show: oklch(0.705 0.191 47.604);        /* orange-500 */
```

> **Note:** These variables serve as documentation and enable future theme-level overrides. The status-config.ts continues to use Tailwind classes for the MVP since Tailwind v4 doesn't support arbitrary CSS variable references in class-based utilities without additional setup. The variables are available for any component that needs inline styles or custom CSS.

**Key implementation notes:**
- The OKLch values correspond to the Tailwind color scale used in the status config
- These variables are the SAME in light and dark mode — the opacity treatment (`/10`, `/5`) in the Tailwind classes handles the adaptation
- This is a foundation step. Once the CSS variables exist, future work can migrate status-config.ts to reference them via Tailwind's `theme()` function

**Files touched:**

| File | Action | Notes |
|------|--------|-------|
| `app/globals.css` | Modified | Add status color CSS custom properties |

---

### 1D — Raw Color Class Audit & Cleanup

**Type:** Frontend
**Parallelizable:** No — depends on 1B (status config) and 1C (CSS properties) being complete

**What:** Audit every file that uses raw Tailwind color classes (e.g., `bg-blue-500`, `text-red-400`, `border-emerald-200`) and replace them with either semantic tokens or references to the centralized status config.

**Why:** The shadcn critical rules forbid raw color overrides. Raw colors make theme changes impossible, create dark mode maintenance burden, and fragment the visual language.

**Where:** All files listed in Section 5 of the analysis.

**How:**

For each file, apply the appropriate replacement:

**`app/workspace/_components/stats-card.tsx`** — Replace raw variant classes with semantic tokens:

```tsx
const variantClasses = {
  default: "",
  success: "border-emerald-500/20 bg-emerald-500/5 dark:border-emerald-500/20 dark:bg-emerald-500/5",
  warning: "border-amber-500/20 bg-amber-500/5 dark:border-amber-500/20 dark:bg-amber-500/5",
  destructive: "border-destructive/20 bg-destructive/5",
} as const;
```

> **Decision:** Stats card variants are a borderline case. The `success` and `warning` variants genuinely need specific hues (green for good, amber for caution). Using opacity modifiers on a single base color (`-500/20`, `-500/5`) works identically in light and dark mode, eliminating the need for `dark:` overrides entirely.

**`app/workspace/_components/pipeline-summary.tsx`** — Replace inline color arrays with status config:

```tsx
import { opportunityStatusConfig } from "@/lib/status-config";

// Replace hardcoded statuses array with:
const statuses = [
  { label: "Active", value: stats.activeOpportunities, badgeClass: opportunityStatusConfig.scheduled.badgeClass },
  { label: "Won", value: stats.wonDeals, badgeClass: opportunityStatusConfig.payment_received.badgeClass },
  { label: "Total", value: stats.totalOpportunities, badgeClass: "bg-muted text-muted-foreground border-border" },
];
```

**`app/workspace/_components/system-health.tsx`** — Replace raw status indicators:

```tsx
// Replace: text-red-400, text-amber-400, bg-red-500/10, bg-amber-500/10
// With: text-destructive, text-warning (if available), or keep as-is with comment noting exception
```

> **Note for system-health.tsx:** Connection status colors (red for disconnected, amber for expiring, green for connected) are semantic health indicators, not pipeline statuses. These are acceptable as raw colors OR should be extracted into a `connectionStatusConfig` in `lib/status-config.ts`.

**`app/workspace/closer/_components/unmatched-banner.tsx`** — Uses raw amber colors for a warning banner:

```tsx
// Replace custom bg-amber-950 + text-amber-200 + border-amber-700/50
// With shadcn Alert component: <Alert variant="warning"> if available,
// or use semantic: bg-destructive/10 text-destructive border-destructive/20
```

**`app/workspace/closer/_components/featured-meeting-card.tsx`** — Urgency border colors:

```tsx
// The urgency colors (amber for <30min, emerald for started, primary for normal)
// are intentional UX signals. These are acceptable as raw colors.
// Add comment: // Intentional raw color — urgency signal, not theme-dependent
```

**`app/workspace/closer/meetings/_components/lead-info-panel.tsx`** — Contact icon badges:

```tsx
// Replace: bg-blue-500/10, bg-emerald-500/10
// With: bg-primary/10 for all contact icons (consistent, theme-aware)
```

**Summary of decisions:**

| File | Approach |
|------|----------|
| `stats-card.tsx` | Simplify with opacity pattern (no `dark:` needed) |
| `pipeline-summary.tsx` | Use status config references |
| `system-health.tsx` | Add `connectionStatusConfig` to status config or document exception |
| `unmatched-banner.tsx` | Use semantic tokens or shadcn Alert |
| `featured-meeting-card.tsx` | Keep raw colors (document as intentional urgency signals) |
| `lead-info-panel.tsx` | Use `bg-primary/10` consistently |
| `calendly-connection.tsx` | Same approach as system-health.tsx |

**Files touched:**

| File | Action | Notes |
|------|--------|-------|
| `app/workspace/_components/stats-card.tsx` | Modified | Simplify variant classes |
| `app/workspace/_components/pipeline-summary.tsx` | Modified | Use status config refs |
| `app/workspace/_components/system-health.tsx` | Modified | Semantic tokens or config |
| `app/workspace/closer/_components/unmatched-banner.tsx` | Modified | Semantic tokens |
| `app/workspace/closer/_components/featured-meeting-card.tsx` | Modified | Add comment, minor cleanup |
| `app/workspace/closer/meetings/_components/lead-info-panel.tsx` | Modified | Use primary/10 |
| `app/workspace/settings/_components/calendly-connection.tsx` | Modified | Match system-health approach |

---

### 1E — DESIGN_SYSTEM.md Rewrite

**Type:** Documentation
**Parallelizable:** No — should be the LAST subphase so it documents the final state after 1A–1D

**What:** Completely rewrite `DESIGN_SYSTEM.md` to accurately reflect the current design system after all Phase 1 changes are applied.

**Why:** The current document is stale and misleading. It references Slate named colors, claims "no custom fonts", and lists skeleton screens under "future enhancements" when they're already implemented. A developer reading it would make wrong decisions.

**Where:**
- `DESIGN_SYSTEM.md`

**How:**

The rewritten document should cover:

1. **Typography** — Geist Sans as body, JetBrains Mono for data/code, heading weights
2. **Color System** — OKLch color space explanation, semantic token inventory, status colors
3. **Theme** — Dark-first, class-based toggle, CSS variables in globals.css
4. **Component Library** — shadcn/ui radix-nova preset, 58 installed components
5. **Status Visual Language** — Reference to `lib/status-config.ts`, visual examples
6. **Animation** — `motion-safe:` guards, fade-in patterns, Sonner toasts
7. **Spacing** — gap utilities, page padding, section rhythm
8. **Loading States** — Skeleton screens (not "just purposeful loading"), Spinner for inline loading
9. **Accessibility** — WCAG AA, semantic HTML, aria patterns
10. **Responsive** — Mobile-first, breakpoint strategy, sidebar sheet on mobile

**Key implementation notes:**
- Remove ALL references to Amber-500 as the primary CTA color — the primary is now a green-hued OKLch value
- Remove references to "geometric accents" (diagonal stripes) — these were never implemented
- Add a "Status Colors" section that references the shared `lib/status-config.ts`
- Add a "Font Usage" section with clear guidance on when to use `font-mono`

**Files touched:**

| File | Action | Notes |
|------|--------|-------|
| `DESIGN_SYSTEM.md` | Modified (full rewrite) | Document actual design system state |

---

## Phase 1 Summary

| File | Action | Subphase |
|------|--------|----------|
| `app/layout.tsx` | Modified | 1A |
| `app/globals.css` | Modified | 1A, 1C |
| `app/admin/_components/invite-banner.tsx` | Modified | 1A |
| `lib/status-config.ts` | Created | 1B |
| `components/status-badge.tsx` | Created | 1B |
| `app/workspace/pipeline/_components/status-badge.tsx` | Deleted | 1B |
| `app/workspace/closer/_components/status-config.ts` | Deleted | 1B |
| `app/workspace/closer/_components/meeting-block.tsx` | Modified | 1B |
| `app/workspace/closer/_components/pipeline-strip.tsx` | Modified | 1A, 1B |
| `app/workspace/closer/_components/status-tabs.tsx` | Modified | 1B |
| `app/workspace/closer/pipeline/_components/opportunity-row.tsx` | Modified | 1B |
| `app/workspace/closer/pipeline/_components/status-tabs.tsx` | Modified | 1B |
| `app/workspace/closer/meetings/[meetingId]/page.tsx` | Modified | 1B |
| `app/workspace/closer/meetings/_components/meeting-history-timeline.tsx` | Modified | 1B |
| `app/workspace/pipeline/_components/opportunities-table.tsx` | Modified | 1B |
| `app/admin/page.tsx` | Modified | 1B |
| `app/workspace/_components/stats-card.tsx` | Modified | 1A, 1D |
| `app/workspace/_components/pipeline-summary.tsx` | Modified | 1D |
| `app/workspace/_components/system-health.tsx` | Modified | 1D |
| `app/workspace/closer/_components/unmatched-banner.tsx` | Modified | 1D |
| `app/workspace/closer/_components/featured-meeting-card.tsx` | Modified | 1A, 1D |
| `app/workspace/closer/meetings/_components/lead-info-panel.tsx` | Modified | 1D |
| `app/workspace/settings/_components/calendly-connection.tsx` | Modified | 1D |
| `DESIGN_SYSTEM.md` | Modified (full rewrite) | 1E |
