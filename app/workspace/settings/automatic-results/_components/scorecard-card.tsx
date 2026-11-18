"use client";

import { useId, useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useNow } from "@/hooks/use-now";
import { CARD, CardHead, LABEL } from "@/app/workspace/team/_components/team-ui";
import { cn } from "@/lib/utils";
import {
  AUTOMATION_KINDS,
  ageWords,
  countWords,
  type AutomationScorecard,
  type KindDefinition,
} from "./automation-kinds";
import { INLINE_FIGURE, QueueLine, SEGMENT, SEGMENT_GROUP } from "./automation-ui";

export const SCORECARD_WINDOWS = [7, 30, 90] as const;
type WindowDays = (typeof SCORECARD_WINDOWS)[number];

type Count = { count: number; capped: boolean };
export type ScorecardKindStats = AutomationScorecard["kinds"][keyof AutomationScorecard["kinds"]];

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
    label: "Share of paid Whop payments",
    cell: (stats) =>
      stats.shareOfPaidWhopPayments === null ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <span className={INLINE_FIGURE}>{Math.round(stats.shareOfPaidWhopPayments * 100)}%</span>
      ),
  },
  { key: "corrected", label: "Corrected", cell: (stats) => <CountCell value={stats.corrected} /> },
];

function CountCell({ value }: { value: Count }) {
  return <span className={INLINE_FIGURE}>{countWords(value.count, value.capped)}</span>;
}

/** "Whop read 4 minutes ago", from the newer of the last webhook and the last check. */
function freshnessWords(freshness: AutomationScorecard["freshness"], now: number) {
  const last = Math.max(freshness.lastWebhookAt ?? 0, freshness.lastSuccessfulSweepAt ?? 0);
  if (last === 0) return "Whop not read yet";
  return `Whop read ${ageWords(last, now)} ago`;
}

/**
 * How each kind did in the window, then what is waiting on a person. Counts
 * the server stopped at read "N+". The table scrolls inside its own frame on
 * a phone; while a new window loads, the old figures stay, dimmed.
 */
export function ScorecardCard({ kinds = AUTOMATION_KINDS }: { kinds?: readonly KindDefinition[] }) {
  const id = useId();
  const now = useNow();
  const [windowDays, setWindowDays] = useState<WindowDays>(30);
  const live = useQuery(api.automation.scorecard.getAutomationScorecard, { windowDays });
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
          <ScorecardBody data={shown.data} kinds={kinds} now={now} />
        </div>
      )}
    </section>
  );
}

function ScorecardBody({
  data,
  kinds,
  now,
}: {
  data: AutomationScorecard;
  kinds: readonly KindDefinition[];
  now: number;
}) {
  const waiting = data.paymentsWaiting;
  const ungraded = kinds.reduce(
    (sum, definition) => {
      const stats = data.kinds[definition.kind].ungraded;
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
        <span className={INLINE_FIGURE}>{countWords(data.paidWhopPayments.count, data.paidWhopPayments.capped)}</span>{" "}
        paid Whop payments in the window, the share the rule would have written. A dash when there were none or the
        count stopped early.
      </p>
      <dl>
        <QueueLine
          term="Wins from Whop still waiting for attendance"
          figure={countWords(data.winsAwaitingAttendance.count, data.winsAwaitingAttendance.capped)}
          tone={data.winsAwaitingAttendance.count > 0 ? "warning" : "muted"}
        >
          {joinWords(
            oldest(data.winsAwaitingAttendance.oldestAt),
            data.winsAwaitingAttendance.count > 0 ? "each is missing from close rate and show rate until the closer taps" : null,
          )}
        </QueueLine>
        <QueueLine
          term="Whop payments waiting for a person"
          figure={countWords(waiting.count, waiting.capped)}
          tone={waiting.count > 0 ? "warning" : "muted"}
        >
          {waiting.count > 0
            ? joinWords(
                oldest(waiting.oldestAt),
                `${countWords(waiting.billing.count, waiting.billing.capped)} in Billing, ${countWords(waiting.closer.count, waiting.closer.capped)} with a closer`,
              )
            : null}
        </QueueLine>
        <QueueLine term="Ungraded proposals" figure={countWords(ungraded.count, ungraded.capped)}>
          {oldest(ungraded.oldestAt)}
        </QueueLine>
        <QueueLine
          term={"Unanswered “This isn’t my sale” flags"}
          figure={countWords(data.unansweredNotMySale.count, data.unansweredNotMySale.capped)}
          tone={data.unansweredNotMySale.count > 0 ? "warning" : "muted"}
        />
      </dl>
    </>
  );
}

function joinWords(...parts: Array<string | null>) {
  const words = parts.filter((part): part is string => Boolean(part));
  return words.length ? words.join(" · ") : null;
}
