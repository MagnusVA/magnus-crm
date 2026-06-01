# Phase 4 — Reminder Detail Page (Route + RSC)

**Goal:** Ship the dedicated reminder detail route at `/workspace/closer/reminders/[followUpId]`, including the Next.js 16 RSC page wrapper, loading + error boundaries, the client shell that consumes the preloaded query from Phase 2, and three informational panels (`ReminderContactCard`, `ReminderMetadataCard`, `ReminderHistoryPanel`). After this phase, a closer can click a crafted URL or be linked from any internal route and see a fully rendered reminder page — but the outcome buttons are not yet wired (that is Phase 5). The page is **read-only visually** but routes, auth-gates, loads data, and renders correctly.

**Prerequisite:** Phase 2 deployed (`api.closer.reminderDetail.getReminderDetail` returns the full shape documented in §5.3 of the design doc).

**Runs in PARALLEL with:** Phase 5 (action bar + dialogs). Phase 4 and Phase 5 both live under `app/workspace/closer/reminders/[followUpId]/_components/`, but their file sets are disjoint — Phase 4 owns the page wrapper + panels; Phase 5 owns the action bar + three dialogs. The `ReminderOutcomeActionBar` is **imported** by Phase 4's client shell (line 925 of the design doc) but Phase 4 can scaffold a temporary no-op placeholder so it is not actually blocked. See the parallelization strategy for the handoff detail.

**Skills to invoke:**
- `frontend-design` — Polish the reminder contact card layout: large tappable CTAs, mobile-first `tel:` / `sms:` buttons, clear hierarchy (name > phone > note). The card is the visual anchor of the page.
- `shadcn` — Source `Card`, `Badge`, `Button`, `Alert`, `Empty`, `Skeleton` primitives. Confirm each is installed via `components.json`; no new installs expected.
- `web-design-guidelines` — WCAG 2.2 AA audit of the page: tappable target sizes ≥44×44 on mobile, focus order, colour contrast on the urgency badge, `aria-label` on tel/sms buttons.
- `vercel-react-best-practices` — Enforce Suspense boundaries inside the client shell where appropriate, avoid nested `useQuery` waterfalls (we have none — single preloaded query), use `dynamic()` for the action bar stub so it can be swapped in Phase 5 without re-shipping the page.
- `expect` — Browser-based verification in Phase 6. Phase 4 itself ships without browser QA to avoid blocking on Phase 5 dialogs.

**Acceptance Criteria:**
1. Navigating to `/workspace/closer/reminders/<valid-followup-id>` while signed in as the owning closer renders the page without errors.
2. The page title (`document.title`) reflects the lead's full name, falling back to `"Reminder"`.
3. `LeadInfoPanel` is reused as-is from the meeting detail page and rendered in the left column.
4. `ReminderContactCard` renders the lead's phone as both a tappable `tel:` link and an `sms:` link, plus a copy-phone button. It also displays the reminder note.
5. `ReminderMetadataCard` renders `reminderScheduledAt` formatted humanly, an urgency badge (reusing `getReminderUrgency`), and a link to the related meeting detail page when `latestMeetingId` exists.
6. `ReminderHistoryPanel` renders either the latest meeting's status + time, or a muted "No prior meetings" state; if payments exist, it renders a compact list of `amount/currency/date`.
7. Navigating to `/workspace/closer/reminders/<non-existent-id>` renders the `Empty` "Reminder Not Found" state with a "Back to Dashboard" button (no crash, no 500).
8. Navigating to `/workspace/closer/reminders/<id-owned-by-another-closer>` renders the same "Reminder Not Found" empty state (no data leak).
9. A non-closer (admin/master) hitting the URL is redirected by `requireRole(["closer"])` to their role-appropriate fallback (admin → `/workspace`).
10. The page shows a skeleton (`loading.tsx`) while the server preload resolves; after hydration, Convex reactivity keeps `opportunity.status` live.
11. The page's initial paint includes the static shell (back button, layout grid) before the data arrives — no FOUC.
12. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
4A (route files: page + loading + error)  ───────┐
                                                  ├── 4B (client shell + placeholder action bar)
                                                  │
                                                  ├── 4C (ReminderContactCard)   ─┐
                                                  ├── 4D (ReminderMetadataCard)  ─┤── (all three panels parallel)
                                                  └── 4E (ReminderHistoryPanel)  ─┘
