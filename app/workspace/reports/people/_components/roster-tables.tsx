"use client";

import type { ReactNode } from "react";
import { DetailCardFooter } from "@/app/workspace/closer/meetings/_components/detail-card";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { HelpTip } from "@/app/workspace/team/_components/team-ui";
import type { Id } from "@/convex/_generated/dataModel";
import type { MemberRole } from "@/convex/reports/member";
import type { CloserRow } from "@/convex/reports/people";
import type { PeopleRoleRow } from "@/convex/reports/peopleRoles";
import { termHelp, type ReportTermKey } from "@/lib/reporting/definitions";
import { ReportCard, ReportNote, RowsSkeleton } from "../../_components/report-ui";
import {
  buildEveryone,
  closerMetrics,
  dmMetrics,
  everyonePartialNote,
  headline,
  leadGenMetrics,
  orderRoleRows,
  roleCash,
  setterMetrics,
  type EveryoneRow,
  type RoleReports,
  type UnlinkedRow,
} from "./people-data";
import { formatCount, formatMinutes, formatMoney, formatRate, plural } from "./report-format";
import { GroupHead, InactiveMark, PeopleTable, RoleChip, RowLink, ROLE_LABEL, type TableColumn } from "./report-parts";
import type { MemberProfile } from "@/convex/reports/member";

// The roster's tables, one per tab (docs/reviews/reports-overhaul.html §10).
// Every name opens the member report, keeping the range.

const head = (label: string, term?: ReportTermKey): ReactNode => (term ? <HelpTip tip={termHelp(term)}>{label}</HelpTip> : label);

type Links = { memberHref: (teamMemberId: Id<"teamMembers">) => string };

function Who({
  name,
  href,
  inactive,
  meta,
}: {
  name: string;
  href: string | null;
  inactive?: boolean;
  meta?: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <p className="font-semibold">
        <RowLink href={href}>{name}</RowLink>
        {inactive ? <InactiveMark /> : null}
      </p>
      {meta ? <p className="text-[13px] text-muted-foreground">{meta}</p> : null}
    </div>
  );
}

const money = (amount: number, currency: string) => formatMoney(amount, currency);

// ─── Phone closers ───────────────────────────────────────────────────────────

