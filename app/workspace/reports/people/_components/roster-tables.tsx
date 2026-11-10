"use client";

import { totalCloserRow } from "@/lib/reporting/pageFigures/people";

import { useRef, type ReactNode } from "react";
import { XIcon } from "lucide-react";
import { DetailCardFooter } from "@/app/workspace/closer/meetings/_components/detail-card";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { HelpTip } from "@/app/workspace/team/_components/team-ui";
import { Input } from "@/components/ui/input";
import type { Id } from "@/convex/_generated/dataModel";
import type { MemberRole } from "@/convex/reports/member";
import type { CloserRow } from "@/convex/reports/people";
import type { PeopleRoleRow } from "@/convex/reports/peopleRoles";
import { termHelp, type ReportTermKey } from "@/lib/reporting/definitions";
import { cn } from "@/lib/utils";
import { LIST_PAGE_SIZE, PageRows, ReportPager, TABLE_PAGE_SIZE, usePagedRows } from "../../_components/report-paging";
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
// Every name opens the member report, keeping the range. Each table draws
// its own card, so the search sits in the title row and one page of rows
// (TABLE_PAGE_SIZE) shows above a pager: the card's height comes from the
// page size, not from how many members the range holds.

const head = (label: string, term?: ReportTermKey): ReactNode => (term ? <HelpTip tip={termHelp(term)}>{label}</HelpTip> : label);

type Links = { memberHref: (teamMemberId: Id<"teamMembers">) => string };

/** The roster card around whichever tab shows: its title row, search and paging key. */
export type RosterFrame = {
  title: string;
  meta: ReactNode;
  reloading: boolean;
  /** The search text, as typed. */
  search: string;
  onSearch: (next: string) => void;
  /** The tab, currency, range phrase and search: a change goes back to the first page. */
  resetKey: string;
};

/** The shown name contains the search, ignoring case and outer spaces. */
const nameMatches = (name: string, search: string) => name.toLowerCase().includes(search.trim().toLowerCase());

/** "No member matches “ana”." with a way to clear it. */
function SearchEmpty({ frame }: { frame: RosterFrame }) {
  return (
    <SectionEmpty title={`No member matches “${frame.search.trim()}”.`}>
      <button
        type="button"
        onClick={() => frame.onSearch("")}
        className="inline-flex min-h-6 items-center rounded-sm font-semibold text-foreground underline decoration-foreground/40 underline-offset-[3px] hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        Clear search
      </button>
    </SectionEmpty>
  );
}

/** The title row's 30px search: filters the tab's rows by the name shown. */
function RosterSearch({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="relative w-[11.5rem] shrink-0">
      <Input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Find a member"
        aria-label="Find a member by name"
        autoComplete="off"
        spellCheck={false}
        className={cn(
          "h-[30px] rounded-[7px] bg-background text-[13px] text-foreground md:text-[13px] [&::-webkit-search-cancel-button]:appearance-none",
          value ? "pr-8" : undefined,
        )}
      />
      {value ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            onChange("");
            inputRef.current?.focus();
          }}
          className="absolute top-1/2 right-[3px] flex size-6 -translate-y-1/2 items-center justify-center rounded-[5px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <XIcon aria-hidden="true" className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

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
  frame,
  rows,
  unattributed,
  currency,
  links,
  phrase,
  partial,
}: {
  frame: RosterFrame;
  rows: readonly CloserRow[];
  unattributed: number;
  currency: string;
  links: Links;
  phrase: string;
  partial: boolean;
}) {
  const matching = rows.filter((row) => nameMatches(row.name, frame.search));
  const { rows: shown, pager } = usePagedRows(matching, { pageSize: TABLE_PAGE_SIZE, resetKey: frame.resetKey });
  if (rows.length === 0) {
    return (
      <RosterCard frame={frame}>
        <SectionEmpty title={`No phone closers ${phrase}.`} />
      </RosterCard>
    );
  }
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
  // The Total sums every closer, not the page shown, and stays on every page.
  const total = totalCloserRow(rows, currency)!;
  return (
    <RosterCard frame={frame} footer={<ReportPager pager={pager} noun="phone closers" />}>
      {partial ? (
        <ReportNote lead="Partial.">Too many calls or payments in this range to read every one live, so counts are a lower bound.</ReportNote>
      ) : null}
      {matching.length === 0 ? (
        <SearchEmpty frame={frame} />
      ) : (
        <PageRows pager={pager}>
          <PeopleTable
            caption="Phone closers' calls and sales"
            rows={shown}
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
            // While a search narrows the rows, the label says the total doesn't follow it.
            total={{ cell: <span>{matching.length < rows.length ? "Total, all closers" : "Total"}</span>, row: total }}
            wide="@5xl/people"
          />
        </PageRows>
      )}
      {unattributed > 0 ? (
        <DetailCardFooter className="font-normal">
          {money(unattributed, currency)} of the cash in this range names no closer, so it isn&apos;t in these rows.
        </DetailCardFooter>
      ) : null}
    </RosterCard>
  );
}

