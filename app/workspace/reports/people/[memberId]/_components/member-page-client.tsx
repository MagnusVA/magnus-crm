"use client";

import { useQuery } from "convex/react";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { mergePeopleClosers } from "@/convex/analytics/merge/people";
import { mergePeopleRoles } from "@/convex/analytics/merge/peopleRoles";
import type { CrmRole } from "@/convex/lib/roleMapping";
import type { MemberRole } from "@/convex/reports/member";
import type { PeopleRoleReport } from "@/convex/reports/peopleRoles";
import { AnalyticsFreshnessAlert, freshnessSummary } from "@/app/workspace/_components/analytics/analytics-freshness";
import { useAnalyticsReport, type AnalyticsFreshness } from "@/app/workspace/_components/analytics/use-analytics-report";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { useNow } from "@/hooks/use-now";
import { useBreadcrumbTrail } from "@/hooks/use-breadcrumbs";
import { usePageTitle } from "@/hooks/use-page-title";
import { currentAnswers, type ShownAnswer } from "@/lib/reporting/export";
import { ReportExportMenu } from "../../../_components/report-export-menu";
import { REPORT_PAGE, REPORT_PAIR, ReportCard, ReportNote } from "../../../_components/report-ui";
import { ReportRangeMessage, ReportRangePicker, useReportRange } from "../../../_components/use-report-range";
import {
  buildMemberDocument,
  closerMemberFigures,
  daysTable,
  roleMemberFigures,
  rosterCurrencies,
  type MemberSection,
} from "../../_components/people-data";
import { formatMoney, formatWhen, humanize, pickCurrency, rangeQuery } from "../../_components/report-format";
import { BandRoleChip, CurrencySelect, ReportBandWithRow, ROLE_LABEL } from "../../_components/report-parts";
import { useKept, useReportViewed } from "../../../_components/use-report-page";
import {
  CallsList,
  CLOSER_DAY_SERIES,
  DaysCard,
  FiguresCard,
  ItemsList,
  recordLinks,
  ROLE_DAY_SERIES,
  WorkLog,
} from "./member-sections";

// One member's period (docs/reviews/reports-overhaul.html §10): a section per
// role they work, each figure beside the team's median for admins, the days
// of the range, the items they worked, and the work log. Convex scopes every
// reader to the member; a non-admin's are forced to their own.

type OtherRole = Exclude<MemberRole, "closer">;

