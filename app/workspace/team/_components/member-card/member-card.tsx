"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { ChevronLeftIcon, XIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { firstName, initials } from "../team-ui";
import type { MemberAlias, ScheduleRole } from "./member-card-host";
import {
  findByAlias,
  followRecords,
  FROM_REPORT,
  isFrom,
  memberStatus,
  memberTeams,
  recordKeys,
  roleWords,
  type Directory,
  type DirectoryMember,
  type TeamsDisagreeItem,
} from "./member-model";
import { TeamsDisagree } from "./teams-disagree";
import { RecordsSection } from "./records-section";
import { SchedulesSection } from "./schedules-section";
import { DmCloserSections } from "./dm-closer-section";
import { PhoneCloserSection } from "./phone-closer-section";
import { CrmAccessSection } from "./crm-access-section";

/**
 * The member card's modal. It resolves the URL to a directory member (an
 * alias, or a key a join or link replaced), keeps showing that member while
 * data reloads, and lays out the sections.
 */
export function MemberCardDialog({
  memberKey,
  alias,
  schedule,
  scheduleRecord,
  from,
  onClose,
  onResolve,
  onScheduleChange,
}: {
  memberKey: string | null;
  alias: MemberAlias | null;
  schedule: ScheduleRole | null;
  scheduleRecord: string | null;
  from: string | null;
  onClose: () => void;
  onResolve: (key: string, recordId?: string) => void;
  onScheduleChange: (role: ScheduleRole | null, recordId?: string) => void;
}) {
  const directory = useQuery(api.team.directory.getDirectory, {});
  const review = useQuery(api.team.review.listReviewItems, {});

  // The records of the member last shown: if their key goes away (a join, a
  // Slack link), the card follows those records to the member holding them.
  const [anchors, setAnchors] = useState<string[]>([]);
  const [lastShown, setLastShown] = useState<DirectoryMember | null>(null);

  const byKey = memberKey && directory ? (directory.members.find((row) => row.key === memberKey) ?? null) : null;
  const byAlias = alias && directory ? findByAlias(directory.members, alias) : null;
  const followed = memberKey && directory && !byKey ? followRecords(directory.members, anchors) : null;
  const member = byKey ?? byAlias ?? followed;

  if (member && member !== lastShown) {
    setLastShown(member);
    const keys = recordKeys(member);
    if (keys.join() !== anchors.join()) setAnchors(keys);
  }

  useEffect(() => {
    if (byAlias && alias) onResolve(byAlias.key, alias.id);
    else if (followed && followed.key !== memberKey) onResolve(followed.key);
  }, [byAlias, alias, followed, memberKey, onResolve]);

  const shown = member ?? (directory === undefined ? lastShown : null);
  const loading = directory === undefined && !shown;
  const disagree =
    shown?.teamMemberId && review
      ? (review.items.find(
          (item): item is TeamsDisagreeItem => item.kind === "teams_disagree" && item.teamMemberId === shown.teamMemberId,
        ) ?? null)
      : null;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[min(88vh,60rem)] flex-col gap-0 overflow-hidden bg-card p-0 sm:max-w-[46rem]"
        onEscapeKeyDown={(event) => {
          // Escape closes an open week editor first, then the card.
          if (schedule) {
            event.preventDefault();
            onScheduleChange(null);
          }
        }}
        onOpenAutoFocus={(event) => {
          // A week opened from the URL focuses its first day instead.
          if (schedule) event.preventDefault();
        }}
        // The host puts focus back on whatever opened the card.
        onCloseAutoFocus={(event) => event.preventDefault()}
        // A toast's Undo sits outside the card; clicking it keeps the card open.
        onInteractOutside={(event) => {
          if (event.target instanceof Element && event.target.closest("[data-sonner-toaster]")) event.preventDefault();
        }}
      >
        {/* A modal dialog turns off pointer events on <body>, toasts included; Undo must stay clickable. */}
        <style>{"[data-sonner-toaster]{pointer-events:auto}"}</style>
        {loading ? (
          <CardLoading />
        ) : !shown || !directory ? (
          <CardNotFound alias={alias} />
        ) : (
          <>
            <CardHeader member={shown} directory={directory} disagree={Boolean(disagree)} />
            {isFrom(from) ? <BackToReport from={from} /> : null}
            <div className="@container/card min-h-0 flex-1 overflow-y-auto">
              {directory.capped ? (
                <p className="border-b border-border bg-warning-surface px-5 py-2 text-[12.5px] text-warning-ink">
                  This workspace has more records than the card reads at once, so some may be missing here.
                </p>
              ) : null}
              {disagree ? <TeamsDisagree member={shown} item={disagree} teams={directory.teams} /> : null}
              <RecordsSection member={shown} directory={directory} review={review?.items} />
              <SchedulesSection
                member={shown}
                teams={directory.teams}
                schedule={schedule}
                scheduleRecord={scheduleRecord}
                onScheduleChange={onScheduleChange}
              />
              <DmCloserSections member={shown} />
              {shown.login?.role === "closer" ? <PhoneCloserSection member={shown} /> : null}
              <CrmAccessSection member={shown} />
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CardHeader({
  member,
  directory,
  disagree,
}: {
  member: DirectoryMember;
  directory: Directory;
  disagree: boolean;
}) {
  const status = memberStatus(member);
  const teams = memberTeams(member, directory.teams);
  const roles = roleWords(member);
  const summary = [
    roles.length ? roles.join(" · ") : "No role records",
    teams.length ? teams.map((team) => team.name).join(", ") : "No team",
    disagree ? "teams differ by role" : null,
  ].filter(Boolean);
  const picture = member.login?.profilePictureUrl;

  return (
    <div className="flex items-start gap-3 border-b border-border px-5 py-4">
      <Avatar className="size-9 shrink-0">
        {picture ? <AvatarImage src={picture} alt="" /> : null}
        <AvatarFallback className="bg-muted font-condensed text-[12px] font-bold tracking-[0.06em] text-muted-foreground">
          {initials(member.name)}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          <DialogTitle className="truncate text-[18px] leading-tight font-semibold">{member.name}</DialogTitle>
          <span
            className={cn(
              "font-condensed text-[13px] leading-none font-bold tracking-[0.08em] uppercase",
              status.tone === "active" && "text-stage-follow-up-ink",
              status.tone === "warning" && "text-warning-ink",
              status.tone === "muted" && "text-muted-foreground",
            )}
          >
            {status.word}
          </span>
          <span className="text-[12.5px] text-muted-foreground">{status.note}</span>
        </div>
        <DialogDescription className="mt-0.5 text-[13px] text-muted-foreground">{summary.join(" · ")}</DialogDescription>
      </div>
      <DialogClose asChild>
        <Button variant="ghost" size="icon-sm" className="-mt-0.5 -mr-1.5 shrink-0" aria-label={`Close ${firstName(member.name)}’s card`}>
          <XIcon aria-hidden="true" />
        </Button>
      </DialogClose>
    </div>
  );
}

function BackToReport({ from }: { from: keyof typeof FROM_REPORT }) {
  const report = FROM_REPORT[from];
  return (
    <div className="flex items-center gap-1.5 border-b border-border bg-muted/50 px-5 py-2 text-[13px] text-muted-foreground">
      <ChevronLeftIcon aria-hidden="true" className="size-3.5" />
      <Link
        href={report.href}
        className="rounded-sm font-medium text-foreground underline decoration-foreground/40 underline-offset-2 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        Back to {report.label}
      </Link>
      <span>· you came here from that report</span>
    </div>
  );
}

function CardLoading() {
  return (
    <div role="status" aria-label="Loading team member" className="flex flex-col">
      <DialogTitle className="sr-only">Loading team member</DialogTitle>
      <DialogDescription className="sr-only">The member card is loading.</DialogDescription>
      <div className="flex items-center gap-3 border-b border-border px-5 py-4">
        <Skeleton className="size-9 rounded-full" />
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-5 w-44" />
          <Skeleton className="h-3.5 w-64" />
        </div>
      </div>
      {[0, 1].map((section) => (
        <div key={section} className="flex flex-col gap-2 border-b border-border px-5 py-4 last:border-b-0">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ))}
    </div>
  );
}

function CardNotFound({ alias }: { alias: MemberAlias | null }) {
  const what =
    alias?.kind === "worker"
      ? "lead gen worker"
      : alias?.kind === "slackUser"
        ? "Slack user"
        : alias?.kind === "dmCloser"
          ? "DM closer"
          : "team member";
  return (
    <div className="flex items-start gap-3 px-5 py-5">
      <div className="min-w-0 flex-1">
        <DialogTitle className="text-[15px] font-semibold">Not found</DialogTitle>
        <DialogDescription className="mt-1 text-[13px] text-muted-foreground">
          No {what} matches this link. They may have been joined into someone else or removed, or the link points to
          another workspace.
        </DialogDescription>
      </div>
      <DialogClose asChild>
        <Button variant="outline" size="sm">
          Close
        </Button>
      </DialogClose>
    </div>
  );
}