```

**Optimal execution:**
1. Start **4A** alone — it is tiny (~30 lines across three files) and gates everything else.
2. Start **4B** immediately after 4A. It imports the client shell's siblings, so the imports need to compile — but you can stub each panel with `export function ReminderContactCard() { return null; }` to unblock.
3. Run **4C**, **4D**, **4E** in true parallel — each is a self-contained component file. A multi-agent setup assigns one per agent; a solo dev writes them in order (contact card first, because it is what the closer looks at).
4. The Phase 5 action bar slot is filled by a `<dynamic />` import of `reminder-outcome-action-bar.tsx` from Phase 5. For Phase 4 to ship independently, we add a placeholder component that renders "Actions coming soon"; Phase 5 overwrites the file.

**Estimated time:** 1.5–2 days.

---

## Subphases

### 4A — Route files: `page.tsx` + `loading.tsx` + `error.tsx`

**Type:** Full-Stack
**Parallelizable:** No within Phase 4 (blocks 4B); Parallelizable with all of Phase 5.

**What:** Create the Next.js 16 RSC route at `app/workspace/closer/reminders/[followUpId]/`:
- `page.tsx` — server component that calls `requireRole(["closer"])`, `preloadQuery(getReminderDetail)`, and hands the result to the client.
- `loading.tsx` — skeleton matching the final layout's grid.
- `error.tsx` — route-level error boundary.

**Why:** This is the auth + preload + streaming scaffold. Without it, visitors get a 404 or bypass role-gating. Every other subphase nests inside this structure.

**Where:**
- `app/workspace/closer/reminders/[followUpId]/page.tsx` (new)
- `app/workspace/closer/reminders/[followUpId]/loading.tsx` (new)
- `app/workspace/closer/reminders/[followUpId]/error.tsx` (new)

**How:**

**Step 1: Create the page RSC.** Mirror `app/workspace/closer/meetings/[meetingId]/page.tsx` for structure — same `unstable_instant = false`, same `requireRole` call, same `preloadQuery` pattern.

```tsx
// Path: app/workspace/closer/reminders/[followUpId]/page.tsx

import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { requireRole } from "@/lib/auth";
import type { Id } from "@/convex/_generated/dataModel";
import { ReminderDetailPageClient } from "./_components/reminder-detail-page-client";

// PPR-ready: page.tsx renders the static shell first, the client shell
// streams in after the preload resolves. See AGENTS.md §RSC for the
// three-layer page pattern.
export const unstable_instant = false;

export default async function ReminderDetailPage({
  params,
}: {
  params: Promise<{ followUpId: string }>;
}) {
  // Closer-only — admins have no reminder UI in MVP (design doc §12.2).
  const { session } = await requireRole(["closer"]);
  const { followUpId } = await params;

  const typedFollowUpId = followUpId as Id<"followUps">;
  const preloadedDetail = await preloadQuery(
    api.closer.reminderDetail.getReminderDetail,
    { followUpId: typedFollowUpId },
    { token: session.accessToken },
  );

  return <ReminderDetailPageClient preloadedDetail={preloadedDetail} />;
}
```

**Step 2: Create the loading skeleton.** Match the final grid (1-col on mobile, 1+3 on desktop) so CLS is minimal.

```tsx
// Path: app/workspace/closer/reminders/[followUpId]/loading.tsx

import { Skeleton } from "@/components/ui/skeleton";

export default function ReminderDetailLoading() {
  return (
    <div
      className="flex flex-col gap-6"
      role="status"
      aria-label="Loading reminder"
    >
      <div className="flex items-center justify-between">
        <Skeleton className="h-9 w-20" /> {/* Back button */}
        <Skeleton className="h-5 w-24 rounded-full" /> {/* Urgency badge */}
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3 lg:grid-cols-4">
        <div className="flex flex-col gap-4 md:col-span-1">
          <Skeleton className="h-64 rounded-xl" /> {/* LeadInfoPanel */}
          <Skeleton className="h-44 rounded-xl" /> {/* ReminderHistoryPanel */}
        </div>
        <div className="flex flex-col gap-6 md:col-span-2 lg:col-span-3">
          <Skeleton className="h-40 rounded-xl" /> {/* ReminderContactCard */}
          <Skeleton className="h-32 rounded-xl" /> {/* ReminderMetadataCard */}
          <Skeleton className="h-52 rounded-xl" /> {/* Action bar */}
        </div>
      </div>
    </div>
  );
}
```

**Step 3: Create the route-level error boundary.** It is a client component (required for error boundaries in the App Router). Keep it calm and actionable.

```tsx
// Path: app/workspace/closer/reminders/[followUpId]/error.tsx
"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { AlertCircleIcon } from "lucide-react";
import posthog from "posthog-js";

