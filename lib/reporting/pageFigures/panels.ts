import type { CallsSummary } from "../../../convex/reports/calls";
import type { AnswersOutput, CashOutput, FollowThroughOutput, FunnelOutput, OriginsOutput } from "../../../convex/reports/scorecard";
import type { PeopleClosers } from "../../../convex/reports/people";
import type { PeopleRoleReport } from "../../../convex/reports/peopleRoles";
import type { MemberProfile } from "../../../convex/reports/member";
import type { AttributionLanes, AttributionPaths } from "../../../convex/reports/attribution";
import { callsFigures } from "./calls";
import { answerShares, cashFigures, followThroughFigures, funnelFigures, orderFollowThrough, orderOrigins, orderPrograms, scorecardCurrencyWeights } from "./scorecard";
import { buildEveryone, closerMemberFigures, closerPageFigures, orderRoleRows, roleMemberFigures, rolePageFigures, rosterCounts, rosterCurrencies, totalCloserRow, type RoleReports } from "./people";
import { attributionCurrencyWeights, laneViews, pathRows, responsibleRows } from "./attribution";
import { pickCurrency } from "./format";
import { pickMainCurrency, shownCurrency } from "./money";

export type PageAnswers = ReadonlyMap<string, unknown>;
export const answer = <T>(answers: PageAnswers, id: string) => answers.get(id) as T | undefined;
export function roleReports(answers: PageAnswers): Partial<RoleReports> {
  return { closers: answer(answers, "people.closers"), setters: answer(answers, "people.setters"), dmClosers: answer(answers, "people.dm_closers"), leadGen: answer(answers, "people.lead_gen") };
}
export function pageCurrency(answers: PageAnswers, page: string, requested?: string): string {
  if (page === "people") return pickCurrency(rosterCurrencies(roleReports(answers)), requested?.toUpperCase() ?? null);
  const weights = page === "attribution" ? attributionCurrencyWeights(answer(answers, "attribution.lanes")) : scorecardCurrencyWeights(answer(answers, "scorecard.cash"), answer(answers, "scorecard.funnel"), answer(answers, "scorecard.origins"));
  return shownCurrency(requested?.toUpperCase() ?? null, weights.map(w => w.currency), pickMainCurrency(weights));
}

