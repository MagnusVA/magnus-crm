"use client";

import type { ReactNode } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { DetailCard } from "@/app/workspace/closer/meetings/_components/detail-card";
import { personDate } from "@/app/workspace/leads-customers/[leadId]/_components/person-format";
import { LABEL } from "@/app/workspace/team/_components/team-ui";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { incomeLine, resolutionWord } from "@/lib/callInsights/display";
import { callCount } from "@/lib/callInsights/report-display";
import { cn } from "@/lib/utils";

const DM_INCOME = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

const CHIP =
  "inline-flex h-5 shrink-0 items-center rounded-[4px] px-1.5 text-xs font-semibold whitespace-nowrap";

/**
 * "From their calls" on the person page: the objections, struggles, goals
 * and income their read calls found, counted across calls. No quotes here.
 * Renders nothing while loading, when the viewer can't see it, or when no
 * call was read yet.
 */
export function PersonCallsSection({ leadId }: { leadId: Id<"leads"> }) {
  const { isAuthenticated } = useConvexAuth();
  const data = useQuery(
    api.callInsights.queries.forPerson,
    isAuthenticated ? { leadId } : "skip",
  );
  const { setting } = useBusinessDay();
  const now = useNow();

  if (!data || data.callsRead === 0) return null;

  const dmIncome = data.dmReportedIncome;
  const showIncome = data.income.length > 0 || dmIncome !== undefined;

  return (
    // The person's income and categories come from their own words: kept out of session replay.
    <DetailCard
      title="From their calls"
      meta={`From ${callCount(data.callsRead)}`}
      className="ph-no-capture"
    >
      {data.objections.length > 0 ? (
        <Group label="Objections">
          {data.objections.map((row) => (
            <Row
              key={row.category}
              label={row.label}
              badges={
                <>
                  {row.wasPrimary ? (
                    <span
                      className={cn(
                        CHIP,
                        "border border-border text-foreground",
                      )}
                    >
                      Main
                    </span>
                  ) : null}
                  {resolutionWord(row.lastResolution) ? (
                    <span
                      className={cn(
                        CHIP,
                        "bg-muted",
                        row.lastResolution === "unresolved"
                          ? "text-foreground"
                          : "text-muted-foreground",
                      )}
                    >
                      {resolutionWord(row.lastResolution)}
                    </span>
                  ) : null}
                </>
              }
              meta={`${callCount(row.calls)} · last ${personDate(row.lastAt, setting, now)}`}
            />
          ))}
        </Group>
      ) : null}
      {data.struggles.length > 0 ? (
        <Group label="Struggles">
          {data.struggles.map((row) => (
            <Row
              key={row.category}
              label={row.label}
              meta={callCount(row.calls)}
            />
          ))}
        </Group>
      ) : null}
      {data.goals.length > 0 ? (
        <Group label="Goals">
          {data.goals.map((row) => (
            <Row
              key={row.category}
              label={row.label}
              meta={callCount(row.calls)}
            />
          ))}
        </Group>
      ) : null}
      {showIncome ? (
        <Group label="Income">
          {data.income.map((row, index) => (
            <Row
              key={`${row.kind}:${row.at}:${index}`}
              label={incomeLine(row)}
              badges={
                row.check === "unsure" ? (
                  <span className={cn(CHIP, "bg-muted text-muted-foreground")}>
                    Not confirmed
                  </span>
                ) : null
              }
              meta={personDate(row.at, setting, now)}
            />
          ))}
          {data.income.length === 0 ? (
            <li className="px-4 py-2 text-sm text-muted-foreground">
              No income was stated on a read call.
            </li>
          ) : null}
          {dmIncome !== undefined ? (
            <li className="px-4 py-2 text-[13px] text-muted-foreground">
              Reported in DMs:{" "}
              <span className="font-condensed text-[15px] font-semibold tabular-nums">
                {DM_INCOME.format(dmIncome)}
              </span>
            </li>
          ) : null}
        </Group>
      ) : null}
    </DetailCard>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="border-b pt-2.5 last:border-b-0">
      <h3 className={cn(LABEL, "px-4 pb-1")}>{label}</h3>
      <ul className="divide-y">{children}</ul>
    </section>
  );
}

function Row({
  label,
  badges,
  meta,
}: {
  label: string;
  badges?: ReactNode;
  meta?: string;
}) {
  return (
    <li className="flex min-h-10 flex-wrap items-center gap-x-2 gap-y-0.5 px-4 py-2">
      <span className="text-sm font-medium">{label}</span>
      {badges}
      {meta ? (
        <span className="ml-auto text-[13px] whitespace-nowrap text-muted-foreground">
          {meta}
        </span>
      ) : null}
    </li>
  );
}