// ─── Setters, DM closers, lead gen ───────────────────────────────────────────

/** The name a role row shows, which the search matches. */
const roleRowName = (row: PeopleRoleRow) => (row.key.startsWith("team:") || row.teamMemberId ? row.name : "Not linked to a member");

function roleWho(row: PeopleRoleRow, links: Links, inactive: Set<string>, meta?: ReactNode) {
  if (row.key.startsWith("team:")) return <Who name={row.name} href={null} meta="Team booking with no DM closer named" />;
  if (!row.teamMemberId) return <Who name={roleRowName(row)} href={null} meta="Records with no team member" />;
  return <Who name={row.name} href={links.memberHref(row.teamMemberId)} inactive={inactive.has(row.teamMemberId)} meta={meta} />;
}

const perHourCell = (count: number, hours: number) => (hours > 0 ? `${(count / hours).toFixed(2)}/h` : "No schedule");

export function RoleTable({
  frame,
  role,
  rows,
  currency,
  links,
  inactive,
  phrase,
  truncated,
}: {
  frame: RosterFrame;
  role: Exclude<MemberRole, "closer">;
  rows: readonly PeopleRoleRow[];
  currency: string;
  links: Links;
  inactive: Set<string>;
  phrase: string;
  truncated: boolean;
}) {
  const ordered = orderRoleRows(rows);
  const matching = ordered.filter((row) => nameMatches(roleRowName(row), frame.search));
  const { rows: shown, pager } = usePagedRows(matching, { pageSize: TABLE_PAGE_SIZE, resetKey: frame.resetKey });
  const noun = role === "lead_gen" ? "lead generators" : `${ROLE_LABEL[role].toLowerCase()}s`;
  if (ordered.length === 0) {
    return (
      <RosterCard frame={frame}>
        <SectionEmpty title={`No ${ROLE_LABEL[role].toLowerCase()}s ${phrase}.`} />
      </RosterCard>
    );
  }
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
    <RosterCard frame={frame} footer={<ReportPager pager={pager} noun={noun} />}>
      {truncated ? (
        <ReportNote lead="Partial.">
          Too many records in this range to read every one, so these counts are a lower bound. Narrow the range for exact counts.
        </ReportNote>
      ) : null}
      {role !== "dm_closer" ? null : (
        <ReportNote>Bookings are new bookings through a DM closer&apos;s link; a move or a rebook doesn&apos;t count again.</ReportNote>
      )}
      {matching.length === 0 ? (
        <SearchEmpty frame={frame} />
      ) : (
        <PageRows pager={pager}>
          <PeopleTable
            caption={`${ROLE_LABEL[role]}s`}
            rows={shown}
            rowKey={(row) => row.key}
            first={{ head: ROLE_LABEL[role], cell: (row) => roleWho(row, links, inactive, meta(row)) }}
            columns={columns}
          />
        </PageRows>
      )}
    </RosterCard>
  );
}

// ─── Everyone ────────────────────────────────────────────────────────────────

const CASH_ROLES: readonly MemberRole[] = ["closer", "setter", "dm_closer", "lead_gen"];

/**
 * Marks a cash cell for a role the member doesn't hold. The table cell stays
 * empty to the eye; the narrow fold drops the whole "Credited as …" part
 * (the `ROLE_ABSENT_FOLD` rule on the rows' wrapper).
 */
const ROLE_ABSENT = "data-role-absent";
const ROLE_ABSENT_FOLD = "[&_li>p>span:has([data-role-absent])]:hidden";

/** The name an unlinked row shows, which the search matches. */
const unlinkedName = (row: UnlinkedRow) => (row.closer ? row.name : `${ROLE_LABEL[row.role]} records`);