export function ClosersTable({
  rows,
  unattributed,
  currency,
  links,
  phrase,
  partial,
}: {
  rows: readonly CloserRow[];
  unattributed: number;
  currency: string;
  links: Links;
  phrase: string;
  partial: boolean;
}) {
  if (rows.length === 0) return <SectionEmpty title={`No phone closers ${phrase}.`} />;
  const columns: Array<TableColumn<CloserRow>> = [
    { key: "due", label: "Due", head: head("Due", "callsDue"), value: (row) => formatCount(row.due) },
    { key: "held", label: "Held", head: "Held", value: (row) => formatCount(row.held) },
    { key: "noShow", label: "No-show", head: "No-show", value: (row) => formatCount(row.noShow), quiet: (row) => row.noShow === 0 },
    {
      key: "notRecorded",
      label: "Not recorded",
      head: head("Not rec.", "notRecorded"),
      value: (row) => formatCount(row.notRecorded),
      quiet: (row) => row.notRecorded === 0,
      owed: (row) => row.notRecorded > 0,
    },
    {
      key: "showRate",
      label: "Show rate",
      head: head("Show rate", "showRate"),
      value: (row) => formatRate(closerMetrics(row, currency).showRate),
      sub: (row) => `${formatRate(closerMetrics(row, currency).recordedRate)} recorded`,
    },
    {
      key: "closeRate",
      label: "Close rate",
      head: head("Close rate", "closeRate"),
      value: (row) => formatRate(closerMetrics(row, currency).closeRate),
      sub: (row) => (row.cohortDeals > 0 ? `${formatCount(row.cohortWon)} of ${formatCount(row.cohortDeals)}` : "No first held calls"),
    },
    { key: "won", label: "Deals won", head: head("Won", "dealsWon"), value: (row) => formatCount(row.dealsWon), quiet: (row) => row.dealsWon === 0 },
    {
      key: "cash",
      label: "Cash",
      head: head("Cash", "cash"),
      value: (row) => money(closerMetrics(row, currency).cashMinor, currency),
      quiet: (row) => closerMetrics(row, currency).cashMinor === 0,
    },
    {
      key: "final",
      label: "Final cash",
      head: head("Final cash", "finalCash"),
      value: (row) => money(closerMetrics(row, currency).finalMinor, currency),
      quiet: (row) => closerMetrics(row, currency).finalMinor === 0,
    },
    {
      key: "toRecord",
      label: "To record",
      head: head("To record", "timeToRecord"),
      value: (row) => formatMinutes(closerMetrics(row, currency).toRecord),
    },
  ];
  const sum = (pick: (row: CloserRow) => number) => rows.reduce((total, row) => total + pick(row), 0);
  const total: CloserRow = {
    ...rows[0],
    userId: rows[0].userId,
    name: "Total",
    due: sum((row) => row.due),
    held: sum((row) => row.held),
    noShow: sum((row) => row.noShow),
    notRecorded: sum((row) => row.notRecorded),
    cohortDeals: sum((row) => row.cohortDeals),
    cohortWon: sum((row) => row.cohortWon),
    dealsWon: sum((row) => row.dealsWon),
    payments: sum((row) => row.payments),
    recordMinutes: rows.flatMap((row) => row.recordMinutes),
    cash: [
      {
        currency,
        cashMinor: sum((row) => closerMetrics(row, currency).cashMinor),
        finalMinor: sum((row) => closerMetrics(row, currency).finalMinor),
      },
    ],
  };
  return (
    <>
      {partial ? (
        <ReportNote lead="Partial.">Too many calls or payments in this range to read every one live, so counts are a lower bound.</ReportNote>
      ) : null}
      <PeopleTable
        caption="Phone closers' calls and sales"
        rows={rows}
        rowKey={(row) => row.userId}
        first={{
          head: "Phone closer",
          cell: (row) => (
            <Who
              name={row.name}
              href={row.teamMemberId ? links.memberHref(row.teamMemberId) : null}
              inactive={!row.isActive}
              meta={`${plural(row.payments, "payment")}${row.teamMemberId ? "" : " · not linked to a member"}`}
            />
          ),
        }}
        columns={columns}
        total={{ cell: <span>Total</span>, row: total }}
        wide="@5xl/people"
      />
      {unattributed > 0 ? (
        <DetailCardFooter className="font-normal">
          {money(unattributed, currency)} of the cash in this range names no closer, so it isn&apos;t in these rows.
        </DetailCardFooter>
      ) : null}
    </>
  );
}

// ─── Setters, DM closers, lead gen ───────────────────────────────────────────

function roleWho(row: PeopleRoleRow, links: Links, inactive: Set<string>, meta?: ReactNode) {
  if (row.key.startsWith("team:")) return <Who name={row.name} href={null} meta="Team booking with no DM closer named" />;
  if (!row.teamMemberId) return <Who name="Not linked to a member" href={null} meta="Records with no team member" />;
  return <Who name={row.name} href={links.memberHref(row.teamMemberId)} inactive={inactive.has(row.teamMemberId)} meta={meta} />;
}

const perHourCell = (count: number, hours: number) => (hours > 0 ? `${(count / hours).toFixed(2)}/h` : "No schedule");

