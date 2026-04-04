# MAGNUS CRM Design System

> **Version:** 2.0 | **Last Updated:** 2026-04-04 | **Status:** Production

This document describes the design system as actually implemented in the codebase. If you see a discrepancy between this document and the code, the code is authoritative — update this document.

---

## 1. Typography

### Font Stack

| Token            | Font           | CSS Variable           | Usage                                      |
| ---------------- | -------------- | ---------------------- | ------------------------------------------ |
| `font-sans`      | Geist Sans     | `--font-geist-sans`   | Body text, headings, UI labels, buttons    |
| `font-mono`      | JetBrains Mono | `--font-mono`         | Data values, timestamps, IDs, URLs, code   |
| `font-heading`   | Geist Sans     | `--font-geist-sans`   | Alias — headings use the sans stack        |

Both fonts are loaded via `next/font/google` in `app/layout.tsx` and injected as CSS variables on `<html>`.

### Font Usage Rules

- **Default**: Everything renders in Geist Sans (`font-sans`). The `<html>` element applies `font-sans`.
- **Monospace (`font-mono`)**: Apply only to:
  - Numeric stat values (e.g., `StatsCard` value, pipeline counts)
  - Timestamps and date columns in tables
  - Invite URLs and tenant IDs
  - Countdown badges
  - Code snippets and inline `<code>` elements
- **Always pair `font-mono` with `tabular-nums`** on numeric displays so digits align when values change width.

### Hierarchy

| Level   | Classes                                              | Example             |
| ------- | ---------------------------------------------------- | ------------------- |
| H1      | `text-2xl sm:text-3xl font-semibold tracking-tight`  | Page titles         |
| H2      | `text-base font-semibold`                            | Card titles         |
| Kicker  | `text-[11px] font-semibold uppercase tracking-[0.25em] text-muted-foreground` | Section labels |
| Body    | `text-sm text-muted-foreground`                      | Descriptions        |
| Caption | `text-xs text-muted-foreground`                      | Timestamps, meta    |

---

## 2. Color System

### OKLCh Color Space

All colors are defined in **OKLCh** (`oklch(L C H)`) in `app/globals.css`. OKLCh provides perceptually uniform lightness, meaning equal `L` values look equally bright regardless of hue — critical for accessible contrast ratios.

### Semantic Token Inventory

Every color used in components **must** come from these semantic tokens. Raw Tailwind color classes (`bg-blue-500`, `text-red-400`) are forbidden outside of the centralized status config in `lib/status-config.ts`.

| Token                  | Light                             | Dark                              | Usage                    |
| ---------------------- | --------------------------------- | --------------------------------- | ------------------------ |
| `--background`         | `oklch(1 0 0)`                    | `oklch(0.148 0.004 228.8)`       | Page background          |
| `--foreground`         | `oklch(0.148 0.004 228.8)`       | `oklch(0.987 0.002 197.1)`       | Primary text             |
| `--primary`            | `oklch(0.527 0.154 150.069)`     | `oklch(0.448 0.119 151.328)`     | CTAs, active states      |
| `--primary-foreground` | `oklch(0.982 0.018 155.826)`     | (same)                            | Text on primary bg       |
| `--card`               | `oklch(1 0 0)`                    | `oklch(0.218 0.008 223.9)`       | Card backgrounds         |
| `--muted`              | `oklch(0.963 0.002 197.1)`       | `oklch(0.275 0.011 216.9)`       | Subtle backgrounds       |
| `--muted-foreground`   | `oklch(0.56 0.021 213.5)`        | `oklch(0.723 0.014 214.4)`       | Secondary text           |
| `--destructive`        | `oklch(0.577 0.245 27.325)`      | `oklch(0.704 0.191 22.216)`      | Errors, danger actions   |
| `--border`             | `oklch(0.925 0.005 214.3)`       | `oklch(1 0 0 / 10%)`             | Borders, dividers        |

