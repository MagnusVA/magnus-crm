"use client";

import { useCallback } from "react";
import { format } from "date-fns";
import { toast } from "sonner";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  CalendarCheckIcon,
  CalendarDaysIcon,
  ClockIcon,
  CopyIcon,
  DollarSignIcon,
  GlobeIcon,
  LinkIcon,
  MailIcon,
  MegaphoneIcon,
  PhoneIcon,
  TagIcon,
  TrendingUpIcon,
  UserIcon,
  VideoIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { meetingStatusConfig, type MeetingStatus } from "@/lib/status-config";
import type { Doc } from "@/convex/_generated/dataModel";
import { MemberIdentity } from "@/app/workspace/_components/member-identity";
import type { MemberAvatarIdentity } from "@/app/workspace/_components/member-avatar";

const MEETING_BADGE_CLASS: Record<string, string> = {
  scheduled:
    "bg-blue-500/10 text-blue-700 border-blue-200 dark:text-blue-400 dark:border-blue-900",
  completed:
    "bg-emerald-500/10 text-emerald-700 border-emerald-200 dark:text-emerald-400 dark:border-emerald-900",
  canceled: "bg-muted text-muted-foreground border-border",
  no_show:
    "bg-orange-500/10 text-orange-700 border-orange-200 dark:text-orange-400 dark:border-orange-900",
};

type MeetingOverviewCardProps = {
  lead: Doc<"leads">;
  meeting: Doc<"meetings">;
  opportunity: Doc<"opportunities">;
  eventTypeName: string | null;
  assignedCloser: { fullName?: string; email: string } | null;
  assignedCloserIdentity?: MemberAvatarIdentity | null;
  attributionTeam?: Doc<"attributionTeams"> | null;
  dmCloser?: Doc<"dmClosers"> | null;
  dmCloserIdentity?: MemberAvatarIdentity | null;
};

/**
 * Combined lead, meeting, and attribution overview.
 *
 * Packs identity, contact, schedule, join link, and attribution into one card so
 * closers see "who + when + where + deal context" without scanning multiple panels.
 */