export default function ReminderDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Report to PostHog so we see real-world error rates on this route.
    posthog.captureException(error, {
      route: "/workspace/closer/reminders/[followUpId]",
      digest: error.digest,
    });
  }, [error]);

  return (
    <div className="flex flex-col items-center gap-4 py-12">
      <Alert variant="destructive" className="max-w-md">
        <AlertCircleIcon />
        <AlertTitle>Something went wrong</AlertTitle>
        <AlertDescription>
          We couldn&apos;t load this reminder. The error has been reported.
        </AlertDescription>
      </Alert>
      <Button onClick={reset}>Try again</Button>
    </div>
  );
}
```

**Step 4: Typecheck.** At this point the client shell does not exist yet so `./_components/reminder-detail-page-client` will be a missing import. That is expected — we land 4A and 4B as a pair. If your branch workflow requires each subphase to compile alone, create an empty `_components/reminder-detail-page-client.tsx` with a minimal stub.

```tsx
// Path: app/workspace/closer/reminders/[followUpId]/_components/reminder-detail-page-client.tsx
"use client";
export function ReminderDetailPageClient(_props: { preloadedDetail: unknown }) {
  return null;
}
```

Replace the stub fully in 4B.

**Key implementation notes:**
- **`requireRole(["closer"])` is not optional.** The design doc §12.2 restricts this page to closers; admins are redirected. Forgetting this leaks PII to admins who could see any closer's reminder.
- **`unstable_instant = false`.** Matches the meeting detail page and signals the PPR-ready architecture. Do NOT omit.
- **`error.tsx` must be a client component.** `"use client"` at the top. The App Router requires this for error boundaries to receive the `reset` function.
- **`loading.tsx`'s dimensions.** Match the real page's section heights reasonably closely so the skeleton → real transition does not shift layout. The heights in Step 2 are rough; revise after 4B–4E stabilise.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/reminders/[followUpId]/page.tsx` | Create | RSC wrapper + `preloadQuery`. |
| `app/workspace/closer/reminders/[followUpId]/loading.tsx` | Create | Route-level skeleton. |
| `app/workspace/closer/reminders/[followUpId]/error.tsx` | Create | Route-level error boundary. |

---

### 4B — Client shell (`reminder-detail-page-client.tsx`)

**Type:** Frontend
**Parallelizable:** No within Phase 4 (blocks 4C/4D/4E conceptually — they need to exist as importable components, but stubs work); Parallelizable with all of Phase 5.

**What:** The `"use client"` component that consumes the preloaded query via `usePreloadedQuery`, sets the page title, renders the layout grid, and orchestrates the five child components: `LeadInfoPanel`, `ReminderContactCard`, `ReminderMetadataCard`, `ReminderHistoryPanel`, and `ReminderOutcomeActionBar` (Phase 5 — placeholder imported here).

**Why:** Centralising the layout + data-distribution logic in one client component matches the `meeting-detail-page-client.tsx` template. Panels become pure presentational pieces.

**Where:**
- `app/workspace/closer/reminders/[followUpId]/_components/reminder-detail-page-client.tsx` (new or modify from stub)

**How:**

**Step 1: Implement the full client shell. Include the "not found" branch and the "already completed" branch.**