export function EveryoneTable({
  frame,
  members,
  reports,
  currency,
  links,
  phrase,
}: {
  frame: RosterFrame;
  members: readonly MemberProfile[];
  reports: RoleReports;
  currency: string;
  links: Links;
  phrase: string;
}) {
  const { everyone, unlinked } = buildEveryone(members, reports);
  const matching = everyone.filter((entry) => nameMatches(entry.name, frame.search));
  const matchingUnlinked = unlinked.filter((row) => nameMatches(unlinkedName(row), frame.search));
  const { rows: shown, pager } = usePagedRows(matching, { pageSize: TABLE_PAGE_SIZE, resetKey: frame.resetKey });
  if (everyone.length === 0 && unlinked.length === 0) {
    return (
      <RosterCard frame={frame}>
        <SectionEmpty title={`No team members ${phrase}.`} />
      </RosterCard>
    );
  }
  const partial = everyonePartialNote(reports);
  const columns: Array<TableColumn<EveryoneRow>> = [
    {
      key: "roles",
      label: "Roles",
      head: "Roles",
      text: true,
      value: (entry) => (
        // Inline, so the narrow fold keeps "Roles" and the cash on one line.
        <span className="inline-flex flex-wrap gap-1 align-middle">
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
          if (amount === null) {
            return (
              <span {...{ [ROLE_ABSENT]: "" }} className="sr-only">
                not in this role
              </span>
            );
          }
          return money(amount, currency);
        },
        // A role held with no cash reads in slate; above zero stays in ink.
        quiet: (entry) => roleCash(entry, role, currency) === 0,
      }),
    ),
  ];
  // The members' pager sits right under their table, above the unlinked
  // records, so each list's pager is next to its rows.
  return (
    <RosterCard frame={frame}>
      {partial ? <ReportNote lead="Partial.">{partial}</ReportNote> : null}
      <ReportNote lead="Credited cash">
        is shown per role, in full for each person who holds a credit, so it never adds up to the period&apos;s cash and isn&apos;t a
        total earned.
      </ReportNote>
      {matching.length === 0 && matchingUnlinked.length === 0 ? (
        <SearchEmpty frame={frame} />
      ) : null}
      {matching.length > 0 ? (
        <>
          <PageRows pager={pager} className={ROLE_ABSENT_FOLD}>
            <PeopleTable
              caption="Every team member"
              rows={shown}
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
          </PageRows>
          <ReportPager pager={pager} noun="members" />
        </>
      ) : null}
      {matchingUnlinked.length > 0 ? (
        <UnlinkedList rows={matchingUnlinked} currency={currency} resetKey={frame.resetKey} />
      ) : null}
    </RosterCard>
  );
}

function UnlinkedList({
  rows,
  currency,
  resetKey,
}: {
  rows: readonly UnlinkedRow[];
  currency: string;
  resetKey: string;
}) {
  const { rows: shown, pager } = usePagedRows(rows, { pageSize: LIST_PAGE_SIZE, resetKey });
  return (
    <>
      <GroupHead>Not linked to a member · {formatCount(rows.length)}</GroupHead>
      <PageRows pager={pager}>
        <ul aria-label="Records not linked to a member" className="flex flex-col">
          {shown.map((row) => {
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
                <span className="font-medium">{unlinkedName(row)}</span>
                <RoleChip role={row.role} />
                <span className="text-[13px] text-muted-foreground">{work}</span>
                <span className="ml-auto font-condensed text-[15px] font-semibold tabular-nums">{money(amount, currency)}</span>
              </li>
            );
          })}
        </ul>
      </PageRows>
      <ReportPager pager={pager} noun="unlinked records" />
      <p className="border-t px-4 py-2 text-[13px] text-muted-foreground">Link these records to a member on Team to give them a report.</p>
    </>
  );
}

/**
 * The roster card for the chosen tab, with its own empty, partial and loading
 * states. The search stays in the title row while the tab loads, so the row
 * doesn't shift when the rows land.
 */
export function RosterCard({
  frame,
  loading = false,
  footer,
  children,
}: {
  frame: RosterFrame;
  loading?: boolean;
  footer?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <ReportCard
      title={frame.title}
      meta={
        <>
          <span className="hidden @3xl:inline">{frame.meta}</span>
          <RosterSearch value={frame.search} onChange={frame.onSearch} />
        </>
      }
      container="@container/people"
      reloading={frame.reloading}
      footer={loading ? undefined : footer}
    >
      {loading ? <RowsSkeleton rows={6} rowHeight="h-14" label={`Loading ${frame.title.toLowerCase()}`} /> : children}
    </ReportCard>
  );
}
