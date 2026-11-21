"use client";

import { useId, useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useNow } from "@/hooks/use-now";
import { CARD, CardHead, LABEL } from "@/app/workspace/team/_components/team-ui";
import { cn } from "@/lib/utils";
import {
  AUTOMATION_KINDS,
  BREAKER_WORDS,
  ageWords,
  type AutomationScorecard,
  type KindDefinition,
} from "./automation-kinds";
import { INLINE_FIGURE, QueueLine, SEGMENT, SEGMENT_GROUP } from "./automation-ui";

export const SCORECARD_WINDOWS = [7, 30, 90] as const;
type WindowDays = (typeof SCORECARD_WINDOWS)[number];

type PartialCount = { count: number; partial: boolean };
type Count = { count: number; capped: boolean } | PartialCount;
type ScoredKind = keyof AutomationScorecard["kinds"];
export type ScorecardKindStats = AutomationScorecard["kinds"][ScoredKind];
const DAY_MS = 86_400_000;

/** The scorecard's columns, in order. A later kind with other figures adds columns here. */
export const SCORECARD_COLUMNS: ReadonlyArray<{
  key: string;
  label: string;
  cell: (stats: ScorecardKindStats) => ReactNode;
}> = [
  { key: "proposed", label: "Proposed", cell: (stats) => <CountCell value={stats.proposed} /> },
  { key: "left", label: "Left for a person", cell: (stats) => <CountCell value={stats.leftForPerson} /> },
  { key: "graded", label: "Graded", cell: (stats) => <CountCell value={stats.graded} /> },
  { key: "wrong", label: "Wrong", cell: (stats) => <CountCell value={stats.wrong} /> },
  {
    key: "share",
    label: "Share",
    cell: (stats) => {
      const share = "shareOfPaidWhopPayments" in stats ? stats.shareOfPaidWhopPayments : stats.shareOfCallsDue;
      return share === null ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <span className={INLINE_FIGURE}>{Math.round(share * 100)}%</span>
      );
    },
  },
  { key: "corrected", label: "Corrected", cell: (stats) => <CountCell value={stats.corrected} /> },
];

function scorecardCountWords(value: Count) {
  const limited = "partial" in value ? value.partial : value.capped;
  return limited ? `${value.count} or more` : String(value.count);
}

function CountCell({ value }: { value: Count }) {
  return <span className={INLINE_FIGURE}>{scorecardCountWords(value)}</span>;
}

/** "Whop read 4 minutes ago", from the newer of the last webhook and the last check. */
function freshnessWords(freshness: AutomationScorecard["freshness"], now: number) {
  const last = Math.max(freshness.lastWebhookAt ?? 0, freshness.lastSuccessfulSweepAt ?? 0);
  if (last === 0) return "Whop not read yet";
  return `Whop read ${ageWords(last, now)} ago`;
}

/**
 * How each kind did in the window, then what is waiting on a person. Counts
 * shown with "or more" reached a read limit. The table scrolls inside its own frame on
 * a phone; while a new window loads, the old figures stay, dimmed.
 */