```tsx
// Path: app/workspace/closer/reminders/[followUpId]/_components/reminder-detail-page-client.tsx
"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import type { Preloaded } from "convex/react";
import { usePreloadedQuery } from "convex/react";
import type { api } from "@/convex/_generated/api";
import { usePageTitle } from "@/hooks/use-page-title";
import { ArrowLeftIcon, AlertCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { LeadInfoPanel } from "@/app/workspace/closer/meetings/_components/lead-info-panel";
import { ReminderContactCard } from "./reminder-contact-card";
import { ReminderMetadataCard } from "./reminder-metadata-card";
import { ReminderHistoryPanel } from "./reminder-history-panel";

// Phase 5 owns this file. Dynamic import lets Phase 4 ship with a
// placeholder version (Phase 5 overwrites the file, no shell changes
// required). ssr: true because the action bar is present in the SSR
// markup for fast first paint.
const ReminderOutcomeActionBar = dynamic(() =>
  import("./reminder-outcome-action-bar").then((m) => ({
    default: m.ReminderOutcomeActionBar,
  })),
);

export function ReminderDetailPageClient({
  preloadedDetail,
}: {
  preloadedDetail: Preloaded<
    typeof api.closer.reminderDetail.getReminderDetail
  >;
}) {
  const router = useRouter();
  const detail = usePreloadedQuery(preloadedDetail);
  usePageTitle(detail?.lead.fullName ?? "Reminder");

  // --- Not found / unauthorized — design doc §14.1 ---
  if (detail === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <AlertCircleIcon />
            </EmptyMedia>
            <EmptyTitle>Reminder Not Found</EmptyTitle>
            <EmptyDescription>
              This reminder may have been completed already or doesn&apos;t
              belong to you.
            </EmptyDescription>
            <Button
              variant="outline"
              className="mt-4"
              onClick={() => router.push("/workspace/closer")}
            >
              <ArrowLeftIcon data-icon="inline-start" />
              Back to Dashboard
            </Button>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  const { followUp, opportunity, lead, latestMeeting, payments } = detail;
  const isAlreadyCompleted = followUp.status !== "pending";

  // The onCompleted callback is wired into every Phase-5 dialog.
  // router.push("/workspace/closer") returns the closer to the
  // dashboard where reactive queries have already dropped this
  // reminder from the list.
  const onCompleted = () => router.push("/workspace/closer");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => router.back()}>
          <ArrowLeftIcon data-icon="inline-start" />
          Back
        </Button>
        {/* Urgency badge lives inside ReminderMetadataCard to keep the
            header row visually quieter. A top-right badge is
            intentionally NOT added here. */}
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3 lg:grid-cols-4">
        {/* Left column — lead identity + history */}
        <div className="flex flex-col gap-6 md:col-span-1">
          {/* Reuse the exact same panel from the meeting detail page.
              Pass meetingHistory=[] because this page is reminder-
              centric, not meeting-centric. The panel gracefully hides
              the history section when the array is empty. */}
          <LeadInfoPanel lead={lead} meetingHistory={[]} />
          <ReminderHistoryPanel
            opportunity={opportunity}
            latestMeeting={latestMeeting}
            payments={payments}
          />
        </div>

        {/* Right column — contact + metadata + actions */}
        <div className="flex flex-col gap-6 md:col-span-2 lg:col-span-3">
          <ReminderContactCard followUp={followUp} lead={lead} />
          <ReminderMetadataCard
            followUp={followUp}
            opportunity={opportunity}
            latestMeeting={latestMeeting}
          />
          <ReminderOutcomeActionBar
            followUp={followUp}
            opportunity={opportunity}
            disabled={isAlreadyCompleted}
            onCompleted={onCompleted}
          />
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Typecheck.** This WILL fail if 4C/4D/4E or the Phase 5 action bar stub do not exist yet. Create empty stubs for each:

```tsx
// Path: app/workspace/closer/reminders/[followUpId]/_components/reminder-contact-card.tsx
"use client";
import type { Doc } from "@/convex/_generated/dataModel";
export function ReminderContactCard(_: {
  followUp: Doc<"followUps">;
  lead: Doc<"leads">;
}) {
  return null;
}
```

Repeat for `reminder-metadata-card.tsx`, `reminder-history-panel.tsx`, and `reminder-outcome-action-bar.tsx`. Replace each stub as its owning subphase lands.

**Step 3: Visit `/workspace/closer/reminders/<valid id>` in the browser** with `npm run dev` running. The page should render (with `null`s where the stubs are). Confirm the back button works and the grid columns line up correctly at `lg:` width.

**Key implementation notes:**
- **`usePreloadedQuery` returns the full snapshot synchronously after hydration and subscribes to reactive updates.** If an admin elsewhere marks the opportunity `lost`, this page updates in real time — important for the Phase 5 guardrail in §14.3 of the design doc.
- **Single `onCompleted` handler.** All three Phase 5 dialogs call the same callback on success. Having the parent own the navigation keeps the dialog components route-agnostic and reusable.
- **`LeadInfoPanel` import path.** Use the exact alias path `@/app/workspace/closer/meetings/_components/lead-info-panel` — going through a re-export would force an extra file. Direct import is the codebase convention.
- **`dynamic()` with `ssr: true` (default).** The action bar should be server-rendered so the first paint already shows button placeholders. We are only dynamically importing to decouple the Phase 4 ship date from Phase 5.
- **No nested `useQuery`.** Everything the page needs came through the preloaded query in 4A. Any `useQuery` call here would introduce a waterfall.
- **Do NOT wrap each child in its own Suspense.** The whole shell is under the route-level Suspense governed by `loading.tsx`. Adding more boundaries just adds more skeletons.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-detail-page-client.tsx` | Create (or modify stub) | Full client shell + layout. |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-contact-card.tsx` | Create (stub) | Empty component — replaced in 4C. |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-metadata-card.tsx` | Create (stub) | Empty component — replaced in 4D. |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-history-panel.tsx` | Create (stub) | Empty component — replaced in 4E. |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-outcome-action-bar.tsx` | Create (stub) | Empty component — fully owned by Phase 5. |

