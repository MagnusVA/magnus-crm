"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { ChevronDownIcon } from "lucide-react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { HelpTip } from "@/app/workspace/team/_components/team-ui";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { REPORT_TERMS, termHelp } from "@/lib/reporting/definitions";
import { cn } from "@/lib/utils";
import {
  COLUMN_HEAD,
  FIGURE_15,
  ReportCard,
  ReportNote,
  RowsSkeleton,
  SINGLE_SERIES,
} from "../../_components/report-ui";
import { PageRows, ReportPager, usePagedRows } from "../../_components/report-paging";
import { memberReportHref } from "../../log/_components/use-team-members";
import { formatCount, formatMoney } from "../../scorecard/_components/report-money";
import {
  NOT_LINKED,
  ROLE_LABELS,
  ROLE_ORDER,
  formatCoverage,
  dealLabels,
  pathLabel,
  type CreditRole,
  type LaneView,
  type PathRow,
  type ResponsibleRow,
} from "./attribution-shape";

// The Attribution cards (§11): a lane per role, every credited person, and
// the role combinations on paid deals. Deals open their chain in a panel.

/** The hatched end of a lane: cash with no one in the role. */
const UNCREDITED_FILL =
  "repeating-linear-gradient(135deg, color-mix(in oklab, var(--muted-foreground) 35%, transparent) 0 2px, transparent 2px 6px)";

const SHOWN_PEOPLE_PER_LANE = 5;

/** A person's name opening their member report, or a slate line when no member holds the record. */
function PersonName({ person }: { person: { name: string; teamMemberId: Id<"teamMembers"> | null; linked: boolean } }) {
  return (
    <>
      {person.teamMemberId ? (
        <Link href={memberReportHref(person.teamMemberId)} className={cn(detailLinkClass, "max-w-full truncate")}>
          {person.name}
        </Link>
      ) : (
        <span className="truncate font-medium">{person.name}</span>
      )}
      {!person.linked ? <span className="block truncate text-[13px] text-muted-foreground">{NOT_LINKED}</span> : null}
    </>
  );
}

/** Deal buttons, named by each deal's person, that open the deal's chain. */
function DealButtons({ dealIds, onOpenDeal }: { dealIds: readonly string[]; onOpenDeal: (id: Id<"opportunities">) => void }) {
  const names = useQuery(api.reports.attribution.getDealNames, { opportunityIds: dealIds as Id<"opportunities">[] });
  const labels = useMemo(
    () => dealLabels(dealIds, names ? new Map(names.map((entry) => [entry.opportunityId as string, entry.name])) : undefined),
    [dealIds, names],
  );
  return (
    <ul className="flex flex-wrap gap-1.5 border-b bg-muted/30 px-4 py-2.5" aria-label="Deals" aria-busy={names === undefined}>
      {dealIds.map((id) => (
        <li key={id} className="max-w-full">
          <Button
            variant="outline"
            size="sm"
            className="h-7 max-w-full px-2 text-[13px]"
            onClick={() => onOpenDeal(id as Id<"opportunities">)}
          >
            <span className="truncate">{labels.get(id)}</span>
          </Button>
        </li>
      ))}
    </ul>
  );
}

// ─── Lanes ───────────────────────────────────────────────────────────────────

/**
 * One role's lane as a column: the role and its coverage, the lane's bar,
 * the five people credited with the most, and what the lane leaves out.
 */