export function MemberPageClient({ memberId, viewerRole }: { memberId: Id<"teamMembers">; viewerRole: CrmRole }) {
  useReportViewed("member");
  const isAdmin = viewerRole === "tenant_master" || viewerRole === "tenant_admin";
  const searchParams = useSearchParams();
  const profile = useQuery(api.reports.member.getMemberProfile, { memberId });
  usePageTitle(profile ? `${profile.name} — People` : "Member report — People");
  // Admins came from the roster; anyone else only has their own report.
  useBreadcrumbTrail(
    profile
      ? isAdmin
        ? [
            { label: "Reports", href: "/workspace/reports" },
            { label: "People", href: "/workspace/reports/people" },
            { label: profile.name, href: `/workspace/reports/people/${memberId}` },
          ]
        : [{ label: "My report", href: `/workspace/reports/people/${memberId}` }]
      : null,
  );
  const range = useReportRange();
  const now = useNow();
  const ready = range.loaded && profile !== undefined;
  const has = (role: MemberRole) => ready && (profile?.roles.includes(role) ?? false);

  const mine = { memberId };
  const closerArgs = (window: { startDate: number; endDate: number }, member: boolean) => ({
    ...window,
    ...(member ? mine : {}),
    asOf: now,
  });
  const closer = useAnalyticsReport({
    page: "people",
    reportId: "people.closers",
    plan: range.plan,
    filters: { memberId },
    live: api.reports.people.getPeopleClosers,
    liveArgs: has("closer") ? closerArgs(range.window, true) : "skip",
    todayArgs: has("closer") ? closerArgs(range.todayWindow, true) : "skip",
    merge: mergePeopleClosers,
  });
  // The team's roster, without the member filter, gives the medians. Only
  // admins can read it, so nobody else asks.
  const closerTeam = useAnalyticsReport({
    page: "people",
    reportId: "people.closers",
    plan: range.plan,
    filters: { memberId: null },
    live: api.reports.people.getPeopleClosers,
    liveArgs: isAdmin && has("closer") ? closerArgs(range.window, false) : "skip",
    todayArgs: isAdmin && has("closer") ? closerArgs(range.todayWindow, false) : "skip",
    merge: mergePeopleClosers,
  });
  const roleReport = (role: OtherRole, team: boolean) => ({
    page: "people" as const,
    reportId: role === "setter" ? "people.setters" : role === "dm_closer" ? "people.dm_closers" : "people.lead_gen",
    plan: range.plan,
    filters: { memberId: team ? null : memberId },
    live:
      role === "setter"
        ? api.reports.peopleRoles.getSetters
        : role === "dm_closer"
          ? api.reports.peopleRoles.getDmClosers
          : api.reports.peopleRoles.getLeadGen,
    liveArgs: has(role) && (!team || isAdmin) ? { ...range.window, ...(team ? {} : mine) } : ("skip" as const),
    todayArgs: has(role) && (!team || isAdmin) ? { ...range.todayWindow, ...(team ? {} : mine) } : ("skip" as const),
    merge: mergePeopleRoles,
  });
  const setter = useAnalyticsReport(roleReport("setter", false));
  const setterTeam = useAnalyticsReport(roleReport("setter", true));
  const dm = useAnalyticsReport(roleReport("dm_closer", false));
  const dmTeam = useAnalyticsReport(roleReport("dm_closer", true));
  const leadGen = useAnalyticsReport(roleReport("lead_gen", false));
  const leadGenTeam = useAnalyticsReport(roleReport("lead_gen", true));

  const key = JSON.stringify(range.window);
  const keptCloser = useKept(closer.data, key, range.phrase);
  const keptCloserTeam = useKept(closerTeam.data, key, range.phrase);
  const keptRole: Record<OtherRole, ReturnType<typeof useKept<PeopleRoleReport>>> = {
    setter: useKept(setter.data, key, range.phrase),
    dm_closer: useKept(dm.data, key, range.phrase),
    lead_gen: useKept(leadGen.data, key, range.phrase),
  };
  const keptRoleTeam: Record<OtherRole, ReturnType<typeof useKept<PeopleRoleReport>>> = {
    setter: useKept(setterTeam.data, key, range.phrase),
    dm_closer: useKept(dmTeam.data, key, range.phrase),
    lead_gen: useKept(leadGenTeam.data, key, range.phrase),
  };

  const roles = profile?.roles ?? [];
  const freshnessItems: AnalyticsFreshness[] = [
    ...(roles.includes("closer") ? [closer.freshness, ...(isAdmin ? [closerTeam.freshness] : [])] : []),
    ...(roles.includes("setter") ? [setter.freshness, ...(isAdmin ? [setterTeam.freshness] : [])] : []),
    ...(roles.includes("dm_closer") ? [dm.freshness, ...(isAdmin ? [dmTeam.freshness] : [])] : []),
    ...(roles.includes("lead_gen") ? [leadGen.freshness, ...(isAdmin ? [leadGenTeam.freshness] : [])] : []),
  ];
  const freshness = freshnessSummary(freshnessItems, now);
  const allLoaded =
    profile !== undefined &&
    (!roles.includes("closer") || closer.data !== undefined) &&
    roles.filter((role): role is OtherRole => role !== "closer").every((role) => keptRole[role].data !== undefined);

  const currencies = useMemo(
    () =>
      rosterCurrencies({
        closers: keptCloser.data,
        setters: keptRole.setter.data,
        dmClosers: keptRole.dm_closer.data,
        leadGen: keptRole.lead_gen.data,
      }),
    [keptCloser.data, keptRole.setter.data, keptRole.dm_closer.data, keptRole.lead_gen.data],
  );
  const [requestedCurrency, setRequestedCurrency] = useState<string | null>(null);
  const currency = pickCurrency(currencies, requestedCurrency);

  // The export is named for the range picked now, so it waits until every
  // answer it shows, the team's medians included, is for that range.
  const exportable =
    profile !== undefined &&
    currentAnswers(
      Object.fromEntries(
        roles.flatMap((role) => {
          const own = role === "closer" ? keptCloser : keptRole[role];
          const team = role === "closer" ? keptCloserTeam : keptRoleTeam[role];
          return isAdmin ? [[role, own], [`${role}_team`, team]] : [[role, own]];
        }),
      ) as Record<string, ShownAnswer<unknown>>,
    ) !== null;
  const links = recordLinks(viewerRole);

  // Every role's section, shaped once for the page and the export.
  const sections: MemberSection[] = roles.map((role) => {
    if (role === "closer") {
      const data = keptCloser.data;
      const row = data?.rows.find((entry) => entry.teamMemberId === memberId) ?? null;
      return {
        role,
        figures: closerMemberFigures(row, isAdmin ? (keptCloserTeam.data?.rows ?? null) : null, currency),
        days: data
          ? daysTable(
              "Phone closer · by day",
              [
                { key: "held", label: "Held", format: "number" },
                { key: "noShow", label: "No-show", format: "number" },
                { key: "notRecorded", label: "Not recorded", format: "number" },
                { key: "currency", label: "Currency" },
                { key: "cash", label: "Cash", format: "money", currencyKey: "currency" },
              ],
              data.days.map((day) => ({
                day: day.dayKey,
                held: day.held,
                noShow: day.noShow,
                notRecorded: day.notRecorded,
                currency,
                cash: day.cashMinorByCurrency.find((entry) => entry.currency.toUpperCase() === currency)?.cashMinor ?? 0,
              })),
            )
          : null,
        items: data
          ? {
              title: "Calls",
              table: {
                title: "Phone closer · calls",
                columns: [
                  { key: "when", label: "Call" },
                  { key: "person", label: "Person" },
                  { key: "program", label: "Program" },
                  { key: "type", label: "Call type" },
                  { key: "status", label: "Result" },
                  { key: "outcome", label: "Deal" },
                  { key: "paid", label: "Paid" },
                ],
                rows: data.calls.map((call) => ({
                  when: formatWhen(call.scheduledAt),
                  person: call.leadName,
                  program: call.programName,
                  type: call.callType === "follow_up" ? "Follow-up" : "First",
                  status: humanize(call.status),
                  outcome: call.dealOutcome ? humanize(call.dealOutcome) : null,
                  paid: call.paidMinor.map((entry) => formatMoney(entry.paidMinor, entry.currency)).join(" · ") || null,
                })),
              },
            }
          : null,
      };
    }
    const data = keptRole[role].data;
    const row = data?.rows.find((entry) => entry.teamMemberId === memberId) ?? null;
    const series = ROLE_DAY_SERIES[role];
    return {
      role,
      figures: roleMemberFigures(role, row, isAdmin ? (keptRoleTeam[role].data?.rows ?? null) : null, currency),
      days: data
        ? daysTable(
            `${ROLE_LABEL[role]} · by day`,
            series.map((entry) => ({ key: entry.key, label: entry.label, format: "number" as const })),
            data.days.map((day) => ({ day: day.dayKey, ...Object.fromEntries(series.map((entry) => [entry.key, day[entry.key as keyof typeof day] as number])) })),
          )
        : null,
      items: data
        ? {
            title: role,
            table: {
              title: `${ROLE_LABEL[role]} · ${role === "setter" ? "qualifications" : role === "dm_closer" ? "bookings" : "captures"}`,
              columns: [
                { key: "when", label: "When" },
                { key: "person", label: "Person" },
                { key: "result", label: "Result" },
                { key: "outcome", label: "Deal" },
              ],
              rows: data.items.map((item) => ({
                when: formatWhen(item.at),
                person: item.personName,
                result: humanize(item.result),
                outcome: item.outcome ? humanize(item.outcome) : null,
              })),
            },
          }
        : null,
    };
  });

  const query = rangeQuery(searchParams);
  const unlinked = profile !== undefined && profile !== null && profile.roles.length === 0;

  return (
    <div className={REPORT_PAGE}>
      <ReportBandWithRow
        title={profile?.name ?? "Member report"}
        back={isAdmin ? { href: `/workspace/reports/people${query}`, label: "People" } : undefined}
        range={range.words}
        freshness={allLoaded ? freshness : null}
        dayLine={range.dayLine}
        actions={
          <>
            <ReportRangePicker range={range} />
            <CurrencySelect currencies={currencies} value={currency} onChange={setRequestedCurrency} label="Currency for cash in this report" />
            <ReportExportMenu
              page="people"
              memberName={profile?.name}
              startDate={range.dates.startBusinessDate}
              endDate={range.dates.endBusinessDateInclusive}
              buildDocument={() =>
                profile && exportable
                  ? buildMemberDocument({
                      profile,
                      currency,
                      sections,
                      period: range.words,
                      boundary: range.dayLine,
                      generatedAt: Date.now(),
                    })
                  : null
              }
            />
          </>
        }
        row={
          profile && profile.roles.length > 0 ? (
            <div className="-mx-4 flex flex-wrap items-center gap-1.5 border-t border-board-line px-4 py-2.5 @lg:-mx-[18px] @lg:px-[18px]">
              {profile.roles.map((role) => (
                <BandRoleChip key={role} role={role} />
              ))}
              {!profile.isActive ? <span className="ml-1 text-[13px] text-board-muted">Inactive</span> : null}
            </div>
          ) : undefined
        }
      />
      <ReportRangeMessage range={range} />
      <AnalyticsFreshnessAlert summary={freshness} />

      {unlinked ? (
        <ReportCard title="No roles linked">
          <SectionEmpty title={`${profile.name} has no role records linked, so there are no figures to show.`}>
            Link a login, Slack user, DM closer or lead gen worker to this member on Team. Anything they did still shows in the
            work log below.
          </SectionEmpty>
        </ReportCard>
      ) : null}

      {sections.map((section) => {
        const role = section.role;
        if (role === "closer") {
          const data = keptCloser.data;
          return (
            <section key={role} aria-label={ROLE_LABEL[role]} className="flex flex-col gap-3.5 short:gap-3">
              <FiguresCard
                role={role}
                figures={section.figures}
                loading={data === undefined}
                reloading={keptCloser.reloading}
                showTeam={isAdmin}
                note={
                  data && (data.partial || data.paymentsPartial || data.cohortPartial) ? (
                    <ReportNote lead="Partial.">Too many calls or payments in this range to read every one live, so counts are a lower bound.</ReportNote>
                  ) : null
                }
              />
              <div className={REPORT_PAIR}>
                <DaysCard
                  title="Calls by day"
                  meta="Held, no-show and not recorded"
                  series={CLOSER_DAY_SERIES}
                  days={data?.days}
                  phrase={keptCloser.phrase}
                  reloading={keptCloser.reloading}
                />
                <CallsList
                  calls={data?.calls}
                  partial={data?.callsPartial ?? false}
                  currency={currency}
                  links={links}
                  phrase={keptCloser.phrase}
                  reloading={keptCloser.reloading}
                />
              </div>
            </section>
          );
        }
        const kept = keptRole[role];
        return (
          <section key={role} aria-label={ROLE_LABEL[role]} className="flex flex-col gap-3.5 short:gap-3">
            <FiguresCard
              role={role}
              figures={section.figures}
              loading={kept.data === undefined}
              reloading={kept.reloading}
              showTeam={isAdmin}
              note={
                kept.data?.isTruncated ? (
                  <ReportNote lead="Partial.">Too many records in this range to read every one, so counts are a lower bound.</ReportNote>
                ) : null
              }
            />
            <div className={REPORT_PAIR}>
              <DaysCard
                title={`${ROLE_LABEL[role]} by day`}
                meta={ROLE_DAY_SERIES[role].map((entry) => entry.label).join(" and ")}
                series={ROLE_DAY_SERIES[role]}
                days={kept.data?.days}
                phrase={kept.phrase}
                reloading={kept.reloading}
              />
              <ItemsList role={role} items={kept.data?.items} links={links} phrase={kept.phrase} reloading={kept.reloading} />
            </div>
          </section>
        );
      })}

      <WorkLog
        window={range.loaded ? range.window : null}
        teamMemberId={memberId}
        actorUserId={profile?.userId ?? null}
        links={links}
        phrase={range.phrase}
      />
    </div>
  );
}