---

### 4C — `ReminderContactCard`

**Type:** Frontend
**Parallelizable:** Yes — independent file, only imports `Doc` types + shadcn primitives.

**What:** The card the closer looks at while placing the call or text. Large tappable `tel:` and `sms:` buttons, a copy-phone button, the reminder's note, and a subtle label for the contact method the closer originally chose.

**Why:** This card is the single most important piece of UI on the page. The design doc §7.6 calls it out specifically. Mobile optimisation is the whole reason we're going full-page instead of inline.

**Where:**
- `app/workspace/closer/reminders/[followUpId]/_components/reminder-contact-card.tsx` (modify the 4B stub)

**How:**

**Step 1: Replace the stub with the full implementation.**

```tsx
// Path: app/workspace/closer/reminders/[followUpId]/_components/reminder-contact-card.tsx
"use client";

import { useState } from "react";
import { PhoneIcon, MessageSquareIcon, CopyIcon, CheckIcon } from "lucide-react";
import { toast } from "sonner";
import type { Doc } from "@/convex/_generated/dataModel";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

type Props = {
  followUp: Doc<"followUps">;
  lead: Doc<"leads">;
};

/**
 * Contact card — the visual anchor of the reminder page.
 * Renders the lead's phone as:
 *   - a large primary `tel:` button (call)
 *   - a secondary `sms:` button (text)
 *   - a copy-phone button for desktop users without a tel handler
 * Plus the reminder's note and the contact method the closer chose.
 */
export function ReminderContactCard({ followUp, lead }: Props) {
  const [copied, setCopied] = useState(false);

  // Prefer the explicitly stored phone; fall back to nothing rather
  // than invent a handle. If the lead has no phone, render an alert
  // row explaining the limitation (rare but schema-legal).
  const phone = lead.phone?.trim() || null;
  const method = followUp.contactMethod ?? "call";
  const reminderNote = followUp.reminderNote?.trim();

  const copyPhone = async () => {
    if (!phone) return;
    try {
      await navigator.clipboard.writeText(phone);
      setCopied(true);
      toast.success("Phone number copied");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy — please long-press the number");
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>Contact</CardTitle>
          <Badge variant="secondary" className="capitalize">
            {method === "text" ? "Text first" : "Call first"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* Lead name + phone line. Phone is rendered as selectable
            text alongside the buttons so it can be read aloud easily. */}
        <div className="flex flex-col gap-1">
          <div className="text-lg font-semibold">{lead.fullName || lead.email}</div>
          {phone ? (
            <div className="text-muted-foreground text-sm tabular-nums">
              {phone}
            </div>
          ) : (
            <div className="text-destructive text-sm">
              No phone number on file for this lead.
            </div>
          )}
        </div>

        {/* Primary CTA row. `w-full` on each button + `flex flex-col
            gap-2 sm:flex-row` responsive lay-out = stacked full-width
            on mobile, horizontal trio on ≥sm. Target size is
            comfortably above 44×44 via shadcn size="lg". */}
        {phone && (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              asChild
              size="lg"
              className="flex-1"
              aria-label={`Call ${lead.fullName ?? "lead"} at ${phone}`}
            >
              <a href={`tel:${phone}`}>
                <PhoneIcon data-icon="inline-start" />
                Call
              </a>
            </Button>
            <Button
              asChild
              size="lg"
              variant="secondary"
              className="flex-1"
              aria-label={`Text ${lead.fullName ?? "lead"} at ${phone}`}
            >
              <a href={`sms:${phone}`}>
                <MessageSquareIcon data-icon="inline-start" />
                Text
              </a>
            </Button>
            <Button
              size="lg"
              variant="outline"
              onClick={copyPhone}
              aria-label="Copy phone number"
            >
              {copied ? (
                <>
                  <CheckIcon data-icon="inline-start" />
                  Copied
                </>
              ) : (
                <>
                  <CopyIcon data-icon="inline-start" />
                  Copy
                </>
              )}
            </Button>
          </div>
        )}

        {/* Reminder note — shown only if present. Designed to look
            like a calm aside, not a call-to-action. */}
        {reminderNote && (
          <div className="bg-muted/50 rounded-lg p-3">
            <div className="text-muted-foreground text-xs font-medium uppercase">
              Note to self
            </div>
            <div className="mt-1 whitespace-pre-wrap text-sm">{reminderNote}</div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
```

