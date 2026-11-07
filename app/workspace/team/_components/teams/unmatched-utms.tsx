"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import posthog from "@/lib/posthog-browser";
import { CheckIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";
import { cn } from "@/lib/utils";
import { CardHead, CARD, Code, daysAgo, firstName, plural } from "../team-ui";
import {
  readUnmatched,
  type Message,
  type UnmatchedGroup,
  type UtmCloser,
  type UtmFix,
  type UtmTeam,
} from "./utm-suggestions";

type Closer = UtmCloser & { userId?: Id<"users"> };

/** Opens the create dialogs from a fix ("New DM team", "Add as DM closer"). */
export type CreateRequest =
  | { kind: "team"; utmSource: string; displayName: string }
  | { kind: "closer"; utmMedium: string; displayName: string; teamId?: Id<"attributionTeams"> };

/** "dm_team_brian" -> "Dm Team Brian": a starting name for a new team or closer. */
function nameFrom(value: string) {
  return value
    .trim()
    .replace(/[_.\-+]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

function MessageText({ message }: { message: Message }) {
  return (
    <>
      {message.map((part, index) =>
        typeof part === "string" ? (
          <span key={index}>{part}</span>
        ) : (
          <Code key={index} className="mx-0.5">
            {part.code}
          </Code>
        ),
      )}
    </>
  );
}

function fixLabel(fix: UtmFix) {
  switch (fix.kind) {
    case "enable_team":
      return `Enable ${fix.team.displayName}`;
    case "enable_closer":
      return `Enable ${fix.closer.displayName}`;
    case "set_team_source":
      return `Change ${fix.team.displayName}’s UTM to ${fix.to}`;
    case "set_closer_medium":
      return `Change ${firstName(fix.closer.displayName)}’s UTM to ${fix.to}`;
    case "open_team":
      return `Open ${fix.team.displayName}`;
    case "open_closer":
      return `See ${fix.closer.displayName}`;
    case "new_team":
      return "New team with it";
    case "new_closer":
      return fix.team ? `Add as DM closer on ${fix.team.displayName}` : "Add as a DM closer";
  }
}

export function UnmatchedUtms({
  groups,
  capped,
  teams,
  closers,
  onCreate,
}: {
  groups: readonly UnmatchedGroup[];
  capped: boolean;
  teams: readonly UtmTeam[];
  closers: readonly Closer[];
  onCreate: (request: CreateRequest) => void;
}) {
  const readings = useMemo(
    () =>
      groups
        .map((group) => ({ group, reading: readUnmatched(group, teams, closers) }))
        // Fixed values sink below the ones still to look at.
        .sort((a, b) => Number(a.reading.nowMatches !== null) - Number(b.reading.nowMatches !== null)),
    [groups, teams, closers],
  );

  return (
    <section id="unmatched" className={cn(CARD, "scroll-mt-4")} aria-labelledby="unmatched-title">
      <CardHead
        title={<span id="unmatched-title">Unmatched UTM values</span>}
        meta={`Seen on bookings in the last 30 days, matching no team or DM closer${capped ? " (the most recent 4,000 bookings)" : ""}`}
      />
      {readings.length === 0 ? (
        <p className="flex items-center gap-2 px-4 py-3 text-[14px] text-stage-follow-up-ink">
          <CheckIcon className="size-3.5" aria-hidden="true" />
          Every UTM value on recent bookings matches a team or DM closer.
        </p>
      ) : (
        <ul>
          {readings.map(({ group, reading }) => (
            <UnmatchedRow
              key={`${group.utmSource ?? ""}\u0000${group.utmMedium ?? ""}`}
              group={group}
              reading={reading}
              closers={closers}
              onCreate={onCreate}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function UnmatchedRow({
  group,
  reading,
  closers,
  onCreate,
}: {
  group: UnmatchedGroup;
  reading: ReturnType<typeof readUnmatched>;
  closers: readonly Closer[];
  onCreate: (request: CreateRequest) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const setTeamActive = useMutation(api.attribution.teams.setTeamActive);
  const updateTeam = useMutation(api.attribution.teams.updateTeam);
  const setDmCloserActive = useMutation(api.attribution.dmClosers.setDmCloserActive);
  const updateDmCloser = useMutation(api.attribution.dmClosers.updateDmCloser);
  const bookings = `${plural(group.bookings, "booking")} · last ${daysAgo(group.lastBookedAt)}`;
  const fixed = reading.nowMatches;

  // Every fix toasts with an Undo that puts the old value back.
  async function apply(fix: UtmFix) {
    const undoable = async (
      run: () => Promise<unknown>,
      message: string,
      undo: () => Promise<unknown>,
    ) => {
      await run();
      posthog.capture("booking_unmatched_utm_fixed", { fix: fix.kind });
      toast.success(message, {
        action: {
          label: "Undo",
          onClick: () => {
            undo().catch((error: unknown) => {
              reportClientError(error, { flow: "booking_unmatched_utm_undo" });
              toast.error(getErrorMessage(error, "Couldn’t undo that change."));
            });
          },
        },
      });
    };

    switch (fix.kind) {
      case "enable_team": {
        const teamId = fix.team._id as Id<"attributionTeams">;
        return undoable(
          () => setTeamActive({ teamId, isActive: true }),
          `${fix.team.displayName} enabled. New bookings with ${fix.team.utmSource} count for it.`,
          () => setTeamActive({ teamId, isActive: false }),
        );
      }
      case "enable_closer": {
        const dmCloserId = fix.closer._id as Id<"dmClosers">;
        return undoable(
          () => setDmCloserActive({ dmCloserId, isActive: true }),
          `${fix.closer.displayName} enabled.`,
          () => setDmCloserActive({ dmCloserId, isActive: false }),
        );
      }
      case "set_team_source": {
        const teamId = fix.team._id as Id<"attributionTeams">;
        const before = fix.team.utmSource;
        return undoable(
          () => updateTeam({ teamId, displayName: fix.team.displayName, utmSource: fix.to }),
          `${fix.team.displayName}’s utm_source is now ${fix.to}.`,
          () => updateTeam({ teamId, displayName: fix.team.displayName, utmSource: before }),
        );
      }
      case "set_closer_medium": {
        const closer = closers.find((row) => row._id === fix.closer._id) ?? fix.closer;
        const args = {
          dmCloserId: closer._id as Id<"dmClosers">,
          teamId: closer.teamId as Id<"attributionTeams">,
          displayName: closer.displayName,
        };
        const before = closer.utmMedium;
        return undoable(
          () => updateDmCloser({ ...args, utmMedium: fix.to }),
          `${closer.displayName}’s utm_medium is now ${fix.to}.`,
          () => updateDmCloser({ ...args, utmMedium: before }),
        );
      }
      case "new_team":
        onCreate({ kind: "team", utmSource: fix.utmSource, displayName: nameFrom(fix.utmSource) });
        return;
      case "new_closer":
        onCreate({
          kind: "closer",
          utmMedium: fix.utmMedium,
          displayName: nameFrom(fix.utmMedium),
          teamId: fix.team?._id as Id<"attributionTeams"> | undefined,
        });
        return;
      case "open_team":
      case "open_closer":
        return;
    }
  }

  async function run(fix: UtmFix, key: string) {
    setBusy(key);
    try {
      await apply(fix);
    } catch (error) {
      reportClientError(error, { flow: "booking_unmatched_utm_fix", fix: fix.kind });
      toast.error(getErrorMessage(error, "Couldn’t make that change."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className={cn("flex flex-wrap items-start gap-x-3 gap-y-2 border-t border-border px-4 py-[9px] first:border-t-0", fixed && "bg-muted/30")}>
      <span className="flex min-w-0 shrink-0 flex-col items-start gap-1 @2xl:w-[230px]">
        {group.utmSource !== null ? <Code className={cn(fixed && "text-muted-foreground")}>utm_source={group.utmSource}</Code> : null}
        {group.utmMedium !== null ? <Code className={cn(fixed && "text-muted-foreground")}>utm_medium={group.utmMedium}</Code> : null}
      </span>
      <span className="min-w-0 flex-[1_1_260px] text-[14px] leading-[1.5]">
        {fixed ? (
          <span className="flex items-start gap-1.5 text-stage-follow-up-ink">
            <CheckIcon className="mt-1 size-3.5 shrink-0" aria-hidden="true" />
            <span>
              Matches {fixed.closer ? fixed.closer.displayName : fixed.team?.displayName}
              {fixed.closer && fixed.team ? ` on ${fixed.team.displayName}` : ""} now. New bookings with these values get credit.
            </span>
          </span>
        ) : (
          reading.readings
            .filter((item) => item.message.length > 0)
            .map((item, index, shown) => (
              <span key={item.part} className="block">
                {shown.length > 1 ? <span className="sr-only">{item.part}: </span> : null}
                <MessageText message={item.message} />
              </span>
            ))
        )}
        <small className="mt-[3px] block text-[12.5px] text-muted-foreground">{bookings}</small>
      </span>
      {fixed ? null : (
        <span className="ml-auto flex shrink-0 flex-wrap justify-end gap-2">
          {reading.fixes.map((fix, index) => {
            const key = `${fix.kind}:${index}`;
            const label = fixLabel(fix);
            if (fix.kind === "open_team" || fix.kind === "open_closer") {
              const href =
                fix.kind === "open_team"
                  ? `/workspace/team/teams/${fix.team._id}`
                  : `/workspace/team/teams/${fix.closer.teamId}?closer=${fix.closer._id}`;
              return (
                <Button key={key} asChild variant="outline" size="sm">
                  <Link href={href}>{label}</Link>
                </Button>
              );
            }
            return (
              <Button key={key} variant="outline" size="sm" disabled={busy !== null} onClick={() => void run(fix, key)}>
                {busy === key ? <Spinner data-icon="inline-start" /> : null}
                {label}
              </Button>
            );
          })}
        </span>
      )}
    </li>
  );
}
