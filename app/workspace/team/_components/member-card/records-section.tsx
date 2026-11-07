"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useMutation } from "convex/react";
import { ArrowRightIcon, UserPlusIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useRole } from "@/components/auth/role-context";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { firstName, plural } from "../team-ui";
import { CardSection, RecordRow, RuledBlock, saveWithUndo } from "./card-ui";
import {
  LOGIN_ROLE_LABEL,
  splitName,
  teamName,
  type Directory,
  type DirectoryMember,
  type ReviewItem,
} from "./member-model";

const InviteUserDialog = dynamic(() => import("../invite-user-dialog").then((module) => ({ default: module.InviteUserDialog })));

const LINK =
  "inline-flex min-h-6 items-center gap-1 rounded-sm text-[13px] font-medium underline decoration-foreground/40 underline-offset-2 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring";

/** "What joins Ana's activity into one person": the login and each role record. */
export function RecordsSection({
  member,
  directory,
  review,
}: {
  member: DirectoryMember;
  directory: Directory;
  review: readonly ReviewItem[] | undefined;
}) {
  const first = firstName(member.name);
  return (
    <CardSection title="Records" meta={`What joins ${first}’s activity into one person`}>
      <RuledBlock>
        <LoginRow member={member} />
        <SlackRows member={member} directory={directory} review={review} />
        <LeadGenRows member={member} teams={directory.teams} />
        <DmCloserRows member={member} teams={directory.teams} />
      </RuledBlock>
    </CardSection>
  );
}

function LoginRow({ member }: { member: DirectoryMember }) {
  const { hasPermission } = useRole();
  const login = member.login;
  const first = firstName(member.name);
  const tip = "The account they sign in to Magnus with. Phone closers, admins and lead generators need one; DM closers and Slack qualifiers get credit without it.";
  if (login) {
    const state = login.removed ? "deactivated" : login.invitationPending ? "invited, hasn’t signed up" : "signed up";
    return (
      <RecordRow
        label="CRM login"
        tip={tip}
        primary={<span className="font-medium">{login.email}</span>}
        secondary={`${LOGIN_ROLE_LABEL[login.role]} · ${state}`}
      />
    );
  }
  const email = member.leadGen.find((row) => row.email.includes("@"))?.email ?? "";
  const name = splitName(member.name);
  return (
    <RecordRow
      label="CRM login"
      tip={tip}
      primary="No CRM login"
      secondary="Not needed for DM links or Slack credit"
      actions={
        hasPermission("team:invite") ? (
          <InviteUserDialog
            trigger={
              <Button variant="outline" size="sm">
                <UserPlusIcon aria-hidden="true" />
                Invite to CRM
              </Button>
            }
            defaultValues={{ email, firstName: name.firstName, lastName: name.lastName }}
            note={`The new login starts as its own team member. Join it to ${first} on Review so their credit stays on one person.`}
          />
        ) : null
      }
    />
  );
}