**Step 2: Verify target sizes and contrast** with the `web-design-guidelines` skill. The `size="lg"` buttons from shadcn measure ~48px tall, which exceeds the 44×44 threshold comfortably.

**Step 3: Tap-test on mobile.** Run `npm run dev` with an iPhone / Android device on the same network and confirm `tel:` opens the dialer, `sms:` opens Messages, `Copy` writes to the clipboard and toasts.

**Key implementation notes:**
- **Do not modify `tel:` or `sms:` URLs.** No `?body=...`, no country-code injection. Let the device handle dialing semantics; cross-region prefixing is out of scope.
- **`aria-label` on each button includes the lead name AND the number.** Screen readers announce both; sighted users see the visible label "Call" / "Text" / "Copy".
- **`asChild` pattern for the anchor-buttons.** shadcn's `<Button asChild><a>...</a></Button>` composes styling with proper anchor semantics — no hack with `onClick={() => window.location = ...}`.
- **Fallback when no phone.** Render a muted alert inside the card body; do NOT hide the card entirely. The closer still wants to see the note.
- **`tabular-nums` on the phone.** Monospaced digits read faster when dialling.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-contact-card.tsx` | Modify | Replace 4B stub with full card. |

---

### 4D — `ReminderMetadataCard`

**Type:** Frontend
**Parallelizable:** Yes — independent file.

**What:** A compact card rendering the reminder's scheduled time (friendly formatted), the urgency badge (reusing `getReminderUrgency`), the reason code, and a link to the related meeting detail page if one exists.

**Why:** The closer needs "is this urgent?" + "what was this about?" at a glance before diving into the contact card. Meeting link support keeps the history accessible with one click.

**Where:**
- `app/workspace/closer/reminders/[followUpId]/_components/reminder-metadata-card.tsx` (modify the 4B stub)

**How:**

**Step 1: Replace the stub.**

```tsx
// Path: app/workspace/closer/reminders/[followUpId]/_components/reminder-metadata-card.tsx
"use client";

import Link from "next/link";
import { format, formatDistanceToNow } from "date-fns";
import { CalendarIcon, ClockIcon, ExternalLinkIcon } from "lucide-react";
import type { Doc } from "@/convex/_generated/dataModel";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { getReminderUrgency } from "@/app/workspace/closer/_components/reminders-section";

type Props = {
  followUp: Doc<"followUps">;
  opportunity: Doc<"opportunities">;
  latestMeeting: Doc<"meetings"> | null;
};

/**
 * Metadata card — "what is this reminder about, and how urgent?"
 * Keeps content dense; the contact card is where visual weight sits.
 */
