# Phase 2 — Frontend Card Components

**Goal:** Build the two new standalone card components — Deal Won Card (I1+I2) and Attribution Card (I4+I3) — as independent, self-contained files. After this phase, both cards are importable and renderable but not yet wired into the meeting detail page layout (that happens in Phase 4).

**Prerequisite:** Phase 1 complete. `npx convex dev` deployed with `meetingOutcome` field. `getMeetingDetail` returns enriched payment records with `proofFileUrl`, `proofFileContentType`, `proofFileSize`, and `closerName`.

**Runs in PARALLEL with:** Phase 3 (Notes Enhancement & Meeting Outcome Tags). Phase 2 creates card components in separate files (`deal-won-card.tsx`, `attribution-card.tsx`). Phase 3 creates a different component (`meeting-outcome-select.tsx`) and modifies a different file (`meeting-notes.tsx`). Zero file overlap.

**Skills to invoke:**
- `shadcn` — Card, Badge, Button, Dialog, Select, Separator components used across both cards.
- `frontend-design` — Production-grade card layouts with responsive grids, consistent spacing, typography hierarchy.

**Acceptance Criteria:**
1. `DealWonCard` renders correctly with payment details: formatted amount (via `Intl.NumberFormat`), provider name, reference code (if present), "Recorded at" timestamp, "Recorded By" closer name, and payment status badge.
2. `DealWonCard` displays image proof files as a 64px thumbnail with a hover overlay and a lightbox dialog on click.
3. `DealWonCard` displays non-image proof files (PDF, etc.) as a file icon with a download/open link.
4. `DealWonCard` renders nothing (returns `null`) when `payments.length === 0`.
5. `AttributionCard` displays UTM parameters (source, medium, campaign, term, content) from the opportunity, with fallback to meeting-level UTM.
6. `AttributionCard` shows "No UTM attribution data available" when both opportunity and meeting have no UTM params.
7. `AttributionCard` infers and displays the booking type badge: "Organic" (first meeting), "Follow-Up" (previous meeting completed), or "Reschedule" (previous meeting canceled/no-show).
8. `AttributionCard` includes a "View original" link pointing to the predecessor meeting when booking type is Follow-Up or Reschedule.
9. Both cards use shadcn/ui primitives exclusively (Card, CardHeader, CardTitle, CardContent, Badge, Button, Dialog, Separator) and match the existing meeting detail page's visual language.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
2A (DealWonCard component) ────────────────────────────────────────┐
                                                                    ├── (both complete → Phase 4 integrates)
2B (AttributionCard component) ────────────────────────────────────┘
```

**Optimal execution:**
1. Start 2A and 2B **in parallel** — they create separate files with zero shared imports or state.
2. Both complete → ready for Phase 4 integration.

**Estimated time:** ~1 hour (2A and 2B each ~30 min, running in parallel = ~30 min wall time)

---

## Subphases

### 2A — Deal Won Card Component

**Type:** Frontend
**Parallelizable:** Yes — creates a new file, no dependency on 2B.

**What:** Create `deal-won-card.tsx` — a card component that displays payment details prominently when the opportunity is `payment_received`. Includes inline proof file display with image thumbnail + lightbox, PDF download link, payment status badge, and "Recorded By" closer name.

**Why:** Fulfills I1 (Won Deal Display) and I2 (Proof File Display). Currently, payment details are recorded but never displayed back to the closer. The Deal Won card makes the outcome celebratory and informative — the closer sees the actual amount, proof, and status at a glance.

**Where:**
- `app/workspace/closer/meetings/_components/deal-won-card.tsx` (new)

**How:**

**Step 1: Create the component file**

```tsx
// Path: app/workspace/closer/meetings/_components/deal-won-card.tsx

"use client";

import { useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  TrophyIcon,
  CreditCardIcon,
  UserIcon,
  CalendarIcon,
  FileIcon,
  ImageIcon,
  DownloadIcon,
  ZoomInIcon,
  ExternalLinkIcon,
} from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";

// ─── Types ──────────────────────────────────────────────────────────────────

type EnrichedPayment = {
  _id: string;
  amount: number;
  currency: string;
  provider: string;
  referenceCode?: string;
  status: "recorded" | "verified" | "disputed";
  recordedAt: number;
  proofFileUrl: string | null;
  proofFileContentType: string | null;
  proofFileSize: number | null;
  closerName: string | null;
};

type DealWonCardProps = {
  payments: EnrichedPayment[];
};

// ─── Config ─────────────────────────────────────────────────────────────────