**Primary color**: A green-hued OKLCh value (~150 hue) used for CTAs and active indicators. This is **not** amber.

### Status Color Variables

CSS custom properties for status colors are defined in `:root` for future theme-level overrides:

```css
--status-scheduled:   oklch(0.623 0.214 259.1)   /* blue-500 */
--status-in-progress: oklch(0.769 0.188 70.08)    /* amber-500 */
--status-follow-up:   oklch(0.606 0.25 292.717)   /* violet-500 */
--status-won:         oklch(0.696 0.17 162.48)     /* emerald-500 */
--status-lost:        oklch(0.637 0.237 25.331)    /* red-500 */
--status-canceled:    var(--muted-foreground)
--status-no-show:     oklch(0.705 0.191 47.604)    /* orange-500 */
```

### Chart Colors

Five warm-spectrum chart colors (`--chart-1` through `--chart-5`) are defined for Recharts via the `Chart` component. They are identical in light and dark mode.

---

## 3. Theme

- **Dark-first**: `defaultTheme="dark"` in `ThemeProvider`. System detection is disabled (`enableSystem={false}`).
- **Class-based toggle**: Uses `next-themes` with `attribute="class"`. The `.dark` class on `<html>` activates dark mode tokens.
- **Custom variant**: `@custom-variant dark (&:is(.dark *))` in `globals.css` enables Tailwind v4 dark mode.
- **All tokens defined in `app/globals.css`** under `:root` (light) and `.dark` (dark) blocks.

### Dark Mode Guidelines

- **Never use manual `dark:` overrides** on semantic tokens. `bg-background`, `text-foreground`, `text-muted-foreground`, `bg-card`, `border-border` etc. automatically adapt.
- **Status colors use `bg-{color}-500/10` opacity pattern** which works identically in both themes — eliminates need for `dark:bg-*` pairs.
- **Acceptable `dark:` usage**: Text color overrides on raw status colors (e.g., `text-blue-700 dark:text-blue-400`) where the 700 shade is too dark on dark backgrounds.

---

## 4. Component Library

### Stack

- **shadcn/ui** — radix-nova preset, Radix primitives
- **55 installed components** (see `components/ui/` directory)
- **Tailwind CSS v4** with `@theme inline` blocks (no `tailwind.config.js`)
- **Lucide React** for icons

### Key Components in Use

| Component  | Usage                                      | Notes                                    |
| ---------- | ------------------------------------------ | ---------------------------------------- |
| `Card`     | Stats cards, panels, settings sections     | Always use full composition (`CardHeader`/`CardTitle`/`CardContent`) |
| `Badge`    | Status indicators, counts, labels          | Use `variant` prop, not raw color classes |
| `Table`    | Pipeline tables, admin tenant list         | With `TableHeader`/`TableBody`/`TableRow`/`TableCell` |
| `Alert`    | Warning banners (unmatched closer)         | Accept raw color classes for warning variant (amber) |
| `Empty`    | Empty states in tables and lists           | Use `EmptyHeader`/`EmptyMedia`/`EmptyTitle`/`EmptyDescription` |
| `Tabs`     | Pipeline status filtering                  | `variant="line"` for filter bars |
| `Dialog`   | Create tenant, reset tenant                | Always include `DialogTitle` for a11y |
| `Sheet`    | Mobile sidebar navigation                  | Always include `SheetTitle` |
| `Skeleton` | Loading placeholders                       | Used in data-fetching components |
| `Spinner`  | Inline loading (buttons, refresh actions)  | Compose with `data-icon` in buttons |
| `Sonner`   | Toast notifications                        | `toast.success()`, `toast.error()`, `toast.info()` |
| `Sidebar`  | Workspace navigation                       | Sheet on mobile, fixed on desktop |
| `Select`   | Status filters, form dropdowns             | Always wrap items in `SelectContent` |

### Custom Components

