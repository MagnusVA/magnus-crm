"use client";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  CalendarCheckIcon,
  DollarSignIcon,
  TrendingUpIcon,
  GlobeIcon,
  MegaphoneIcon,
} from "lucide-react";
import type { Doc } from "@/convex/_generated/dataModel";
import { MemberIdentity } from "@/app/workspace/_components/member-identity";
import type { MemberAvatarIdentity } from "@/app/workspace/_components/member-avatar";

// ─── Types ──────────────────────────────────────────────────────────────────

type AttributionCardProps = {
  opportunity: Doc<"opportunities">;
  meeting: Doc<"meetings">;
  attributionTeam?: Doc<"attributionTeams"> | null;
  dmCloser?: Doc<"dmClosers"> | null;
  dmCloserIdentity?: MemberAvatarIdentity | null;
};

// ─── Component ──────────────────────────────────────────────────────────────

/**
 * Attribution Card — the four facts closers care about.
 *
 * Booked program, sold program, DM team, DM closer. Raw UTM source/medium are
 * only used as fallbacks for the resolved labels — the closer-facing UI never
 * surfaces the UTM "source" itself, since those Calendly params aren't useful
 * to closers.
 */
export function AttributionCard({
  opportunity,
  meeting,
  attributionTeam,
  dmCloser,
  dmCloserIdentity,
}: AttributionCardProps) {
  const utm = meeting.utmParams ?? opportunity.utmParams;
  const bookedProgramName =
    meeting.bookingProgramName ??
    opportunity.firstBookingProgramName ??
    "Unmapped";
  const soldProgramName =
    meeting.soldProgramName ?? opportunity.soldProgramName ?? "No payment yet";
  const dmTeamName = attributionTeam?.displayName ?? utm?.utm_source ?? "None";
  const dmCloserName = dmCloser?.displayName ?? utm?.utm_medium ?? "None";

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <TrendingUpIcon className="size-4" />
          Attribution
        </CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
          <UtmField
            icon={<CalendarCheckIcon />}
            label="Booked Program"
            value={bookedProgramName}
          />
          <UtmField
            icon={<DollarSignIcon />}
            label="Sold Program"
            value={soldProgramName}
          />
          <UtmField icon={<GlobeIcon />} label="DM Team" value={dmTeamName} />
          <UtmField
            icon={<MegaphoneIcon />}
            label="DM Closer"
            value={dmCloserName}
            identity={dmCloserIdentity}
          />
        </dl>
      </CardContent>
    </Card>
  );
}

// ─── Internal ────────────────────────────────────────────────────────────────

function UtmField({
  icon,
  label,
  value,
  identity,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  identity?: MemberAvatarIdentity | null;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <span className="[&>svg]:size-3">{icon}</span>
        {label}
      </dt>
      <dd className="min-w-0 text-sm font-medium" title={value}>
        {identity ? <MemberIdentity identity={identity} /> : value}
      </dd>
    </div>
  );
}
