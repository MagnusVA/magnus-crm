"use client";

import Link from "next/link";
import { ScheduleBlock, type ScheduleOwner, type WeekHours } from "../schedule-editor";
import { firstName, HelpTip, LABEL } from "../team-ui";
import type { ScheduleRole } from "./member-card-host";
import { CardSection } from "./card-ui";
import { teamName, WHERE_HOURS_COUNT, type DirectoryMember, type DirectoryTeam } from "./member-model";

type WeekEntry = {
  role: ScheduleRole;
  recordId: string;
  owner: ScheduleOwner;
  title: string;
  week: WeekHours | null;
  changedOn: string | null;
};

const ROLE_TITLE: Record<ScheduleRole, string> = {
  lead_gen: "Lead gen week",
  slack: "Slack week",
  dm_closer: "DM closer week",
};

/** One week per role record, in role order, each labelled by its record when a role has several. */
function weeksOf(member: DirectoryMember, teams: readonly DirectoryTeam[]): WeekEntry[] {
  const several = (count: number, title: string, detail: string) => (count > 1 ? `${title} · ${detail}` : title);
  return [
    ...member.leadGen.map((row) => ({
      role: "lead_gen" as const,
      recordId: row.workerId,
      owner: { kind: "lead_gen", workerId: row.workerId } as const,
      title: several(member.leadGen.length, ROLE_TITLE.lead_gen, `${row.email}, ${teamName(teams, row.teamId)}`),
      week: row.week,
      changedOn: row.weekChangedOn,
    })),
    ...member.slack.map((row) => ({
      role: "slack" as const,
      recordId: row.slackUserId,
      // The Slack schedule mutation takes Slack's own user id (a string), as the directory gives it.
      owner: { kind: "slack", slackUserId: row.slackUserId } as const,
      title: several(member.slack.length, ROLE_TITLE.slack, row.handle ? `@${row.handle}` : row.name),
      week: row.week,
      changedOn: row.weekChangedOn,
    })),
    ...member.dmClosers.map((row) => ({
      role: "dm_closer" as const,
      recordId: row.dmCloserId,
      owner: { kind: "dm_closer", dmCloserId: row.dmCloserId } as const,
      title: several(member.dmClosers.length, ROLE_TITLE.dm_closer, `${row.utmMedium}, ${teamName(teams, row.teamId)}`),
      week: row.week,
      changedOn: row.weekChangedOn,
    })),
  ];
}

/**
 * Schedules: one week per role record (the owner's call: no one week per
 * person). `&schedule=<role>` opens that role's week, or the record a report
 * linked to; under each, the report that divides by it.
 */
export function SchedulesSection({
  member,
  teams,
  schedule,
  scheduleRecord,
  onScheduleChange,
}: {
  member: DirectoryMember;
  teams: readonly DirectoryTeam[];
  schedule: ScheduleRole | null;
  scheduleRecord: string | null;
  onScheduleChange: (role: ScheduleRole | null, recordId?: string) => void;
}) {
  const weeks = weeksOf(member, teams);
  const first = firstName(member.name);
  if (weeks.length === 0) {
    return (
      <CardSection title="Schedules" meta="No weeks to set">
        <p className="text-[13px] text-muted-foreground">
          Weeks belong to lead gen, Slack and DM closer records, and {first} has none of those.
        </p>
      </CardSection>
    );
  }

  const ofRole = schedule ? weeks.filter((entry) => entry.role === schedule) : [];
  const openId = (ofRole.find((entry) => entry.recordId === scheduleRecord) ?? ofRole[0])?.recordId ?? null;
  const reports = [...new Set(weeks.map((entry) => WHERE_HOURS_COUNT[entry.role].report))];

  return (
    <CardSection
      title="Schedules"
      meta={`One week per role · used by ${reports.join(", ")}`}
    >
      <div className="flex flex-col gap-3">
        {weeks.map((entry) => (
          <div key={entry.recordId} className="flex flex-col gap-1.5">
            <ScheduleBlock
              owner={entry.owner}
              firstName={first}
              week={entry.week}
              changedOn={entry.changedOn}
              title={entry.title}
              open={entry.recordId === openId}
              onOpenChange={(open) => onScheduleChange(open ? entry.role : null, open ? entry.recordId : undefined)}
            />
            <WhereHoursCount role={entry.role} first={first} />
          </div>
        ))}
      </div>
    </CardSection>
  );
}

function WhereHoursCount({ role, first }: { role: ScheduleRole; first: string }) {
  const where = WHERE_HOURS_COUNT[role];
  const link =
    "rounded-sm font-medium text-foreground underline decoration-foreground/35 underline-offset-2 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <p className="flex flex-wrap items-baseline gap-x-2 px-1 text-[12.5px] text-muted-foreground">
      <span className={LABEL}>
        <HelpTip tip={`The reports that read ${first}’s hours for this role. A change applies from today on; earlier days keep their hours, so past figures don’t move.`}>
          Where these hours count
        </HelpTip>
      </span>
      <span>
        <Link href={where.href} className={link}>
          {where.report}
        </Link>{" "}
        {where.divides}
        {where.goal ? (
          <>
            , and the{" "}
            <Link href={where.goal.href} className={link}>
              {where.goal.label}
            </Link>{" "}
            {where.goal.line}
          </>
        ) : null}
        .
      </span>
    </p>
  );
}