export function RoleTable({
  role,
  rows,
  currency,
  links,
  inactive,
  phrase,
  truncated,
}: {
  role: Exclude<MemberRole, "closer">;
  rows: readonly PeopleRoleRow[];
  currency: string;
  links: Links;
  inactive: Set<string>;
  phrase: string;
  truncated: boolean;
}) {
  const ordered = orderRoleRows(rows);
  if (ordered.length === 0) return <SectionEmpty title={`No ${ROLE_LABEL[role].toLowerCase()}s ${phrase}.`} />;
  const cash: TableColumn<PeopleRoleRow> = {
    key: "cash",
    label: "Credited cash",
    head: head("Credited cash", "creditedCash"),
    value: (row) => money(setterMetrics(row, currency).cashMinor, currency),
    quiet: (row) => setterMetrics(row, currency).cashMinor === 0,
  };
  let columns: Array<TableColumn<PeopleRoleRow>>;
  let meta: (row: PeopleRoleRow) => ReactNode;
  if (role === "setter") {
    meta = (row) => (row.scheduledHours > 0 ? `${formatCount(row.scheduledHours)} h scheduled` : "No schedule");
    columns = [
      { key: "q", label: "Qualified", head: "Qualified", value: (row) => formatCount(row.qualifications) },
      {
        key: "perHour",
        label: "Per hour",
        head: head("Per hour", "perScheduledHour"),
        value: (row) => perHourCell(row.qualifications, row.scheduledHours),
        quiet: (row) => row.scheduledHours === 0,
      },
      { key: "deals", label: "Deals credited", head: "Deals", value: (row) => formatCount(row.dealsCredited) },
      { key: "booked", label: "Booked", head: "Booked", value: (row) => formatCount(row.booked) },
      {
        key: "bookRate",
        label: "Book rate",
        head: head("Book rate", "bookRate"),
        value: (row) => formatRate(setterMetrics(row, currency).bookRate),
      },
      { key: "held", label: "Held", head: "Held", value: (row) => formatCount(row.held) },
      { key: "won", label: "Won", head: "Won", value: (row) => formatCount(row.won), quiet: (row) => row.won === 0 },
      cash,
    ];
  } else if (role === "dm_closer") {
    meta = (row) => (row.scheduledHours > 0 ? `${formatCount(row.scheduledHours)} h scheduled` : "No schedule");
    columns = [
      { key: "team", label: "Team", head: "Team", text: true, value: (row) => row.teams.map((team) => team.name).join(", ") || "—" },
      { key: "bookings", label: "Bookings", head: head("Bookings", "bookingsMade"), value: (row) => formatCount(row.bookings) },
      {
        key: "perHour",
        label: "Per hour",
        head: head("Per hour", "perScheduledHour"),
        value: (row) => perHourCell(row.bookings, row.scheduledHours),
        quiet: (row) => row.scheduledHours === 0,
      },
      { key: "held", label: "Held", head: "Held", value: (row) => formatCount(row.held) },
      { key: "noShow", label: "No-show", head: "No-show", value: (row) => formatCount(row.noShow), quiet: (row) => row.noShow === 0 },
      {
        key: "showRate",
        label: "Show rate",
        head: head("Show rate", "showRate"),
        value: (row) => formatRate(dmMetrics(row, currency).showRate),
        sub: (row) => `${formatRate(dmMetrics(row, currency).recordedRate)} recorded`,
      },
      { key: "won", label: "Won", head: "Won", value: (row) => formatCount(row.won), quiet: (row) => row.won === 0 },
      cash,
    ];
  } else {
    meta = (row) => (row.scheduledHours > 0 ? `${formatCount(row.scheduledHours)} h scheduled` : "No schedule");
    columns = [
      { key: "captures", label: "Captures", head: "Captures", value: (row) => formatCount(row.captures) },
      { key: "people", label: "People", head: "People", value: (row) => formatCount(row.uniquePeople) },
      { key: "resparks", label: "Resparks", head: "Resparks", value: (row) => formatCount(row.resparks), quiet: (row) => row.resparks === 0 },
      {
        key: "perHour",
        label: "Per hour",
        head: head("Per hour", "perScheduledHour"),
        value: (row) => perHourCell(row.captures, row.scheduledHours),
        quiet: (row) => row.scheduledHours === 0,
      },
      {
        key: "deals",
        label: "Deals credited",
        head: "Deals",
        value: (row) => formatCount(row.dealsCredited),
        sub: (row) => {
          const m = leadGenMetrics(row, currency);
          return `${formatCount(m.captureDeals)} capture · ${formatCount(m.resparkDeals)} respark`;
        },
      },
      { key: "won", label: "Won", head: "Won", value: (row) => formatCount(row.won), quiet: (row) => row.won === 0 },
      cash,
    ];
  }
  return (
    <>
      {truncated ? (
        <ReportNote lead="Partial.">
          Too many records in this range to read every one, so these counts are a lower bound. Narrow the range for exact counts.
        </ReportNote>
      ) : null}
      {role !== "dm_closer" ? null : (
        <ReportNote>Bookings are new bookings through a DM closer&apos;s link; a move or a rebook doesn&apos;t count again.</ReportNote>
      )}
      <PeopleTable
        caption={`${ROLE_LABEL[role]}s`}
        rows={ordered}
        rowKey={(row) => row.key}
        first={{ head: ROLE_LABEL[role], cell: (row) => roleWho(row, links, inactive, meta(row)) }}
        columns={columns}
      />
    </>
  );
}