export function MeetingOverviewCard({
  lead,
  meeting,
  opportunity,
  eventTypeName,
  assignedCloser,
  assignedCloserIdentity,
  attributionTeam,
  dmCloser,
  dmCloserIdentity,
}: MeetingOverviewCardProps) {
  const statusKey = meeting.status as MeetingStatus;
  const statusCfg = meetingStatusConfig[statusKey];
  const meetingJoinUrl = meeting.meetingJoinUrl ?? meeting.zoomJoinUrl;

  const utm = meeting.utmParams ?? opportunity.utmParams;
  const bookedProgramName =
    meeting.bookingProgramName ??
    opportunity.firstBookingProgramName ??
    "Unmapped";
  const soldProgramName =
    meeting.soldProgramName ?? opportunity.soldProgramName ?? "No payment yet";
  const dmTeamName = attributionTeam?.displayName ?? utm?.utm_source ?? "None";
  const dmCloserName = dmCloser?.displayName ?? utm?.utm_medium ?? "None";

  const initial = (lead.fullName ?? lead.email ?? "?").charAt(0).toUpperCase();

  return (
    <Card>
      <CardContent className="flex flex-col gap-3.5">
        {/* ── Identity ─────────────────────────────────────────────── */}
        <div className="flex items-start gap-3">
          <div
            aria-hidden
            className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-base font-semibold text-primary"
          >
            {initial}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold" title={lead.fullName ?? undefined}>
              {lead.fullName ?? "Unknown lead"}
            </p>
            <Badge
              variant="secondary"
              className={cn("mt-1 text-[10px]", MEETING_BADGE_CLASS[meeting.status])}
            >
              {statusCfg?.label ?? meeting.status}
            </Badge>
          </div>
        </div>

        {/* ── Contact chips ────────────────────────────────────────── */}
        <div className="flex flex-col gap-1.5">
          {lead.email && (
            <ContactRow
              icon={<MailIcon />}
              href={`mailto:${lead.email}`}
              value={lead.email}
              copyLabel="email"
            />
          )}
          {lead.phone && (
            <ContactRow
              icon={<PhoneIcon />}
              href={`tel:${lead.phone}`}
              value={lead.phone}
              copyLabel="phone"
            />
          )}
        </div>

        <Separator />

        {/* ── Meeting facts ────────────────────────────────────────── */}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Fact icon={<CalendarDaysIcon />} label="Date & Time">
            <p className="text-sm font-medium leading-tight">
              {format(meeting.scheduledAt, "MMM d, yyyy")}
            </p>
            <p className="text-xs text-muted-foreground">
              {format(meeting.scheduledAt, "h:mm a")}
            </p>
          </Fact>

          <Fact icon={<ClockIcon />} label="Duration">
            <p className="text-sm font-medium">{meeting.durationMinutes} min</p>
          </Fact>

          {eventTypeName && (
            <Fact icon={<TagIcon />} label="Event Type">
              <p className="truncate text-sm font-medium" title={eventTypeName}>
                {eventTypeName}
              </p>
            </Fact>
          )}

          {assignedCloser && (
            <Fact icon={<UserIcon />} label="Closer">
              {assignedCloserIdentity ? (
                <MemberIdentity identity={assignedCloserIdentity} />
              ) : (
                <p className="truncate text-sm font-medium">
                  {assignedCloser.fullName ?? assignedCloser.email}
                </p>
              )}
            </Fact>
          )}
        </dl>

        {/* ── Meeting link ─────────────────────────────────────────── */}
        {meetingJoinUrl ? (
          <div className="flex items-center gap-1.5">
            <Button asChild size="sm" className="flex-1">
              <a href={meetingJoinUrl} target="_blank" rel="noopener noreferrer">
                <VideoIcon data-icon="inline-start" />
                Join Meeting
              </a>
            </Button>
            <CopyButton url={meetingJoinUrl} />
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-lg bg-amber-500/10 px-2.5 py-2">
            <LinkIcon className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <p className="text-xs text-amber-700 dark:text-amber-400">
              No meeting link available
            </p>
          </div>
        )}

        <Separator />

        {/* ── Attribution ──────────────────────────────────────────── */}
        <div>
          <p className="mb-2.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <TrendingUpIcon className="size-3.5" aria-hidden />
            Attribution
          </p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
            <AttrFact
              icon={<CalendarCheckIcon />}
              label="Booked Program"
              value={bookedProgramName}
            />
            <AttrFact
              icon={<DollarSignIcon />}
              label="Sold Program"
              value={soldProgramName}
            />
            <AttrFact icon={<GlobeIcon />} label="DM Team" value={dmTeamName} />
            <AttrFact
              icon={<MegaphoneIcon />}
              label="DM Closer"
              value={dmCloserName}
              identity={dmCloserIdentity}
            />
          </dl>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Internal ────────────────────────────────────────────────────────────────

function ContactRow({
  icon,
  href,
  value,
  copyLabel,
}: {
  icon: React.ReactNode;
  href: string;
  value: string;
  copyLabel: string;
}) {
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(value);
    toast.success(`Copied ${copyLabel}`);
  }, [value, copyLabel]);

  return (
    <div className="group/contact flex items-center gap-2 rounded-md px-1 py-0.5 -mx-1 transition-colors hover:bg-accent/50">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground [&>svg]:size-3.5">
        {icon}
      </span>
      <a
        href={href}
        className="min-w-0 flex-1 truncate text-sm text-primary hover:underline"
        title={value}
      >
        {value}
      </a>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleCopy}
            aria-label={`Copy ${copyLabel}`}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/contact:opacity-100"
          >
            <CopyIcon className="size-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="left">Copy {copyLabel}</TooltipContent>
      </Tooltip>
    </div>
  );
}

function CopyButton({ url }: { url: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className="size-8"
          onClick={() => {
            navigator.clipboard.writeText(url);
            toast.success("Meeting link copied");
          }}
          aria-label="Copy meeting link"
        >
          <CopyIcon className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">Copy meeting link</TooltipContent>
    </Tooltip>
  );
}

function Fact({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        <span className="[&>svg]:size-3">{icon}</span>
        {label}
      </dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function AttrFact({
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
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        <span className="[&>svg]:size-3">{icon}</span>
        {label}
      </dt>
      <dd className="min-w-0 text-sm font-medium" title={value}>
        {identity ? <MemberIdentity identity={identity} /> : value}
      </dd>
    </div>
  );
}