const PAYMENT_STATUS_CONFIG = {
  recorded: {
    label: "Recorded",
    badgeClass:
      "bg-blue-500/10 text-blue-700 border-blue-200 dark:text-blue-400 dark:border-blue-900",
  },
  verified: {
    label: "Verified",
    badgeClass:
      "bg-emerald-500/10 text-emerald-700 border-emerald-200 dark:text-emerald-400 dark:border-emerald-900",
  },
  disputed: {
    label: "Disputed",
    badgeClass:
      "bg-red-500/10 text-red-700 border-red-200 dark:text-red-400 dark:border-red-900",
  },
} as const;

// ─── Component ──────────────────────────────────────────────────────────────

/**
 * Deal Won Card — displays payment details when opportunity is payment_received.
 *
 * Shows: amount, provider, reference code, recorded timestamp, recorded by,
 * payment status badge, and proof file (image thumbnail with lightbox, or
 * PDF/file download link).
 *
 * Returns null when no payments exist (guard in parent component ensures
 * this card only renders for won opportunities with payments).
 */
export function DealWonCard({ payments }: DealWonCardProps) {
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  if (payments.length === 0) return null;

  return (
    <Card className="border-emerald-200 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/30">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <TrophyIcon className="size-5 text-emerald-600 dark:text-emerald-400" />
          <CardTitle className="text-base">Deal Won</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {payments.map((payment, idx) => {
          const statusCfg = PAYMENT_STATUS_CONFIG[payment.status];
          const isImage = isImageContentType(payment.proofFileContentType);

          return (
            <div key={payment._id}>
              {idx > 0 && <Separator className="mb-4" />}

              {/* Payment details grid */}
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
                {/* Amount */}
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Amount Paid
                  </dt>
                  <dd className="text-lg font-semibold">
                    {formatCurrency(payment.amount, payment.currency)}
                  </dd>
                </div>

                {/* Provider */}
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Provider
                  </dt>
                  <dd className="flex items-center gap-1.5 text-sm font-medium">
                    <CreditCardIcon className="size-3.5 text-muted-foreground" />
                    {payment.provider}
                  </dd>
                </div>

                {/* Reference Code */}
                {payment.referenceCode && (
                  <div>
                    <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Reference
                    </dt>
                    <dd className="truncate font-mono text-sm">
                      {payment.referenceCode}
                    </dd>
                  </div>
                )}

                {/* Recorded At */}
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Recorded
                  </dt>
                  <dd className="flex items-center gap-1.5 text-sm">
                    <CalendarIcon className="size-3.5 text-muted-foreground" />
                    {format(payment.recordedAt, "MMM d, yyyy 'at' h:mm a")}
                  </dd>
                </div>

                {/* Recorded By */}
                {payment.closerName && (
                  <div>
                    <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Recorded By
                    </dt>
                    <dd className="flex items-center gap-1.5 text-sm font-medium">
                      <UserIcon className="size-3.5 text-muted-foreground" />
                      {payment.closerName}
                    </dd>
                  </div>
                )}

                {/* Status */}
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Status
                  </dt>
                  <dd>
                    <Badge
                      variant="secondary"
                      className={cn("text-xs", statusCfg.badgeClass)}
                    >
                      {statusCfg.label}
                    </Badge>
                  </dd>
                </div>
              </dl>

              {/* Proof File Display (I2) */}
              {payment.proofFileUrl && (
                <div className="mt-4">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Proof of Payment
                  </p>
                  <div className="flex items-center gap-3 rounded-lg border bg-background p-3">
                    {isImage ? (
                      <>
                        {/* Image thumbnail with lightbox trigger */}
                        <button
                          type="button"
                          onClick={() => setLightboxUrl(payment.proofFileUrl)}
                          className="group relative shrink-0 overflow-hidden rounded-md border"
                          aria-label="View proof image full size"
                        >
                          <img
                            src={payment.proofFileUrl}
                            alt="Payment proof"
                            className="size-16 object-cover transition-opacity group-hover:opacity-80"
                          />
                          <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/20">
                            <ZoomInIcon className="size-4 text-white opacity-0 transition-opacity group-hover:opacity-100" />
                          </div>
                        </button>
                        <div className="min-w-0 flex-1">
                          <p className="flex items-center gap-1.5 text-sm font-medium">
                            <ImageIcon className="size-3.5 text-blue-600 dark:text-blue-400" />
                            Image proof
                          </p>
                          {payment.proofFileSize != null && (
                            <p className="text-xs text-muted-foreground">
                              {formatFileSize(payment.proofFileSize)}
                            </p>
                          )}
                        </div>
                      </>
                    ) : (
                      <>
                        {/* Non-image file (PDF, etc.) */}
                        <div className="flex size-16 shrink-0 items-center justify-center rounded-md border bg-muted">
                          <FileIcon className="size-6 text-muted-foreground" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="flex items-center gap-1.5 text-sm font-medium">
                            <FileIcon className="size-3.5 text-muted-foreground" />
                            {payment.proofFileContentType === "application/pdf"
                              ? "PDF proof"
                              : "File proof"}
                          </p>
                          {payment.proofFileSize != null && (
                            <p className="text-xs text-muted-foreground">
                              {formatFileSize(payment.proofFileSize)}
                            </p>
                          )}
                        </div>
                      </>
                    )}

                    {/* Download / Open button */}
                    <Button variant="outline" size="sm" asChild>
                      <a
                        href={payment.proofFileUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {isImage ? (
                          <ExternalLinkIcon data-icon="inline-start" />
                        ) : (
                          <DownloadIcon data-icon="inline-start" />
                        )}
                        {isImage ? "Open" : "Download"}
                      </a>
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* Image Lightbox Dialog */}
        <Dialog
          open={lightboxUrl !== null}
          onOpenChange={(open) => {
            if (!open) setLightboxUrl(null);
          }}
        >
          <DialogContent className="max-w-3xl p-2">
            <DialogTitle className="sr-only">Payment proof image</DialogTitle>
            {lightboxUrl && (
              <img
                src={lightboxUrl}
                alt="Payment proof — full size"
                className="w-full rounded-lg"
              />
            )}
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isImageContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  return contentType.startsWith("image/");
}

function formatCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amount);
  } catch {
    // Fallback for unsupported currency codes
    return `${currency.toUpperCase()} ${amount.toFixed(2)}`;
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
```

**Key implementation notes:**
- The component receives the **enriched** `payments` array from `getMeetingDetail` (Phase 1B). It does NOT call `getPaymentProofUrl` — all data is pre-resolved.
- `isImageContentType` checks `contentType.startsWith("image/")` — this covers `image/jpeg`, `image/png`, `image/gif`, `image/webp`. The `contentType` comes from the Convex `_storage` system table, set by the browser during upload.
- The lightbox uses shadcn `Dialog` (Radix Dialog) which provides: `role="dialog"`, focus trapping, Esc to close, click-outside to close. The `DialogTitle` is `sr-only` for screen reader accessibility.
- `formatCurrency` uses `Intl.NumberFormat` for locale-aware formatting. Falls back to manual formatting for edge cases.
- The card has a subtle emerald tint background (`bg-emerald-50/50`) to visually distinguish it as a celebratory/positive element — consistent with the `payment_received` status color in `status-config.ts`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/deal-won-card.tsx` | Create | Deal Won card with payment details + proof file display |

---

### 2B — Attribution Card Component

**Type:** Frontend
**Parallelizable:** Yes — creates a new file, no dependency on 2A.

**What:** Create `attribution-card.tsx` — a card component that displays UTM attribution parameters and booking type (Organic / Follow-Up / Reschedule) with a link to the original meeting.

**Why:** Fulfills I4 (UTM Attribution Card) and I3 (Meeting Reschedule Chain — via the booking type badge and "View original" link). The closer needs to know how the lead arrived — this data has been captured by Feature G but never surfaced in the UI.

**Where:**
- `app/workspace/closer/meetings/_components/attribution-card.tsx` (new)

**How:**

**Step 1: Create the component file**

```tsx
// Path: app/workspace/closer/meetings/_components/attribution-card.tsx

"use client";

import Link from "next/link";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  TrendingUpIcon,
  GlobeIcon,
  MegaphoneIcon,
  TargetIcon,
  SearchIcon,
  FileTextIcon,
  ArrowRightIcon,
} from "lucide-react";
import type { Doc } from "@/convex/_generated/dataModel";

// ─── Types ──────────────────────────────────────────────────────────────────

type AttributionCardProps = {
  opportunity: Doc<"opportunities">;
  meeting: Doc<"meetings">;
  meetingHistory: Array<
    Doc<"meetings"> & {
      opportunityStatus: Doc<"opportunities">["status"];
      isCurrentMeeting: boolean;
    }
  >;
};

// ─── Config ─────────────────────────────────────────────────────────────────

const BOOKING_TYPE_CONFIG = {
  organic: {
    label: "Organic",
    badgeClass:
      "bg-blue-500/10 text-blue-700 border-blue-200 dark:text-blue-400 dark:border-blue-900",
  },
  follow_up: {
    label: "Follow-Up",
    badgeClass:
      "bg-violet-500/10 text-violet-700 border-violet-200 dark:text-violet-400 dark:border-violet-900",
  },
  reschedule: {
    label: "Reschedule",
    badgeClass:
      "bg-orange-500/10 text-orange-700 border-orange-200 dark:text-orange-400 dark:border-orange-900",
  },
} as const;

type BookingType = keyof typeof BOOKING_TYPE_CONFIG;

// ─── Booking Type Inference ─────────────────────────────────────────────────

/**
 * Infer the booking type from the meeting's position in the meeting history.
 *
 * Logic (meetings sorted by scheduledAt ascending):
 * - No prior meetings → "organic" (first booking for this lead)
 * - Previous meeting status is "canceled" or "no_show" → "reschedule"
 * - Previous meeting exists with any other status → "follow_up"
 *
 * The inference is client-side from the meetingHistory array — no
 * denormalization needed.
 */
function inferBookingType(
  meetingId: string,
  meetingHistory: AttributionCardProps["meetingHistory"],
): { type: BookingType; originalMeetingId?: string } {
  // Sort ascending for chronological order
  const sorted = [...meetingHistory].sort(
    (a, b) => a.scheduledAt - b.scheduledAt,
  );
  const currentIdx = sorted.findIndex((m) => m._id === meetingId);

  if (currentIdx <= 0) {
    return { type: "organic" };
  }

  const prevMeeting = sorted[currentIdx - 1];
  if (
    prevMeeting.status === "canceled" ||
    prevMeeting.status === "no_show"
  ) {
    return { type: "reschedule", originalMeetingId: prevMeeting._id };
  }

  return { type: "follow_up", originalMeetingId: prevMeeting._id };
}

// ─── Component ──────────────────────────────────────────────────────────────

/**
 * Attribution Card — displays UTM source tracking and booking type.
 *
 * Shows:
 * - UTM parameters (source, medium, campaign, term, content) from the
 *   opportunity's first booking. Falls back to meeting-level UTM.
 * - Booking type badge: Organic / Follow-Up / Reschedule.
 * - "View original" link to the predecessor meeting.
 *
 * Always rendered (even without UTM data) — the booking type section
 * provides value regardless of UTM presence.
 */
export function AttributionCard({
  opportunity,
  meeting,
  meetingHistory,
}: AttributionCardProps) {
  // Use opportunity-level UTM (first booking) as canonical attribution source.
  // Fall back to meeting-level UTM if opportunity has none (pre-Feature G data).
  const utm = opportunity.utmParams ?? meeting.utmParams;

  const { type: bookingType, originalMeetingId } = inferBookingType(
    meeting._id,
    meetingHistory,
  );
  const bookingCfg = BOOKING_TYPE_CONFIG[bookingType];

  const hasUtm = utm && Object.values(utm).some((v) => v !== undefined);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <TrendingUpIcon className="size-4" />
          Attribution
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* UTM Parameters */}
        {hasUtm ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
            {utm.utm_source && (
              <UtmField
                icon={<GlobeIcon />}
                label="Source"
                value={utm.utm_source}
              />
            )}
            {utm.utm_medium && (
              <UtmField
                icon={<MegaphoneIcon />}
                label="Medium"
                value={utm.utm_medium}
              />
            )}
            {utm.utm_campaign && (
              <UtmField
                icon={<TargetIcon />}
                label="Campaign"
                value={utm.utm_campaign}
              />
            )}
            {utm.utm_term && (
              <UtmField
                icon={<SearchIcon />}
                label="Term"
                value={utm.utm_term}
              />
            )}
            {utm.utm_content && (
              <UtmField
                icon={<FileTextIcon />}
                label="Content"
                value={utm.utm_content}
              />
            )}
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">
            No UTM attribution data available for this opportunity.
          </p>
        )}

        <Separator />

        {/* Booking Type */}
        <div className="flex items-center justify-between">
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Booking Type
            </p>
            <Badge variant="secondary" className={bookingCfg.badgeClass}>
              {bookingCfg.label}
            </Badge>
          </div>
          {originalMeetingId && (
            <Link
              href={`/workspace/closer/meetings/${originalMeetingId}`}
              className="flex items-center gap-1 text-xs text-primary hover:underline"
            >
              View original
              <ArrowRightIcon className="size-3" />
            </Link>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Internal ────────────────────────────────────────────────────────────────

function UtmField({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <span className="[&>svg]:size-3">{icon}</span>
        {label}
      </dt>
      <dd className="text-sm font-medium">{value}</dd>
    </div>
  );
}
```

**Key implementation notes:**
- Booking type is inferred client-side from the `meetingHistory` array that `getMeetingDetail` already returns. No additional backend query or stored field needed.
- The `meetingHistory` includes meetings across all opportunities for this lead, sorted by `scheduledAt`. The inference checks the immediately preceding meeting in chronological order.
- The "View original" link uses Next.js `<Link>` for client-side navigation. The href pattern matches the existing meeting detail route.
- The card always renders (not conditionally hidden) because the booking type section is useful even without UTM data. The UTM section gracefully degrades to a "No data available" message.
- Icon choice maps UTM fields to semantic icons: Globe (Source), Megaphone (Medium), Target (Campaign), Search (Term), FileText (Content).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/attribution-card.tsx` | Create | Attribution card with UTM display + booking type inference |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/closer/meetings/_components/deal-won-card.tsx` | Create | 2A |
| `app/workspace/closer/meetings/_components/attribution-card.tsx` | Create | 2B |