// ─── Everyone ────────────────────────────────────────────────────────────────

const CASH_ROLES: readonly MemberRole[] = ["closer", "setter", "dm_closer", "lead_gen"];

export function EveryoneTable({
  members,
  reports,
  currency,
  links,
  phrase,
}: {
  members: readonly MemberProfile[];
  reports: RoleReports;
  currency: string;
  links: Links;
  phrase: string;
}) {
  const { everyone, unlinked } = buildEveryone(members, reports);
  if (everyone.length === 0 && unlinked.length === 0) return <SectionEmpty title={`No team members ${phrase}.`} />;
  const partial = everyonePartialNote(reports);
  const columns: Array<TableColumn<EveryoneRow>> = [
    {
      key: "roles",
      label: "Roles",
      head: "Roles",
      text: true,
      value: (entry) => (
        <span className="flex flex-wrap gap-1">
          {entry.roles.map((role) => (
            <RoleChip key={role} role={role} />
          ))}
        </span>
      ),
    },
    ...CASH_ROLES.map(
      (role): TableColumn<EveryoneRow> => ({
        key: role,
        label: `Credited as ${ROLE_LABEL[role].toLowerCase()}`,
        head: `As ${ROLE_LABEL[role].toLowerCase()}`,
        value: (entry) => {
          const amount = roleCash(entry, role, currency);
          return amount === null ? "—" : money(amount, currency);
        },
        quiet: (entry) => !roleCash(entry, role, currency),
      }),
    ),
  ];
  return (
    <>
      {partial ? <ReportNote lead="Partial.">{partial}</ReportNote> : null}
      <ReportNote lead="Credited cash">
        is shown per role, in full for each person who holds a credit, so it never adds up to the period&apos;s cash and isn&apos;t a
        total earned.
      </ReportNote>
      <PeopleTable
        caption="Every team member"
        rows={everyone}
        rowKey={(entry) => entry.teamMemberId}
        first={{
          head: "Member",
          cell: (entry) => (
            <Who name={entry.name} href={links.memberHref(entry.teamMemberId)} inactive={!entry.isActive} meta={headline(entry)} />
          ),
        }}
        columns={columns}
        wide="@5xl/people"
      />
      {unlinked.length > 0 ? <UnlinkedList rows={unlinked} currency={currency} /> : null}
    </>
  );
}

function UnlinkedList({ rows, currency }: { rows: readonly UnlinkedRow[]; currency: string }) {
  return (
    <>
      <GroupHead>Not linked to a member · {formatCount(rows.length)}</GroupHead>
      <ul aria-label="Records not linked to a member" className="flex flex-col">
        {rows.map((row) => {
          const amount = row.closer ? closerMetrics(row.closer, currency).cashMinor : setterMetrics(row.record!, currency).cashMinor;
          const work = row.closer
            ? `${formatCount(row.closer.held)} held · ${plural(row.closer.payments, "payment")}`
            : row.role === "setter"
              ? `${formatCount(row.record!.qualifications)} qualified`
              : row.role === "dm_closer"
                ? plural(row.record!.bookings, "booking")
                : plural(row.record!.captures, "capture");
          return (
            <li key={row.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 last:border-b-0">
              <span className="font-medium">{row.closer ? row.name : `${ROLE_LABEL[row.role]} records`}</span>
              <RoleChip role={row.role} />
              <span className="text-[13px] text-muted-foreground">{work}</span>
              <span className="ml-auto font-condensed text-[15px] font-semibold tabular-nums">{money(amount, currency)}</span>
            </li>
          );
        })}
      </ul>
      <p className="border-t px-4 py-2 text-[13px] text-muted-foreground">Link these records to a member on Team to give them a report.</p>
    </>
  );
}

/** The roster card for the chosen tab, with its own empty, partial and loading states. */
export function RosterCard({
  title,
  meta,
  loading,
  reloading,
  children,
}: {
  title: string;
  meta: ReactNode;
  loading: boolean;
  reloading: boolean;
  children: ReactNode;
}) {
  return (
    <ReportCard title={title} meta={meta} container="@container/people" reloading={reloading}>
      {loading ? <RowsSkeleton rows={6} rowHeight="h-14" label={`Loading ${title.toLowerCase()}`} /> : children}
    </ReportCard>
  );
}