function LaneColumn({ view, currency, onShowRole }: { view: LaneView; currency: string; onShowRole: (role: CreditRole) => void }) {
  const scale = (amount: number) => (view.totalMinor > 0 ? `${Math.min((amount / view.totalMinor) * 100, 100)}%` : "0%");
  const shown = view.people.slice(0, SHOWN_PEOPLE_PER_LANE);
  const more = view.people.length - shown.length;
  return (
    <li className="flex min-w-0 flex-col gap-2 bg-card px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="truncate font-semibold">{ROLE_LABELS[view.role]}</p>
        <p className={cn(FIGURE_15, "shrink-0")}>
          {formatCoverage(view.coverage)}
          <span className="sr-only"> covered</span>
        </p>
      </div>
      <div aria-hidden="true" className="flex h-2 overflow-hidden rounded-[3px] bg-muted">
        <div className="h-full" style={{ width: scale(view.laneMinor), background: SINGLE_SERIES }} />
        <div className="h-full flex-1" style={{ background: view.uncreditedMinor > 0 ? UNCREDITED_FILL : undefined }} />
      </div>
      {shown.length > 0 ? (
        <ul aria-label={`${ROLE_LABELS[view.role]} credited cash by person`} className="flex flex-col">
          {shown.map((person) => (
            <li key={person.key} className="flex min-h-7 items-baseline justify-between gap-3 py-0.5 text-[14px]">
              <span className="min-w-0">
                <PersonName person={person} />
              </span>
              <span className={cn(FIGURE_15, "shrink-0 whitespace-nowrap")}>{formatMoney(person.amountMinor, currency)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-muted-foreground">No one credited in this role.</p>
      )}
      <div className="mt-auto flex flex-col gap-0.5 border-t pt-2 text-[13px] text-muted-foreground">
        <dl className="flex flex-col gap-0.5">
          {view.sharedMinor > 0 ? (
            <div className="flex items-baseline justify-between gap-3">
              <dt>
                <HelpTip tip={termHelp("shared")}>{REPORT_TERMS.shared.label}</HelpTip>
              </dt>
              <dd className={cn(FIGURE_15, "text-foreground")}>{formatMoney(view.sharedMinor, currency)}</dd>
            </div>
          ) : null}
          <div className="flex items-baseline justify-between gap-3">
            <dt>No credit in this role</dt>
            <dd className={cn(FIGURE_15, view.uncreditedMinor > 0 ? "text-foreground" : undefined)}>{formatMoney(view.uncreditedMinor, currency)}</dd>
          </div>
        </dl>
        {more > 0 ? (
          <div>
            <button type="button" onClick={() => onShowRole(view.role)} className={cn(detailLinkClass, "text-[13px] font-medium")}>
              {formatCount(more)} more in the table
            </button>
          </div>
        ) : null}
      </div>
    </li>
  );
}

export function LanesCard({
  views,
  currency,
  isTruncated,
  reloading,
  phrase,
  onShowRole,
}: {
  views: LaneView[] | undefined;
  currency: string;
  isTruncated: boolean;
  reloading: boolean;
  phrase: string;
  /** Filters the people table to a role and brings it into view. */
  onShowRole: (role: CreditRole) => void;
}) {
  const total = views?.[0]?.totalMinor ?? 0;
  return (
    <ReportCard
      title="Cash by role"
      meta={views ? `Each lane is ${formatMoney(total, currency)}` : undefined}
      container="@container/lanes"
      reloading={reloading}
    >
      <ReportNote lead="A history, not commission.">
        Attribution records who contributed to each deal. It is never commission or what anyone is owed.
      </ReportNote>
      {views === undefined ? (
        <RowsSkeleton rows={5} label="Loading cash by role" />
      ) : total === 0 ? (
        <SectionEmpty title={`No cash in ${currency} ${phrase}.`}>Lanes fill as payments are recorded.</SectionEmpty>
      ) : (
        <>
          {isTruncated ? (
            <ReportNote lead="Partial.">The range has more records than one read covers, so some cash may be missing.</ReportNote>
          ) : null}
          <ReportNote>
            A person&apos;s row counts each payment in full, so two people in one role can add up to more than the lane. The
            overlap is Shared. The hatched end is cash with no one credited in that role.
          </ReportNote>
          {/* The chain left to right, a lane per role; a spare cell squares the grid at two and three columns. */}
          <ul aria-label="Cash by role" className="grid gap-px bg-border @xl/lanes:grid-cols-2 @3xl/lanes:grid-cols-3 @5xl/lanes:grid-cols-5">
            {views.map((view) => (
              <LaneColumn key={view.role} view={view} currency={currency} onShowRole={onShowRole} />
            ))}
            {views.length % 2 === 1 ? <li aria-hidden="true" className="hidden bg-card @xl/lanes:block @5xl/lanes:hidden" /> : null}
          </ul>
        </>
      )}
    </ReportCard>
  );
}

// ─── Who is responsible ──────────────────────────────────────────────────────

export const ALL_ROLES = "__all__";
export type RoleFilter = CreditRole | typeof ALL_ROLES;
/** The people table's id, so a lane's "more" link can bring it into view. */
export const RESPONSIBLE_CARD_ID = "attribution-people";
const RESPONSIBLE_COLUMNS =
  "grid-cols-[minmax(0,1fr)_4rem_7rem] @2xl/responsible:grid-cols-[minmax(0,1fr)_7rem_4.5rem_8rem]";

export function ResponsibleCard({
  rows,
  currency,
  reloading,
  phrase,
  role,
  onRoleChange,
  onOpenDeal,
}: {
  rows: ResponsibleRow[] | undefined;
  currency: string;
  reloading: boolean;
  phrase: string;
  role: RoleFilter;
  onRoleChange: (role: RoleFilter) => void;
  onOpenDeal: (id: Id<"opportunities">) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const filtered = (rows ?? []).filter((row) => role === ALL_ROLES || row.role === role);
  const { rows: shown, pager } = usePagedRows(filtered, { resetKey: `${role}|${currency}` });
  return (
    <ReportCard
      title="Who is responsible for how much"
      container="@container/responsible"
      reloading={reloading}
      id={RESPONSIBLE_CARD_ID}
      className="scroll-mt-4"
      meta={
        <Select value={role} onValueChange={(next) => onRoleChange(next as RoleFilter)}>
          <SelectTrigger aria-label="Role" className="h-[30px]! w-[9.5rem] rounded-[7px] bg-background text-[13px] text-foreground">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value={ALL_ROLES}>All roles</SelectItem>
            {ROLE_ORDER.map((option) => (
              <SelectItem key={option} value={option}>
                {ROLE_LABELS[option]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
      footer={rows === undefined ? undefined : <ReportPager pager={pager} noun="people" />}
    >
      {rows === undefined ? (
        <RowsSkeleton rows={6} label="Loading who is responsible" />
      ) : filtered.length === 0 ? (
        <SectionEmpty title={role === ALL_ROLES ? `No one is credited on cash ${phrase}.` : `No ${ROLE_LABELS[role]} credit on cash ${phrase}.`} />
      ) : (
        <>
          <ReportNote>
            <HelpTip tip={termHelp("creditedCash")}>{REPORT_TERMS.creditedCash.label}</HelpTip> counts each deal once per role,
            in {currency}. Open a person&apos;s deals to see each one&apos;s chain.
          </ReportNote>
          <PageRows pager={pager} steady={open === null}>
            <div role="table" aria-label="Credited cash by person and role">
              <div role="row" className={cn("grid border-b", RESPONSIBLE_COLUMNS)}>
                <span role="columnheader" className={cn(COLUMN_HEAD, "pl-4")}>
                  Name
                </span>
                <span role="columnheader" className={cn(COLUMN_HEAD, "hidden @2xl/responsible:block")}>
                  Role
                </span>
                <span role="columnheader" className={cn(COLUMN_HEAD, "text-right")}>
                  Deals
                </span>
                <span role="columnheader" className={cn(COLUMN_HEAD, "pr-4 text-right")}>
                  Credited
                </span>
              </div>
              {shown.map((row) => {
                const expanded = open === row.rowKey;
                return (
                  <div key={row.rowKey} role="rowgroup">
                    <div role="row" className={cn("grid min-h-11 items-center border-b py-1.5", RESPONSIBLE_COLUMNS, expanded && "bg-accent/40")}>
                      <span role="cell" className="min-w-0 pr-3 pl-4">
                        <PersonName person={row} />
                        <span className="block text-[13px] text-muted-foreground @2xl/responsible:hidden">{ROLE_LABELS[row.role]}</span>
                      </span>
                      <span role="cell" className="hidden text-[13px] text-muted-foreground @2xl/responsible:block">
                        {ROLE_LABELS[row.role]}
                      </span>
                      <span role="cell" className="px-2.5 text-right">
                        <button
                          type="button"
                          aria-expanded={expanded}
                          onClick={() => setOpen(expanded ? null : row.rowKey)}
                          className={cn(FIGURE_15, "inline-flex items-center gap-1 rounded-sm underline decoration-foreground/40 underline-offset-[3px] hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none")}
                        >
                          {formatCount(row.dealIds.length)}
                          <ChevronDownIcon aria-hidden="true" className={cn("size-3.5 transition-transform", expanded && "rotate-180")} />
                          <span className="sr-only"> deals, {expanded ? "hide" : "show"} them</span>
                        </button>
                      </span>
                      <span role="cell" className={cn(FIGURE_15, "pr-4 pl-2.5 text-right whitespace-nowrap", row.amountMinor === 0 && "text-muted-foreground")}>
                        {formatMoney(row.amountMinor, currency)}
                      </span>
                    </div>
                    {expanded ? (
                      <div role="row">
                        <div role="cell">
                          <DealButtons dealIds={row.dealIds} onOpenDeal={onOpenDeal} />
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </PageRows>
        </>
      )}
    </ReportCard>
  );
}

// ─── Paths that paid ─────────────────────────────────────────────────────────

export function PathsCard({
  rows,
  currency,
  isTruncated,
  reloading,
  phrase,
  onOpenDeal,
}: {
  rows: PathRow[] | undefined;
  currency: string;
  isTruncated: boolean;
  reloading: boolean;
  phrase: string;
  onOpenDeal: (id: Id<"opportunities">) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const max = Math.max(...(rows ?? []).map((row) => row.amountMinor), 0);
  const { rows: shown, pager } = usePagedRows(rows ?? [], { resetKey: currency });
  return (
    <ReportCard
      title="Paths that paid"
      meta="Which roles touched each paid deal"
      container="@container/paths"
      reloading={reloading}
      footer={rows === undefined ? undefined : <ReportPager pager={pager} noun="paths" />}
    >
      {rows === undefined ? (
        <RowsSkeleton rows={5} label="Loading paths that paid" />
      ) : rows.length === 0 ? (
        <SectionEmpty title={`No paid deals in ${currency} ${phrase}.`} />
      ) : (
        <>
          {isTruncated ? <ReportNote lead="Partial.">Some payments in the range weren&apos;t read.</ReportNote> : null}
          <PageRows pager={pager} steady={open === null}>
            <ul aria-label="Paths that paid">
              {shown.map((row) => {
                const expanded = open === row.key;
                return (
                  <li key={row.key} className="border-b last:border-b-0">
                    <button
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => setOpen(expanded ? null : row.key)}
                      className={cn(
                        "grid min-h-11 w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1.5 px-4 py-2 text-left hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset",
                        expanded && "bg-accent/40",
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{pathLabel(row.roles)}</span>
                        <span className="block text-[13px] text-muted-foreground">
                          {formatCount(row.dealIds.length)} deal{row.dealIds.length === 1 ? "" : "s"}
                        </span>
                      </span>
                      <span className={cn(FIGURE_15, "text-right whitespace-nowrap")}>{formatMoney(row.amountMinor, currency)}</span>
                      <ChevronDownIcon aria-hidden="true" className={cn("size-4 text-muted-foreground transition-transform", expanded && "rotate-180")} />
                      <span aria-hidden="true" className="col-span-3 h-1.5 overflow-hidden rounded-[3px] bg-muted">
                        <span
                          className="block h-full rounded-[3px]"
                          style={{ width: max > 0 ? `${(row.amountMinor / max) * 100}%` : 0, background: SINGLE_SERIES }}
                        />
                      </span>
                    </button>
                    {expanded ? <DealButtons dealIds={row.dealIds} onOpenDeal={onOpenDeal} /> : null}
                  </li>
                );
              })}
            </ul>
          </PageRows>
        </>
      )}
    </ReportCard>
  );
}

/** A band zone's proof for a role: credited cash, and Shared when there is any. */
export function coverageProof(view: LaneView, currency: string): ReactNode {
  const credited = `${formatMoney(view.laneMinor, currency)} credited`;
  return view.sharedMinor > 0 ? `${credited} · ${formatMoney(view.sharedMinor, currency)} shared` : credited;
}

