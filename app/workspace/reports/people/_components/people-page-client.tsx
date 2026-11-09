"use client";

import { useQuery } from "convex/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { mergePeopleClosers } from "@/convex/analytics/merge/people";
import { mergePeopleRoles } from "@/convex/analytics/merge/peopleRoles";
import { AnalyticsFreshnessAlert, freshnessSummary } from "@/app/workspace/_components/analytics/analytics-freshness";
import { useAnalyticsReport } from "@/app/workspace/_components/analytics/use-analytics-report";
import { useNow } from "@/hooks/use-now";
import { usePageTitle } from "@/hooks/use-page-title";
import { cn } from "@/lib/utils";
import { ReportExportMenu } from "../../_components/report-export-menu";
import { REPORT_PAGE } from "../../_components/report-ui";
import { ReportRangeMessage, ReportRangePicker, useReportRange } from "../../_components/use-report-range";
import { buildEveryone, buildPeopleDocument, parseRosterTab, PEOPLE_TERMS, rosterCurrencies, withRosterTab, type RosterTab } from "./people-data";
import { formatCount, pickCurrency, rangeQuery } from "./report-format";
import { CurrencySelect, DefinitionsCard, ReportBandWithRow } from "./report-parts";
import { ClosersTable, EveryoneTable, RoleTable, RosterCard } from "./roster-tables";
import { captureReportFilters, useKept, useReportViewed } from "./use-report-page";

// People: every team member, a tab per role and Everyone side by side
// (docs/reviews/reports-overhaul.html §10). The tab lives in `?role=` so the
// old Slack Qualifications route can land on Setters; switching tabs keeps
// the range and every other parameter.

const TABS: ReadonlyArray<{ value: RosterTab; label: string }> = [
  { value: "everyone", label: "Everyone" },
  { value: "closer", label: "Phone closers" },
  { value: "setter", label: "Setters" },
  { value: "dm_closer", label: "DM closers" },
  { value: "lead_gen", label: "Lead gen" },
];

const TAB_TITLE: Record<RosterTab, string> = {
  everyone: "Everyone",
  closer: "Phone closers",
  setter: "Setters",
  dm_closer: "DM closers",
  lead_gen: "Lead gen",
};