| Component        | Path                        | Purpose                                     |
| ---------------- | --------------------------- | ------------------------------------------- |
| `StatusBadge`    | `components/status-badge.tsx` | Unified opportunity status badge            |
| `StatsCard`      | `app/workspace/_components/stats-card.tsx` | Metric card with icon and variant colors |
| `PipelineStrip`  | `app/workspace/closer/_components/pipeline-strip.tsx` | Pipeline stage count cards |
| `MeetingBlock`   | `app/workspace/closer/_components/meeting-block.tsx` | Calendar grid meeting block |

---

## 5. Status Visual Language

**All status rendering is centralized in `lib/status-config.ts`.** No other file should define status colors or labels.

### Opportunity Statuses

| Status             | Label      | Color Family | Badge Pattern                   |
| ------------------ | ---------- | ------------ | ------------------------------- |
| `scheduled`        | Scheduled  | Blue         | `bg-blue-500/10 text-blue-700`  |
| `in_progress`      | In Progress| Amber        | `bg-amber-500/10 text-amber-700`|
| `follow_up_scheduled` | Follow-up | Violet    | `bg-violet-500/10 text-violet-700` |
| `payment_received` | Won        | Emerald      | `bg-emerald-500/10 text-emerald-700` |
| `lost`             | Lost       | Red          | `bg-red-500/10 text-red-700`    |
| `canceled`         | Canceled   | Muted        | `bg-muted text-muted-foreground`|
| `no_show`          | No Show    | Orange       | `bg-orange-500/10 text-orange-700` |

Each status also defines `dotClass` (for dot indicators) and `stripBg` (for pipeline strip cards).

### Meeting Statuses

Calendar meeting blocks use `meetingStatusConfig` with `blockClass` (background + left border) and `textClass`.

### Tenant Statuses

Admin tenant table uses `tenantStatusConfig` with Badge `variant` props: `outline`, `secondary`, `default`, `destructive`, `ghost`.

### Connection Health

System health and settings pages use `connectionStatusConfig` for Calendly connection states: `connected`, `expiring`, `expired`, `disconnected`.

### Color Pattern Rules

- **`bg-{color}-500/10`** — Badge/block backgrounds. The `/10` opacity works in both themes.
- **`text-{color}-700 dark:text-{color}-400`** — Text colors. 700 for light, 400 for dark to maintain contrast.
- **`border-{color}-200 dark:border-{color}-900`** — Borders. Light subtle, dark subtle.
- **`bg-{color}-500/5 hover:bg-{color}-500/10`** — Strip card backgrounds with hover interaction.

---

## 6. Animation & Motion

### Entry Animations

- `motion-safe:animate-in motion-safe:fade-in` — Fade-in on mount
- `motion-safe:slide-in-from-top-2` — Slide down (banners, alerts)
- `motion-safe:duration-400` — Standard entry duration
- All animations use `motion-safe:` prefix to respect `prefers-reduced-motion`

### Loading States

- **Skeleton screens**: Used for data-fetching components (`Skeleton` component)
- **Spinner**: Inline loading in buttons (`<Spinner data-icon="inline-start" />`)
- **Pagination states**: `LoadingFirstPage`, `LoadingMore` states with appropriate skeleton/spinner

### Toast Notifications

- Via `sonner` package — `toast.success()`, `toast.error()`, `toast.info()`
- Configured with `<Toaster />` in root layout

---

## 7. Spacing & Layout

### Page-Level

| Pattern                | Classes                                | Context            |
| ---------------------- | -------------------------------------- | ------------------ |
| Page wrapper           | `px-4 py-8 sm:px-6 lg:px-8`          | Admin pages        |
| Max content width      | `max-w-6xl mx-auto`                   | Admin dashboard    |
| Section gap            | `flex flex-col gap-6`                  | Vertical sections  |

### Component-Level

- **Card padding**: Handled by `CardHeader`/`CardContent` — don't add manual padding
- **Button groups**: `flex gap-2`
- **Form fields**: Use `FieldGroup` + `Field` (shadcn pattern), never `div + space-y-*`
- **Lists**: `flex flex-col gap-*` (never `space-y-*`)

