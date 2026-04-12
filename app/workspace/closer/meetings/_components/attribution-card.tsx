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
  noshow_reschedule: {
    label: "No-Show Reschedule",
    badgeClass:
      "bg-red-500/10 text-red-700 border-red-200 dark:text-red-400 dark:border-red-900",
  },
} as const;

type BookingType = keyof typeof BOOKING_TYPE_CONFIG;

// ─── Booking Type Inference ─────────────────────────────────────────────────

/**
 * Infer the booking type from the meeting's position in the meeting history.
 *
 * Logic:
 * 1. Check for no-show reschedule markers (takes priority):
 *    - UTM path (B3): utm_source === "ptdom" && utm_medium === "noshow_resched"
 *    - Field path (B4): meeting.rescheduledFromMeetingId is set (pipeline heuristic)
 * 2. Chronological inference (meetings sorted by scheduledAt ascending):
 *    - No prior meetings → "organic" (first booking for this lead)
 *    - Previous meeting status is "canceled" or "no_show" → "reschedule"
 *    - Previous meeting exists with any other status → "follow_up"
 *
 * No-show reschedule markers take priority over chronological inference.
 */
function inferBookingType(
  meeting: Doc<"meetings">,
  meetingHistory: AttributionCardProps["meetingHistory"],
): { type: BookingType; originalMeetingId?: string } {
  // === Feature B: No-Show Reschedule detection (takes priority) ===
  // Path 1 (B3): UTM-linked — closer generated a reschedule link with no-show UTMs
  const utm = meeting.utmParams;
  if (utm?.utm_source === "ptdom" && utm?.utm_medium === "noshow_resched") {
    // utm_content contains the original no-show meeting ID (set by B3 link generation)
    return {
      type: "noshow_reschedule",
      originalMeetingId: utm.utm_content ?? undefined,
    };
  }

  // Path 2 (B4): Field-linked — pipeline heuristic detected an organic reschedule
  if (meeting.rescheduledFromMeetingId) {
    return {
      type: "noshow_reschedule",
      originalMeetingId: meeting.rescheduledFromMeetingId,
    };
  }
  // === End Feature B ===

  // Existing chronological inference for non-no-show bookings
  const sorted = [...meetingHistory].sort(
    (a, b) => a.scheduledAt - b.scheduledAt,
  );
  const currentIdx = sorted.findIndex((m) => m._id === meeting._id);

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
    meeting,
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