export function PeoplePageClient() {
  usePageTitle("People — Reports");
  useReportViewed("people");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = parseRosterTab(searchParams.get("role"));
  const range = useReportRange();
  const now = useNow();
  const ready = range.loaded;

  const liveArgs = ready ? range.window : ("skip" as const);
  const todayArgs = ready ? range.todayWindow : ("skip" as const);
  const common = { page: "people" as const, plan: range.plan, filters: { memberId: null }, liveArgs, todayArgs };
  const closersReport = useAnalyticsReport({
    ...common,
    reportId: "people.closers",
    live: api.reports.people.getPeopleClosers,
    liveArgs: ready ? { ...range.window, asOf: now } : "skip",
    todayArgs: ready ? { ...range.todayWindow, asOf: now } : "skip",
    merge: mergePeopleClosers,
  });
  const settersReport = useAnalyticsReport({ ...common, reportId: "people.setters", live: api.reports.peopleRoles.getSetters, merge: mergePeopleRoles });
  const dmReport = useAnalyticsReport({ ...common, reportId: "people.dm_closers", live: api.reports.peopleRoles.getDmClosers, merge: mergePeopleRoles });
  const leadGenReport = useAnalyticsReport({ ...common, reportId: "people.lead_gen", live: api.reports.peopleRoles.getLeadGen, merge: mergePeopleRoles });
  const members = useQuery(api.reports.member.listReportMembers, {});

  const loaded =
    closersReport.data && settersReport.data && dmReport.data && leadGenReport.data
      ? { closers: closersReport.data, setters: settersReport.data, dmClosers: dmReport.data, leadGen: leadGenReport.data }
      : undefined;
  const kept = useKept(loaded, JSON.stringify(range.window), range.phrase);
  const reports = kept.data;
  const freshness = freshnessSummary(
    [closersReport.freshness, settersReport.freshness, dmReport.freshness, leadGenReport.freshness],
    now,
  );

  const currencies = useMemo(() => (reports ? rosterCurrencies(reports) : []), [reports]);
  const [requestedCurrency, setRequestedCurrency] = useState<string | null>(null);
  const currency = pickCurrency(currencies, requestedCurrency);

  const memberList = members?.members ?? [];
  const inactive = useMemo(
    () => new Set<string>((members?.members ?? []).filter((member) => !member.isActive).map((member) => member.teamMemberId)),
    [members],
  );
  const counts = reports
    ? {
        everyone: buildEveryone(memberList, reports).everyone.length,
        closer: reports.closers.rows.length,
        setter: reports.setters.rows.filter((row) => row.teamMemberId).length,
        dm_closer: reports.dmClosers.rows.filter((row) => row.teamMemberId).length,
        lead_gen: reports.leadGen.rows.filter((row) => row.teamMemberId).length,
      }
    : null;
  const query = rangeQuery(searchParams);
  const links = { memberHref: (teamMemberId: Id<"teamMembers">) => `/workspace/reports/people/${teamMemberId}${query}` };

  const selectTab = (next: RosterTab) => {
    router.replace(`${pathname}${withRosterTab(new URLSearchParams(searchParams.toString()), next)}`, { scroll: false });
    captureReportFilters("people", { role: next });
  };

  const unattributed =
    reports?.closers.unattributedCash.find((row) => row.currency.toUpperCase() === currency)?.cashMinor ?? 0;
  const loading = reports === undefined || (tab === "everyone" && members === undefined);

  return (
    <div className={REPORT_PAGE}>
      <ReportBandWithRow
        title="People"
        range={range.words}
        freshness={loaded ? freshness : null}
        dayLine={range.dayLine}
        actions={
          <>
            <ReportRangePicker range={range} />
            <CurrencySelect currencies={currencies} value={currency} onChange={setRequestedCurrency} label="Currency for cash on this page" />
            <ReportExportMenu
              page="people"
              startDate={range.dates.startBusinessDate}
              endDate={range.dates.endBusinessDateInclusive}
              buildDocument={() =>
                reports && members
                  ? buildPeopleDocument({
                      tab,
                      reports,
                      members: members.members,
                      currency,
                      period: range.words,
                      boundary: range.dayLine,
                      generatedAt: Date.now(),
                    })
                  : null
              }
            />
          </>
        }
        row={<RosterTabs tab={tab} counts={counts} reloading={kept.reloading} onSelect={selectTab} />}
      />
      <ReportRangeMessage range={range} />
      <AnalyticsFreshnessAlert summary={freshness} />

      <div id="people-roster" role="tabpanel" aria-labelledby={`people-tab-${tab}`}>
        <RosterCard
          title={TAB_TITLE[tab]}
          meta={tab === "everyone" ? "Credited cash by role · names open the member report" : "Names open the member report"}
          loading={loading}
          reloading={kept.reloading}
        >
          {!reports ? null : tab === "everyone" ? (
            <EveryoneTable members={memberList} reports={reports} currency={currency} links={links} phrase={kept.phrase} />
          ) : tab === "closer" ? (
            <ClosersTable
              rows={reports.closers.rows}
              unattributed={unattributed}
              currency={currency}
              links={links}
              phrase={kept.phrase}
              partial={reports.closers.partial || reports.closers.paymentsPartial || reports.closers.cohortPartial}
            />
          ) : (
            <RoleTable
              role={tab}
              rows={(tab === "setter" ? reports.setters : tab === "dm_closer" ? reports.dmClosers : reports.leadGen).rows}
              currency={currency}
              links={links}
              inactive={inactive}
              phrase={kept.phrase}
              truncated={(tab === "setter" ? reports.setters : tab === "dm_closer" ? reports.dmClosers : reports.leadGen).isTruncated}
            />
          )}
        </RosterCard>
        {members?.capped ? (
          <p className="mt-2 text-[13px] text-muted-foreground">
            The team has more records than one read returns, so some inactive markers may be missing.
          </p>
        ) : null}
      </div>
      <DefinitionsCard terms={PEOPLE_TERMS[tab]} />
    </div>
  );
}

/** EVERYONE · PHONE CLOSERS · … on the band, with counts; arrows move between them. */
function RosterTabs({
  tab,
  counts,
  reloading,
  onSelect,
}: {
  tab: RosterTab;
  counts: Record<RosterTab, number> | null;
  reloading: boolean;
  onSelect: (tab: RosterTab) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const select = (index: number) => {
    const next = TABS[(index + TABS.length) % TABS.length];
    onSelect(next.value);
    listRef.current?.querySelector<HTMLButtonElement>(`#people-tab-${next.value}`)?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = TABS.findIndex((entry) => entry.value === tab);
    if (event.key === "ArrowRight") select(current + 1);
    else if (event.key === "ArrowLeft") select(current - 1);
    else if (event.key === "Home") select(0);
    else if (event.key === "End") select(TABS.length - 1);
    else return;
    event.preventDefault();
  };
  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Role"
      onKeyDown={onKeyDown}
      className="-mx-4 flex items-center gap-[22px] overflow-x-auto border-t border-board-line px-4 [scrollbar-width:none] @lg:-mx-[18px] @lg:px-[18px]"
    >
      {TABS.map((entry) => {
        const selected = entry.value === tab;
        return (
          <button
            key={entry.value}
            id={`people-tab-${entry.value}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls="people-roster"
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(entry.value)}
            className={cn(
              "flex h-10 shrink-0 items-center gap-[7px] border-b-2 font-condensed text-[13px] font-semibold tracking-[0.12em] whitespace-nowrap uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              selected ? "border-primary text-board-foreground" : "border-transparent text-board-muted hover:text-board-foreground",
            )}
          >
            {entry.label}
            {counts ? (
              <span
                className={cn(
                  "font-condensed text-[14px] tracking-[0.02em] tabular-nums transition-opacity duration-200 motion-reduce:transition-none",
                  selected ? "text-board-foreground" : "text-board-muted",
                  reloading && "opacity-60",
                )}
              >
                {formatCount(counts[entry.value])}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