export function ScorecardCard({ kinds = AUTOMATION_KINDS }: { kinds?: readonly KindDefinition[] }) {
  const id = useId();
  const now = useNow();
  const [windowDays, setWindowDays] = useState<WindowDays>(30);
  const live = useQuery(api.automation.scorecard.getAutomationScorecard, { windowDays });
  const to = Math.floor(now / 60_000) * 60_000;
  const alerts = useQuery(api.automation.alert.getAlertMetrics, { from: to - windowDays * DAY_MS, to });
  const [kept, setKept] = useState<{ windowDays: WindowDays; data: AutomationScorecard } | null>(null);
  if (live !== undefined && (kept?.data !== live || kept.windowDays !== windowDays)) {
    setKept({ windowDays, data: live });
  }
  const shown = kept;
  const loading = live === undefined;

  return (
    <section aria-labelledby={`${id}-title`} className={cn(CARD, "@container/scorecard")}>
      <CardHead
        title={<span id={`${id}-title`}>Last {shown?.windowDays ?? windowDays} days</span>}
        meta={shown ? freshnessWords(shown.data.freshness, now) : undefined}
      >
        <ToggleGroup
          type="single"
          value={String(windowDays)}
          aria-label="Scorecard window"
          className={SEGMENT_GROUP}
          onValueChange={(next) => {
            if (next) setWindowDays(Number(next) as WindowDays);
          }}
        >
          {SCORECARD_WINDOWS.map((days) => (
            <ToggleGroupItem key={days} value={String(days)} className={SEGMENT}>
              {days} days
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </CardHead>

      {shown === null ? (
        <p role="status" className="px-4 py-3 text-[13px] text-muted-foreground">
          Loading the scorecard…
        </p>
      ) : (
        <div
          aria-busy={loading || undefined}
          className={cn("transition-opacity duration-200", loading && "opacity-60")}
        >
          <ScorecardBody data={shown.data} kinds={kinds} now={now} alerts={alerts} />
        </div>
      )}
    </section>
  );
}

type AlertMetrics = FunctionReturnType<typeof api.automation.alert.getAlertMetrics>;

function ScorecardBody({
  data,
  kinds,
  now,
  alerts,
}: {
  data: AutomationScorecard;
  kinds: readonly KindDefinition[];
  now: number;
  alerts: AlertMetrics | undefined;
}) {
  const waiting = data.paymentsWaiting;
  const ungraded = (["payment_win", "additional_payment"] as const).reduce(
    (sum, kind) => {
      const stats = data.kinds[kind].ungraded;
      return {
        count: sum.count + stats.count,
        capped: sum.capped || stats.capped,
        oldestAt:
          stats.oldestAt === null ? sum.oldestAt : Math.min(sum.oldestAt ?? stats.oldestAt, stats.oldestAt),
      };
    },
    { count: 0, capped: false, oldestAt: null as number | null },
  );
  const oldest = (at: number | null) => (at === null ? null : `oldest ${ageWords(at, now)}`);
  const showCallStats = kinds.some(({ kind }) => "shareOfCallsDue" in data.kinds[kind]);

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-left text-[13px]">
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className={cn(LABEL, "px-4 py-2 font-semibold")}>Kind</th>
              {SCORECARD_COLUMNS.map((column) => (
                <th key={column.key} scope="col" className={cn(LABEL, "px-3 py-2 text-right font-semibold")}>
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {kinds.map((definition) => {
              const stats = data.kinds[definition.kind];
              return (
                <tr key={definition.kind} className="h-11 border-b border-border">
                  <th scope="row" className="px-4 py-2 font-medium">{definition.shortName}</th>
                  {SCORECARD_COLUMNS.map((column) => (
                    <td key={column.key} className="px-3 py-2 text-right">
                      {column.cell(stats)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="px-4 pt-2 pb-2.5 text-[13px] leading-[1.45] text-muted-foreground">
        Share of paid Whop payments: of the{" "}
        <span className={INLINE_FIGURE}>{scorecardCountWords(data.paidWhopPayments)}</span>{" "}
        paid Whop payments in the window, the share the rule would have written. A dash when there were none or the
        count stopped early.
      </p>
      {showCallStats ? (
        <p className="px-4 pb-2.5 text-[13px] leading-[1.45] text-muted-foreground">
          The call share is the percentage of the{" "}
          <span className={INLINE_FIGURE}>{scorecardCountWords(data.callsDue)}</span>{" "}
          calls that came due and received a proposal for that kind.
        </p>
      ) : null}
      <dl>
        {showCallStats ? (
          <>
            <QueueLine term="Overdue automatic tasks" figure={scorecardCountWords(data.automaticTasksOverdue)}
              tone={data.automaticTasksOverdue.count ? "warning" : "muted"} />
            <QueueLine term="Automatic calls without a Second opinion"
              figure={scorecardCountWords(data.automaticCallsWithoutSecondOpinion)} />
          </>
        ) : null}
        <QueueLine
          term="Wins from Whop still waiting for attendance"
          figure={scorecardCountWords(data.winsAwaitingAttendance)}
          tone={data.winsAwaitingAttendance.count > 0 ? "warning" : "muted"}
        >
          {joinWords(
            oldest(data.winsAwaitingAttendance.oldestAt),
            data.winsAwaitingAttendance.count > 0 ? "each is missing from close rate and show rate until the closer taps" : null,
          )}
        </QueueLine>
        <QueueLine
          term="Whop payments waiting for a person"
          figure={scorecardCountWords(waiting)}
          tone={waiting.count > 0 ? "warning" : "muted"}
        >
          {waiting.count > 0
            ? joinWords(
                oldest(waiting.oldestAt),
                `${scorecardCountWords(waiting.billing)} in Billing, ${scorecardCountWords(waiting.closer)} with a closer`,
              )
            : null}
        </QueueLine>
        <QueueLine term="Ungraded payment proposals" figure={scorecardCountWords(ungraded)}>
          {oldest(ungraded.oldestAt)}
        </QueueLine>
        <QueueLine
          term={"Unanswered “This isn’t my sale” flags"}
          figure={scorecardCountWords(data.unansweredNotMySale)}
          tone={data.unansweredNotMySale.count > 0 ? "warning" : "muted"}
        />
        <QueueLine
          term="Automatic results waiting for a person's check"
          figure={scorecardCountWords(data.auditQueue)}
          tone={data.auditQueue.count > 0 ? "warning" : "muted"}
        >
          {oldest(data.auditQueue.oldestAt)}
        </QueueLine>
        <QueueLine
          term="Kinds back at one tap"
          figure={String(data.breakers.length)}
          tone={data.breakers.length > 0 ? "warning" : "muted"}
        >
          {data.breakers.length
            ? data.breakers
                .map((breaker) => `${AUTOMATION_KINDS.find((row) => row.kind === breaker.kind)?.shortName}: ${BREAKER_WORDS[breaker.reason]}`)
                .join(" · ")
            : null}
        </QueueLine>
        {alerts ? (
          <>
            <QueueLine
              term="Paid-on-call alerts, false alarms"
              figure={`${alerts.falseAlarms}${alerts.capped ? "+" : ""}`}
            >
              of {alerts.wouldRaise}{alerts.capped ? "+" : ""} it would have raised; a payment arrived within 7 days
            </QueueLine>
            <QueueLine
              term="Paid-on-call alerts still open"
              figure={`${alerts.open}${alerts.capped ? "+" : ""}`}
              tone={alerts.over24Hours > 0 ? "warning" : "muted"}
            >
              {alerts.over24Hours > 0 ? `${alerts.over24Hours} open for more than 24 hours` : null}
            </QueueLine>
          </>
        ) : null}
      </dl>
      {showCallStats && (data.closerActivity.rows.length > 0 || data.closerActivity.partial) ? (
        <CloserActivity activity={data.closerActivity} />
      ) : null}
      <AutomaticWritesTable data={data} />
    </>
  );
}

/** Results each kind recorded by itself in the window, and whether it is back at one tap. */
function CloserActivity({ activity }: { activity: AutomationScorecard["closerActivity"] }) {
  return (
    <div className="overflow-x-auto border-t border-border">
      <table className="w-full min-w-[32rem] text-left text-[13px]">
        <caption className={cn(LABEL, "px-4 py-2 text-left font-semibold")}>Closer activity</caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className="px-4 py-2">Closer</th>
            <th scope="col" className="px-3 py-2 text-right">Stops</th>
            <th scope="col" className="px-3 py-2 text-right">Unacknowledged refusal notices</th>
            <th scope="col" className="px-3 py-2 text-right">Stopped refusal notices</th>
          </tr>
        </thead>
        <tbody>
          {activity.rows.map((row) => (
            <tr key={row.closerId} className="border-b border-border">
              <th scope="row" className="px-4 py-2 font-medium">{row.name}</th>
              <td className="px-3 py-2 text-right"><CountCell value={row.stops} /></td>
              <td className="px-3 py-2 text-right"><CountCell value={row.unacknowledgedRefusalNotices} /></td>
              <td className="px-3 py-2 text-right"><CountCell value={row.stoppedRefusalNotices} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {activity.partial ? (
        <p className="px-4 py-2 text-[13px] text-muted-foreground">Some closer activity may be missing.</p>
      ) : null}
    </div>
  );
}

function AutomaticWritesTable({ data }: { data: AutomationScorecard }) {
  return (
    <div className="overflow-x-auto border-t border-border">
      <table className="w-full min-w-[28rem] text-left text-[13px]">
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className={cn(LABEL, "px-4 py-2 font-semibold")}>Kind</th>
            <th scope="col" className={cn(LABEL, "px-3 py-2 text-right font-semibold")}>Recorded by itself</th>
            <th scope="col" className={cn(LABEL, "px-4 py-2 font-semibold")}>Now</th>
          </tr>
        </thead>
        <tbody>
          {AUTOMATION_KINDS.map((definition) => {
            const writes = data.automaticWrites[definition.kind];
            const breaker = data.breakers.find((row) => row.kind === definition.kind);
            return (
              <tr key={definition.kind} className="h-11 border-b border-border last:border-b-0">
                <th scope="row" className="px-4 py-2 font-medium">{definition.shortName}</th>
                <td className="px-3 py-2 text-right">
                  <span className={INLINE_FIGURE}>{scorecardCountWords(writes)}</span>
                </td>
                <td className={cn("px-4 py-2", breaker ? "text-warning-ink" : "text-muted-foreground")}>
                  {breaker ? "Back at one tap" : "Not stopped"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function joinWords(...parts: Array<string | null>) {
  const words = parts.filter((part): part is string => Boolean(part));
  return words.length ? words.join(" · ") : null;
}