### Grid Patterns

| Layout                | Classes                                        |
| --------------------- | ---------------------------------------------- |
| Stats row             | `grid grid-cols-2 gap-3 sm:grid-cols-4`       |
| Pipeline strip        | `grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-7` |
| Detail page sidebar   | `grid gap-6 lg:grid-cols-[320px_1fr]`         |

---

## 8. Icons

- **Library**: Lucide React (`lucide-react`)
- **In buttons**: Use `data-icon="inline-start"` or `data-icon="inline-end"` — never apply sizing classes
- **Standalone**: `className="size-4"` or `size-5` as needed
- **Decorative**: Always add `aria-hidden="true"`
- **Pass as objects**: `icon={CheckIcon}`, not string lookups

---

## 9. Accessibility

- **WCAG AA** contrast ratios on all text
- **Semantic HTML**: `<section aria-label>`, `<nav>`, `<ol aria-label>`, `<time datetime>`
- **ARIA attributes**: `aria-live="polite"` on dynamic content (countdown badges, status updates)
- **`aria-current="step"`** on timeline current items
- **Focus management**: Browser defaults preserved (visible keyboard focus)
- **Screen reader support**: `sr-only` class for visually hidden labels where needed
- **`role="status"`** on loading indicators and live regions

---

## 10. Responsive Design

- **Mobile-first**: Default styles target mobile, then `sm:`, `md:`, `lg:` breakpoints
- **Sidebar**: Sheet overlay on mobile, fixed sidebar on desktop (via shadcn Sidebar component)
- **Tables**: `overflow-x-auto` wrapper for horizontal scroll on small screens
- **Button groups**: `flex flex-col gap-2 sm:flex-row` pattern
- **Pipeline strip**: Collapses from 7 columns to 2 on mobile

---

## 11. Urgency Signals

Some components use **intentional raw colors** for urgency that are not theme-dependent:

| Component              | Element          | Color            | Meaning            |
| ---------------------- | ---------------- | ---------------- | ------------------ |
| `FeaturedMeetingCard`  | Left border      | `emerald-500`    | Meeting started    |
| `FeaturedMeetingCard`  | Left border      | `amber-500`      | Starting < 30 min  |
| `FeaturedMeetingCard`  | Left border      | `primary`        | Normal scheduled   |
| `FeaturedMeetingCard`  | Countdown badge  | `amber-500/15`   | Starting soon      |
| `FeaturedMeetingCard`  | Countdown badge  | `emerald-500/15` | Started            |

These are documented exceptions to the "no raw color" rule. They must include a code comment: `// Intentional raw color — urgency signal, not theme-dependent`.

---

## 12. File Reference

| File                          | Purpose                                             |
| ----------------------------- | --------------------------------------------------- |
| `app/globals.css`             | All CSS custom properties, theme tokens, base styles|
| `app/layout.tsx`              | Font loading, theme provider, root layout           |
| `lib/status-config.ts`        | Centralised status types, colors, labels, configs   |
| `components/status-badge.tsx`  | Shared opportunity status badge component           |
| `components/ui/`              | shadcn/ui component library (55 components)         |

---

## Developer Checklist

When building new features:

1. Use **semantic color tokens** (`bg-background`, `text-muted-foreground`, `border-border`, `text-primary`) — never raw Tailwind colors
2. Use **status config** from `lib/status-config.ts` for any status rendering
3. Use **`font-sans`** by default; only apply `font-mono tabular-nums` to numeric/code-like data
4. Use **existing shadcn components** before building custom markup
5. Use **`gap-*`** for spacing, never `space-y-*` or `space-x-*`
6. Use **`size-*`** when width and height are equal
7. Wrap animations in **`motion-safe:`** to respect reduced-motion preferences
8. Add **`aria-*`** attributes to dynamic/interactive content
9. Test in both **light and dark** mode (even though dark is default)
10. Run **`pnpm tsc --noEmit`** before committing
