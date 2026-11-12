"use client";

import type { ReactNode } from "react";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { moneyFigure, resolutionWord } from "@/lib/callInsights/display";
import { callCount } from "@/lib/callInsights/report-display";
import {
  DetailCard,
  DetailCardFooter,
} from "@/app/workspace/closer/meetings/_components/detail-card";
import {
  InsightChips,
  InsightFigure,
  InsightGroup,
  InsightList,
  InsightTag,
  InsightUnit,
  StatusWord,
} from "./insight-parts";
import { Chip } from "./item-rows";

export type PersonInsights = NonNullable<
  FunctionReturnType<typeof api.callInsights.queries.forPerson>
>;

const DM_INCOME = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/**
 * "From their calls" on the person page: income as figures, then the
 * objections, struggles and goals their read calls found, counted across
 * calls. No quotes here; those are on each call's page.
 */
export function PersonCallsView({
  data,
  dateOf,
}: {
  data: PersonInsights;
  /** A day in the tenant's business days, such as "Nov 3". */
  dateOf: (at: number) => string;
}) {
  const dmIncome = data.dmReportedIncome;
  const several = data.callsRead > 1;
  const nothing =
    data.income.length === 0 &&
    dmIncome === undefined &&
    data.objections.length === 0 &&
    data.struggles.length === 0 &&
    data.goals.length === 0;
  return (
    <DetailCard
      title="From their calls"
      badge={<Chip>Machine-read</Chip>}
      meta={`${callCount(data.callsRead)} read`}
      className="ph-no-capture"
    >
      {nothing ? (
        <p className="p-4 text-sm text-muted-foreground">
          Nothing to list from {several ? "these calls" : "this call"}: the
          prospect stated no objection, struggle, goal or income.
        </p>
      ) : null}
      <InsightList>
        {data.income.length > 0 || dmIncome !== undefined ? (
          <InsightGroup label="Income">
            <div className="flex flex-col gap-2">
              {data.income.map((row, index) => {
                const money = moneyFigure(row);
                const what = [
                  money?.unit,
                  row.label.toLowerCase(),
                  row.scenario === "target" ? "target" : null,
                ]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <div key={`${row.kind}:${row.at}:${index}`}>
                    <div className="flex flex-wrap items-baseline gap-x-2.5">
                      {money ? (
                        <>
                          <InsightFigure>{money.figure}</InsightFigure>
                          <InsightUnit>
                            {what}
                            <span className="text-muted-foreground">
                              {row.currency ? "" : " · currency not stated"} ·
                              said {dateOf(row.at)}
                            </span>
                          </InsightUnit>
                        </>
                      ) : (
                        <span className="text-sm font-medium">{row.label}</span>
                      )}
                      {row.check === "unsure" ? (
                        <StatusWord tone="unsure">Not confirmed</StatusWord>
                      ) : null}
                    </div>
                  </div>
                );
              })}
              {data.income.length === 0 ? (
                <p className="pt-1 text-sm text-muted-foreground">
                  No income was stated on a read call.
                </p>
              ) : null}
              {dmIncome !== undefined ? (
                <p className="text-[0.8125rem] text-muted-foreground">
                  Told the DM team{" "}
                  <span className="font-condensed text-[0.9375rem] font-semibold text-foreground tabular-nums">
                    {DM_INCOME.format(dmIncome)}
                  </span>
                </p>
              ) : null}
            </div>
          </InsightGroup>
        ) : null}
        {data.objections.length > 0 ? (
          <InsightGroup label="Objections">
            <InsightChips>
              {data.objections.map((row) => {
                const word = resolutionWord(row.lastResolution);
                const words = [word, row.wasPrimary ? "Main" : null].filter(
                  Boolean,
                );
                return (
                  <InsightTag
                    key={row.category}
                    status={
                      <>
                        {words.length > 0 ? (
                          <StatusWord
                            tone={
                              word === "Resolved"
                                ? "resolved"
                                : word === "Open"
                                  ? "open"
                                  : "muted"
                            }
                          >
                            {words.join(" · ")}
                          </StatusWord>
                        ) : null}
                        <StatusWord tone="muted">
                          {several ? `${callCount(row.calls)} · ` : ""}
                          last {dateOf(row.lastAt)}
                        </StatusWord>
                      </>
                    }
                  >
                    {row.label}
                  </InsightTag>
                );
              })}
            </InsightChips>
          </InsightGroup>
        ) : null}
        {data.struggles.length > 0 ? (
          <InsightGroup label="Struggles">
            <InsightChips>
              {data.struggles.map((row) => (
                <InsightTag
                  key={row.category}
                  status={<Times calls={row.calls} show={several} />}
                >
                  {row.label}
                </InsightTag>
              ))}
            </InsightChips>
          </InsightGroup>
        ) : null}
        {data.goals.length > 0 ? (
          <InsightGroup label="Goals">
            <InsightChips>
              {data.goals.map((row) => (
                <InsightTag
                  key={row.category}
                  status={<Times calls={row.calls} show={several} />}
                >
                  {row.label}
                </InsightTag>
              ))}
            </InsightChips>
          </InsightGroup>
        ) : null}
      </InsightList>
      <DetailCardFooter className="font-normal">
        <span className="text-[0.8125rem]">
          Read by Claude, checked by Jev.
          {nothing ? "" : " Quotes are on each call's page."}
        </span>
      </DetailCardFooter>
    </DetailCard>
  );
}

/** "2 calls" on a chip, shown only when the person has more than one read call. */
function Times({ calls, show }: { calls: number; show: boolean }): ReactNode {
  return show ? <StatusWord tone="muted">{callCount(calls)}</StatusWord> : null;
}