export function ReminderMetadataCard({
  followUp,
  opportunity,
  latestMeeting,
}: Props) {
  // `getReminderUrgency` is the same helper used on the dashboard card
  // (see AGENTS.md §9.3 of the design doc — Phase 6 retains it). It
  // returns one of "overdue" | "due_soon" | "upcoming" plus a class
  // token string.
  const urgency = followUp.reminderScheduledAt
    ? getReminderUrgency(followUp.reminderScheduledAt)
    : null;

  const scheduledAt = followUp.reminderScheduledAt;
  const scheduledLabel = scheduledAt
    ? format(new Date(scheduledAt), "EEE, MMM d · h:mm a")
    : null;
  const scheduledRelative = scheduledAt
    ? formatDistanceToNow(new Date(scheduledAt), { addSuffix: true })
    : null;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Reminder</CardTitle>
          {urgency && (
            <Badge className={cn(urgency.badgeClass)} variant="secondary">
              {urgency.label}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {scheduledLabel && (
          <div className="flex items-center gap-2">
            <CalendarIcon className="text-muted-foreground size-4" />
            <span className="font-medium">{scheduledLabel}</span>
            <span className="text-muted-foreground">
              ({scheduledRelative})
            </span>
          </div>
        )}

        {followUp.reason && (
          <div className="flex items-start gap-2">
            <ClockIcon className="text-muted-foreground mt-0.5 size-4" />
            <div>
              <div className="text-muted-foreground text-xs uppercase">
                Reason
              </div>
              <div>{humaniseReason(followUp.reason)}</div>
            </div>
          </div>
        )}

        {latestMeeting && (
          <div className="flex items-center justify-between border-t pt-3">
            <div className="text-muted-foreground text-xs">
              Related meeting
            </div>
            <Link
              href={`/workspace/closer/meetings/${latestMeeting._id}`}
              className="text-primary inline-flex items-center gap-1 text-sm hover:underline"
            >
              View meeting
              <ExternalLinkIcon className="size-3" />
            </Link>
          </div>
        )}

        <div className="text-muted-foreground border-t pt-2 text-xs">
          Opportunity status:{" "}
          <span className="font-medium capitalize">
            {opportunity.status.replace(/_/g, " ")}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Keep this function local — converting `reason` codes to human
 * labels is a Phase 4 concern, not worth a shared util until a
 * second consumer appears.
 */
function humaniseReason(reason: string): string {
  switch (reason) {
    case "closer_initiated":
      return "Closer set this reminder manually";
    case "no_show_follow_up":
      return "Follow-up after no-show";
    case "canceled_follow_up":
      return "Follow-up after cancellation";
    default:
      return reason.replace(/_/g, " ");
  }
}
```

**Step 2: Confirm `getReminderUrgency` is exported from `reminders-section.tsx`.** If it is currently private, move it to a shared util file in a tiny pre-step (still Phase 4D — not worth its own subphase). Proposal: `app/workspace/closer/_components/reminder-urgency.ts` exporting `getReminderUrgency` and its return shape type; update `reminders-section.tsx` to import from there. Both Phase 4 and Phase 6 then consume the util; nothing leaks.

**Step 3: Spot-check in the browser.** A reminder scheduled 10 minutes in the past should show the `overdue` badge. One scheduled in 2 hours should show `due_soon`. One scheduled tomorrow should show `upcoming`.

**Key implementation notes:**
- **`humaniseReason` is local.** Do not ship to `lib/` yet; only two or three callers exist. YAGNI.
- **`capitalize` on opportunity status.** Tailwind's `capitalize` only capitalises the first letter — combined with `.replace(/_/g, " ")` we get "Follow up scheduled". For stricter typography, replace with a status config lookup — but that is shared work, out of Phase 4 scope.
- **Meeting link uses `next/link`.** No `router.push` onClick — semantic anchors are better for open-in-new-tab + right-click.
- **Urgency badge passes through `cn()`.** The `badgeClass` token from `getReminderUrgency` is Tailwind utility classes (e.g., `"bg-destructive/15 text-destructive"`); `cn()` safely merges them.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-metadata-card.tsx` | Modify | Replace 4B stub with full card. |
| `app/workspace/closer/_components/reminder-urgency.ts` | Create (if extraction needed) | Shared `getReminderUrgency` helper. |
| `app/workspace/closer/_components/reminders-section.tsx` | Modify (if extraction needed) | Re-import `getReminderUrgency` from the new util. |

---

### 4E — `ReminderHistoryPanel`

**Type:** Frontend
**Parallelizable:** Yes — independent file.

**What:** A left-column card showing: the latest meeting's status + scheduled time (or "No prior meetings" muted), and the compact list of prior payment rows on the opportunity (amount + currency + date), or nothing if empty.

**Why:** When the closer lands on a reminder, context is half the battle. "Have we already taken a deposit?" and "Did this lead no-show the last time?" are both answerable from this card. Keeping it on the left column matches the meeting detail page layout.

**Where:**
- `app/workspace/closer/reminders/[followUpId]/_components/reminder-history-panel.tsx` (modify the 4B stub)

**How:**

**Step 1: Replace the stub.**

```tsx
// Path: app/workspace/closer/reminders/[followUpId]/_components/reminder-history-panel.tsx
"use client";

import { format } from "date-fns";
import type { Doc } from "@/convex/_generated/dataModel";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  opportunityStatusConfig,
  type OpportunityStatus,
} from "@/lib/status-config";
import { cn } from "@/lib/utils";

type Props = {
  opportunity: Doc<"opportunities">;
  latestMeeting: Doc<"meetings"> | null;
  payments: Doc<"paymentRecords">[];
};

export function ReminderHistoryPanel({
  opportunity,
  latestMeeting,
  payments,
}: Props) {
  void opportunity; // reserved for future "attempt count" summary

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">History</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {/* Latest meeting — simplified MeetingInfoPanel */}
        <div>
          <div className="text-muted-foreground mb-1 text-xs uppercase">
            Latest meeting
          </div>
          {latestMeeting ? (
            <LatestMeetingRow meeting={latestMeeting} />
          ) : (
            <div className="text-muted-foreground text-sm">
              No prior meetings.
            </div>
          )}
        </div>

        {payments.length > 0 && (
          <>
            <Separator />
            <div>
              <div className="text-muted-foreground mb-1 text-xs uppercase">
                Payments ({payments.length})
              </div>
              <ul className="flex flex-col gap-1.5">
                {payments.map((payment) => (
                  <PaymentRow key={payment._id} payment={payment} />
                ))}
              </ul>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function LatestMeetingRow({ meeting }: { meeting: Doc<"meetings"> }) {
  // The opportunity status config covers meeting statuses indirectly
  // via the parent opportunity — but for the meeting row we render the
  // meeting's own status for clarity. A small local lookup keeps the
  // panel self-sufficient.
  const when = format(new Date(meeting.scheduledAt), "MMM d · h:mm a");
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="text-sm">{when}</div>
      <Badge variant="outline" className="capitalize">
        {meeting.status.replace(/_/g, " ")}
      </Badge>
    </div>
  );
}

function PaymentRow({ payment }: { payment: Doc<"paymentRecords"> }) {
  const amount = (payment.amountMinor / 100).toFixed(2);
  const date = format(new Date(payment.recordedAt ?? payment._creationTime), "MMM d");
  void opportunityStatusConfig; // imported for future status-coloured rows
  void cn;
  return (
    <li className="flex items-center justify-between text-sm tabular-nums">
      <span className="text-muted-foreground">{date}</span>
      <span className="font-medium">
        {amount} {payment.currency.toUpperCase()}
      </span>
    </li>
  );
}

// Imports ensure eventual status-config reuse; suppress lint noise
// if the reviewer's config flags currently-unused references.
export type _OpportunityStatusFromConfig = OpportunityStatus;
```

**Step 2: Confirm the panel renders correctly in three scenarios:**
- Opportunity with no meeting and no payments → only "No prior meetings" row.
- Opportunity with a meeting but no payments → meeting row only.
- Opportunity with a meeting + 2 payments → meeting row + divider + payment list.

**Key implementation notes:**
- **`void opportunity`.** Kept for future features ("how many attempts has this opportunity had?"); does not emit runtime code. Delete if your lint config complains.
- **Amount rendering.** Convex stores amounts in `amountMinor` (integer cents). Divide by 100 and `.toFixed(2)`. Matches the meeting detail payment display. We deliberately do NOT format with `Intl.NumberFormat` yet — the existing meeting panel doesn't either, and consistency beats precision for a compact history row.
- **Do not link payments to anywhere.** The full payment view lives on the meeting detail page; this panel is contextual.
- **No pagination.** Phase 2 already bounds payments to `.take(10)`. If that limit is ever hit, the history panel will show only the most recent 10 — acceptable for MVP.
- **Small typography.** `text-sm` and `text-xs uppercase` labels keep the left column visually quiet relative to the right column's action bar.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-history-panel.tsx` | Modify | Replace 4B stub with the full history panel. |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/closer/reminders/[followUpId]/page.tsx` | Create | 4A |
| `app/workspace/closer/reminders/[followUpId]/loading.tsx` | Create | 4A |
| `app/workspace/closer/reminders/[followUpId]/error.tsx` | Create | 4A |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-detail-page-client.tsx` | Create | 4B |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-outcome-action-bar.tsx` | Create (stub) | 4B (placeholder; Phase 5 fills it) |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-contact-card.tsx` | Create | 4C |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-metadata-card.tsx` | Create | 4D |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-history-panel.tsx` | Create | 4E |
| `app/workspace/closer/_components/reminder-urgency.ts` | Create (if extracted) | 4D |
| `app/workspace/closer/_components/reminders-section.tsx` | Modify (if extraction done) | 4D |