function SlackRows({
  member,
  directory,
  review,
}: {
  member: DirectoryMember;
  directory: Directory;
  review: readonly ReviewItem[] | undefined;
}) {
  const linkSlackUser = useMutation(api.team.members.linkSlackUser);
  const unlinkSlackUser = useMutation(api.team.members.unlinkSlackUser);
  const restore = useMutation(api.team.members.restoreSlackUserLink);
  const [busy, setBusy] = useState(false);
  const first = firstName(member.name);
  const tip = "The Slack account whose qualified-lead posts count for them. Linking moves its credit to this member.";

  // Slack users linked to nobody: alone on a member of their own.
  const candidates = new Map<string, { slackUserId: string; label: string }>();
  for (const other of directory.members) {
    if (other.key === member.key || other.login || other.leadGen.length || other.dmClosers.length) continue;
    for (const slack of other.slack) {
      if (slack.isDeleted) continue;
      candidates.set(slack.slackUserId, { slackUserId: slack.slackUserId, label: slackLabel(slack) });
    }
  }
  for (const item of review ?? []) {
    if (item.kind !== "slack_unlinked" || candidates.has(item.slackUserId)) continue;
    const owner = directory.members.find((row) => row.slack.some((slack) => slack.slackUserId === item.slackUserId));
    const slack = owner?.slack.find((row) => row.slackUserId === item.slackUserId);
    if (!slack || slack.isDeleted || owner?.key === member.key) continue;
    candidates.set(item.slackUserId, { slackUserId: item.slackUserId, label: slackLabel(slack) });
  }
  const options = [...candidates.values()].sort((a, b) => a.label.localeCompare(b.label));
  // A Slack-only member's one Slack user is the member; unlinking it changes nothing.
  const canUnlink = Boolean(member.login || member.leadGen.length || member.dmClosers.length || member.slack.length > 1);

  async function link(slackUserId: string) {
    if (!member.teamMemberId) return;
    const teamMemberId = member.teamMemberId;
    const label = candidates.get(slackUserId)?.label ?? "The Slack user";
    setBusy(true);
    await saveWithUndo({
      run: () => linkSlackUser({ slackUserId, teamMemberId }),
      undo: (result) => restore({ previous: result.previous }),
      message: `${label} is now ${first}’s Slack user`,
      description: `Their qualified leads move to ${first} in the background; reports catch up shortly.`,
      flow: "team_member_card_slack_link",
      event: "team_member_slack_linked",
    });
    setBusy(false);
  }

  async function unlink(slack: DirectoryMember["slack"][number]) {
    setBusy(true);
    await saveWithUndo({
      run: () => unlinkSlackUser({ slackUserId: slack.slackUserId }),
      undo: (result) => restore({ previous: result.previous }),
      message: `${slackLabel(slack)} is no longer ${first}’s`,
      description: `Its qualified leads move off ${first} in the background; reports catch up shortly.`,
      flow: "team_member_card_slack_unlink",
      event: "team_member_slack_unlinked",
    });
    setBusy(false);
  }

  const picker =
    options.length > 0 ? (
      <NativeSelect
        aria-label={`Link a Slack user to ${first}`}
        className="w-full min-w-48 @lg/card:w-56 [&_select]:bg-card"
        value=""
        disabled={busy || !member.teamMemberId}
        onChange={(event) => {
          if (event.target.value) void link(event.target.value);
        }}
      >
        <NativeSelectOption value="">Link a Slack user…</NativeSelectOption>
        {options.map((option) => (
          <NativeSelectOption key={option.slackUserId} value={option.slackUserId}>
            {option.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    ) : null;

  if (member.slack.length === 0) {
    return (
      <RecordRow
        label="Slack user"
        tip={tip}
        primary={<span className="text-muted-foreground">Not linked</span>}
        secondary={
          options.length
            ? `${plural(options.length, "Slack user")} ${options.length === 1 ? "isn’t" : "aren’t"} linked to anyone`
            : "Every Slack user is linked to someone"
        }
        actions={picker}
      />
    );
  }
  return (
    <>
      {member.slack.map((slack) => (
        <RecordRow
          key={slack.slackUserId}
          label="Slack user"
          tip={tip}
          primary={<span className="font-medium">{slackLabel(slack)}</span>}
          secondary={slack.isDeleted ? "Deleted in Slack · their past credit stays" : "Posts qualified leads"}
          actions={
            canUnlink ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void unlink(slack)}>
                Unlink
              </Button>
            ) : null
          }
        />
      ))}
    </>
  );
}

function slackLabel(slack: DirectoryMember["slack"][number]) {
  return slack.handle ? `@${slack.handle} · ${slack.name}` : slack.name;
}

function LeadGenRows({ member, teams }: { member: DirectoryMember; teams: Directory["teams"] }) {
  const updateWorker = useMutation(api.leadGen.workers.updateWorkerProfile);
  const restoreTeams = useMutation(api.team.review.restoreTeams);
  // The latest saved values: a save or Undo changes one field and keeps the
  // other as it is now, not as it was when the toast appeared.
  const latest = useRef(member.leadGen);
  useEffect(() => {
    latest.current = member.leadGen;
  });
  const first = firstName(member.name);
  const tip = "Their lead gen record: captures they log count for its team on Lead Gen. Inactive lead generators keep their history.";
  if (member.leadGen.length === 0) {
    return (
      <RecordRow
        label="Lead gen"
        tip={tip}
        primary={<span className="text-muted-foreground">Not a lead generator</span>}
        secondary="Lead gen records come from a CRM login with the Lead generator role"
      />
    );
  }

  function save(
    worker: DirectoryMember["leadGen"][number],
    next: { teamId: Id<"attributionTeams"> | null; isActive: boolean },
    message: string,
  ) {
    const field = next.teamId !== worker.teamId ? "team" : "active";
    const now = () => latest.current.find((row) => row.workerId === worker.workerId) ?? worker;
    return saveWithUndo({
      run: () =>
        updateWorker(
          field === "team"
            ? { workerId: worker.workerId, teamId: next.teamId ?? undefined, isActive: now().isActive }
            : { workerId: worker.workerId, teamId: now().teamId ?? undefined, isActive: next.isActive },
        ),
      // Team Undo goes through restoreTeams, which can put back an archived team.
      undo: () =>
        field === "team"
          ? restoreTeams({ previous: { leadGen: [{ workerId: worker.workerId, teamId: worker.teamId }], dmClosers: [] } })
          : updateWorker({ workerId: worker.workerId, teamId: now().teamId ?? undefined, isActive: worker.isActive }),
      message,
      flow: "team_member_card_lead_gen",
      event: "team_member_lead_gen_updated",
    });
  }

  return (
    <>
      {member.leadGen.map((worker) => {
        const options = teams.filter((team) => team.isActive || team.teamId === worker.teamId);
        return (
          <RecordRow
            key={worker.workerId}
            label="Lead gen"
            tip={tip}
            primary={<span className={cn("font-medium", !worker.isActive && "text-muted-foreground")}>{worker.name}</span>}
            secondary={`${worker.email} · ${worker.isActive ? "logs captures" : "inactive"}`}
            actions={
              <>
                <NativeSelect
                  aria-label={`${first}’s lead gen team`}
                  title="Lead gen team: their captures count for this team"
                  className="w-full min-w-40 @lg/card:w-44 [&_select]:bg-card"
                  value={worker.teamId ?? ""}
                  onChange={(event) => {
                    const teamId = (event.target.value || null) as Id<"attributionTeams"> | null;
                    void save(
                      worker,
                      { teamId, isActive: worker.isActive },
                      teamId ? `${first}’s captures count for ${teamName(teams, teamId)}` : `${first} has no lead gen team`,
                    );
                  }}
                >
                  <NativeSelectOption value="">No team</NativeSelectOption>
                  {options.map((team) => (
                    <NativeSelectOption key={team.teamId} value={team.teamId}>
                      {team.name}
                      {team.isActive ? "" : " (archived)"}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <label className="flex h-8 items-center gap-2 text-[13px] text-muted-foreground">
                  <Switch
                    checked={worker.isActive}
                    aria-label={`${first} is an active lead generator`}
                    className="data-checked:bg-foreground"
                    onCheckedChange={(checked) =>
                      void save(
                        worker,
                        { teamId: worker.teamId, isActive: checked },
                        checked ? `${first} logs captures again` : `${first} is an inactive lead generator`,
                      )
                    }
                  />
                  Active
                </label>
              </>
            }
          />
        );
      })}
    </>
  );
}

function DmCloserRows({ member, teams }: { member: DirectoryMember; teams: Directory["teams"] }) {
  const tip = "An external setter's booking-link identity: their links carry this utm_medium, and bookings that come back with it credit them.";
  if (member.dmClosers.length === 0) {
    return (
      <RecordRow
        label="DM closer"
        tip={tip}
        primary={<span className="text-muted-foreground">Not a DM closer</span>}
        secondary="DM closers are added on a team’s page"
        actions={
          <Link href="/workspace/team/teams" className={LINK}>
            Teams
            <ArrowRightIcon aria-hidden="true" className="size-3.5" />
          </Link>
        }
      />
    );
  }
  return (
    <>
      {member.dmClosers.map((closer) => (
        <RecordRow
          key={closer.dmCloserId}
          label="DM closer"
          tip={tip}
          primary={
            <span className="font-mono text-[13px] tracking-[-0.01em]" translate="no">
              utm_medium={closer.utmMedium}
            </span>
          }
          secondary={`${teamName(teams, closer.teamId)} · ${closer.isActive ? "in the portal" : "hidden from the portal"}`}
          actions={
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const section = document.getElementById(`dm-closer-${closer.dmCloserId}`);
                section?.scrollIntoView({ block: "start", behavior: "smooth" });
                section?.querySelector<HTMLElement>("input, select")?.focus({ preventScroll: true });
              }}
            >
              Edit
            </Button>
          }
        />
      ))}
    </>
  );
}