/** A full, merged page answer in; page figures and ordering out. Never bound here. */
export function shapePanel(id: string, raw: unknown, answers: PageAnswers, options: { currency?: string; memberId?: string; role?: string } = {}) {
  const currency = pageCurrency(answers, id.split(".")[0], options.currency);
  let data: unknown = raw;
  let figures: unknown = {};
  switch (id) {
    case "calls.summary": {
      const row = raw as CallsSummary;
      figures = callsFigures(row);
      data = { ...row, noShowReasons: [...row.noShowReasons].sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)) };
      break;
    }
    case "scorecard.funnel": figures = funnelFigures(raw as FunnelOutput); break;
    case "scorecard.cash": {
      const row = raw as CashOutput;
      figures = cashFigures(row, currency);
      data = { ...row, currencies: row.currencies.filter(r => !options.currency || r.currency === currency).map(r => ({ ...r, byProgram: orderPrograms(r.byProgram) })) };
      break;
    }
    case "scorecard.follow_through": {
      const row = raw as FollowThroughOutput;
      data = { ...row, byCloser: orderFollowThrough(row.byCloser) };
      figures = followThroughFigures(row); break;
    }
    case "scorecard.origins": data = { ...(raw as OriginsOutput), origins: orderOrigins((raw as OriginsOutput).origins, currency) }; break;
    case "scorecard.answers": figures = { answers: (raw as AnswersOutput).answers.map(r => ({ answer: r.answer, ...answerShares(r) })) }; break;
    case "people.members": {
      const reports = roleReports(answers);
      if (reports.closers && reports.setters && reports.dmClosers && reports.leadGen) {
        const all = reports as RoleReports;
        const members = (raw as { members: MemberProfile[] }).members;
        const joined = buildEveryone(members, all);
        figures = { roleTabCounts: rosterCounts(members, all), everyone: joined.everyone.map(r => ({ teamMemberId: r.teamMemberId, name: r.name, roles: r.roles,
          ...(r.closer ? { closer: closerPageFigures(r.closer, currency) } : {}),
          ...(r.setter ? { setter: rolePageFigures("setter", r.setter, currency) } : {}),
          ...(r.dmCloser ? { dmCloser: rolePageFigures("dm_closer", r.dmCloser, currency) } : {}),
          ...(r.leadGen ? { leadGen: rolePageFigures("lead_gen", r.leadGen, currency) } : {}) })), unlinked: joined.unlinked };
      }
      break;
    }
    case "people.closers": {
      const row = raw as PeopleClosers;
      data = { ...row, rows: [...row.rows].sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId)) };
      const team = answer<PeopleClosers>(answers, "people.closers.team");
      const total = totalCloserRow(row.rows, currency);
      figures = options.memberId ? Object.fromEntries(closerMemberFigures(row.rows.find(r => r.teamMemberId === options.memberId) ?? null, team?.rows ?? null, currency).map(f => [f.term ?? f.key, { value: f.value, teamMedian: f.teamMedian ?? null }]))
        : { total: total ? closerPageFigures(total, currency) : null, rows: (data as PeopleClosers).rows.map(r => ({ userId: r.userId, teamMemberId: r.teamMemberId, ...closerPageFigures(r, currency) })) };
      break;
    }
    case "people.setters": case "people.dm_closers": case "people.lead_gen": {
      const row = raw as PeopleRoleReport;
      const role = row.role;
      const team = answer<PeopleRoleReport>(answers, `${id}.team`);
      data = { ...row, rows: orderRoleRows(row.rows) };
      figures = options.memberId ? Object.fromEntries(roleMemberFigures(role, row.rows.find(r => r.teamMemberId === options.memberId) ?? null, team?.rows ?? null, currency).map(f => [f.term ?? f.key, { value: f.value, teamMedian: f.teamMedian ?? null }]))
        : { rows: orderRoleRows(row.rows).map(r => ({ key: r.key, teamMemberId: r.teamMemberId, ...rolePageFigures(role, r, currency) })) };
      break;
    }
    case "attribution.lanes": {
      const row = raw as AttributionLanes;
      const role = options.role === "closers" ? "closer" : options.role === "setters" ? "setter" : options.role === "dm_closers" ? "dm_closer" : options.role;
      const views = laneViews(row, currency);
      const people = responsibleRows(row, currency).filter(r => !role || role === "everyone" || r.role === role);
      figures = { cash: row.totals.find(r => r.currency === currency)?.cashMinor ?? 0,
        lanes: views.map(v => ({ role: v.role, creditedCash: v.laneMinor, shared: v.sharedMinor, attributionCoverage: v.coverage, uncreditedCash: v.uncreditedMinor, peopleCash: v.peopleMinor,
          topFive: v.people.slice(0, 5).map(p => ({ key: p.key, name: p.name, creditedCash: p.amountMinor, dealCount: p.dealIds.length })) })),
        people: people.map(p => ({ key: p.key, rowKey: p.rowKey, name: p.name, role: p.role, teamMemberId: p.teamMemberId, linked: p.linked, creditedCash: p.amountMinor, dealCount: p.dealIds.length, dealIds: p.dealIds })) };
      data = { ...row, lanes: row.lanes.map(({ people: _people, ...lane }) => lane) };
      break;
    }
    case "attribution.paths": figures = { paths: pathRows(raw as AttributionPaths, currency).map(p => ({ ...p, cash: p.amountMinor, dealCount: p.dealIds.length })) }; data = { ...(raw as AttributionPaths), paths: pathRows(raw as AttributionPaths, currency) }; break;
    case "pipeline.now": figures = { openDeals: (raw as { stages: { count: number }[] }).stages.reduce((sum, row) => sum + row.count, 0) }; break;
  }
  // The member page displays the role figures above, not the builder's
  // intermediate roster row and distinct-ID sets a second time.
  if (options.memberId && ["people.closers", "people.setters", "people.dm_closers", "people.lead_gen"].includes(id)) {
    const { rows: _rows, ...detail } = data as Record<string, unknown>;
    data = detail;
  }
  if (id.startsWith("people.") && !options.memberId && id !== "people.members") {
    const reports = roleReports(answers);
    const members = answer<{ members: MemberProfile[] }>(answers, "people.members");
    if (members && reports.closers && reports.setters && reports.dmClosers && reports.leadGen) figures = { ...(figures as object), roleTabCounts: rosterCounts(members.members, reports as RoleReports) };
  }
  return { id, currency, data: options.currency ? selectCurrency(data, currency) : data, figures: options.currency ? selectCurrency(figures, currency) : figures };
}

/** Mirror the selected money column without ever combining currencies. */
function selectCurrency(value: unknown, currency: string): unknown {
  if (Array.isArray(value)) return value.filter(row => !row || typeof row !== "object" || !("currency" in row) || row.currency === currency).map(row => selectCurrency(row, currency));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, row]) => [key, selectCurrency(row, currency)]));
  return value;
}
