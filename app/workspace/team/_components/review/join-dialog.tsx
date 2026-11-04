"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import posthog from "posthog-js";
import { api } from "@/convex/_generated/api";
import type { DirectoryMember } from "@/convex/team/contracts";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";
import { LABEL, firstName } from "../team-ui";
import type { MemberId, TeamId } from "./review-data";

/**
 * Join two team members into one, after the admin confirms: what moves, that
 * the credit follows in the background, and that it can't be undone. The
 * only Review action with no Undo.
 */
export function JoinDialog({
  from,
  into,
  teamName,
  onOpenChange,
  onJoined,
}: {
  from: DirectoryMember & { teamMemberId: MemberId };
  into: DirectoryMember & { teamMemberId: MemberId };
  teamName: (id: TeamId | null) => string;
  onOpenChange: (open: boolean) => void;
  /** `done: false`: the join goes on in the background. */
  onJoined: (done: boolean) => void;
}) {
  const join = useMutation(api.team.review.joinTeamMembers);
  const [joining, setJoining] = useState(false);
  const intoFirst = firstName(into.name);
  const moving = movingRecords(from, teamName);

  async function confirm() {
    setJoining(true);
    try {
      const { done } = await join({ fromTeamMemberId: from.teamMemberId, intoTeamMemberId: into.teamMemberId });
      posthog.capture("team_members_joined", { done });
      toast.success(
        done
          ? `Joined: one ${into.name}. The credit moves in the background.`
          : `Joining into ${into.name}. It finishes in the background.`,
      );
      onJoined(done);
      onOpenChange(false);
    } catch (error) {
      reportClientError(error, { flow: "team_members_join" });
      toast.error(getErrorMessage(error, "Couldn’t join these members."));
    } finally {
      setJoining(false);
    }
  }

  return (
    <AlertDialog open onOpenChange={(open) => !joining && onOpenChange(open)}>
      <AlertDialogContent className="data-[size=default]:sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-[17px] font-semibold">Join into {into.name}?</AlertDialogTitle>
          <AlertDialogDescription className="text-[13.5px] leading-relaxed text-pretty">
            {from.name === into.name
              ? `The two ${into.name} records become one team member.`
              : `${from.name} and ${into.name} become one team member, ${into.name}.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-3.5 text-[13.5px] leading-relaxed">
          <div>
            <h3 className={LABEL}>What moves to {intoFirst}</h3>
            {moving.length ? (
              <ul className="mt-1.5 flex flex-col divide-y divide-border rounded-lg border border-border">
                {moving.map((row) => (
                  <li key={row.key} className="flex min-h-9 flex-wrap items-baseline gap-x-2 px-3 py-1.5">
                    <span className="font-medium">{row.what}</span>
                    <span className="min-w-0 text-[12.5px] break-words text-muted-foreground">{row.detail}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-muted-foreground">Nothing: this record is empty, so joining only removes it.</p>
            )}
          </div>
          <div>
            <h3 className={LABEL}>Credit</h3>
            <p className="mt-1 text-muted-foreground">
              Captures, qualified leads and bookings these records earned count for {intoFirst}. The credit moves in the
              background, so reports can take a minute to catch up.
            </p>
          </div>
          <p className="rounded-lg bg-warning-surface px-3 py-2 font-medium text-warning-ink">
            This can’t be undone. There is no Undo for a join.
          </p>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={joining}>Cancel</AlertDialogCancel>
          <Button disabled={joining} onClick={() => void confirm()}>
            {joining ? "Joining…" : `Join into ${into.name}`}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const LOGIN_ROLE = {
  tenant_master: "owner",
  tenant_admin: "admin",
  closer: "phone closer",
  lead_generator: "lead generator",
} as const;

function movingRecords(member: DirectoryMember, teamName: (id: TeamId | null) => string) {
  const rows: Array<{ key: string; what: string; detail: string }> = [];
  if (member.login) {
    rows.push({
      key: member.login.userId,
      what: member.login.removed ? "Removed CRM login" : "CRM login",
      detail: `${member.login.email} · ${LOGIN_ROLE[member.login.role]}`,
    });
  }
  for (const row of member.leadGen) {
    rows.push({ key: row.workerId, what: "Lead gen worker", detail: [row.email, teamName(row.teamId)].join(" · ") });
  }
  for (const row of member.slack) {
    rows.push({
      key: row.slackUserId,
      what: "Slack user",
      detail: [row.handle ? `@${row.handle}` : row.name, row.isDeleted ? "deleted in Slack" : ""].filter(Boolean).join(" · "),
    });
  }
  for (const row of member.dmClosers) {
    rows.push({ key: row.dmCloserId, what: "DM closer", detail: `${row.name} · ${teamName(row.teamId)}` });
  }
  return rows;
}
