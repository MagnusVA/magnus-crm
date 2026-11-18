"use client";

import { useId, useState } from "react";
import dynamic from "next/dynamic";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { dayTimeFormat } from "@/components/whop/whop-settings-parts";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { CARD, CardHead } from "@/app/workspace/team/_components/team-ui";
import { NoteLine, StatusWord } from "@/app/workspace/settings/_components/settings-ui";
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";
import { ageWords } from "./automation-kinds";
import { panelCommandSentence } from "./automation-command-words";
import { INLINE_FIGURE } from "./automation-ui";
import { RecordLinks } from "./record-links";
import type { ConfirmChange } from "./confirm-change-dialog";

const ConfirmChangeDialog = dynamic(() => import("./confirm-change-dialog"));

type Notice = FunctionReturnType<typeof api.automation.notice.listNotices>["notices"][number];

/**
 * Pending losses across closers: refusals the CRM will close as lost once
 * the notice has been seen and its hours have passed. Unseen ones come first,
 * oldest first, with their age; an owner or admin can take responsibility
 * for one, which starts its clock. Stop lives on the meeting page.
 * With `show` false (refusals not at Automatic) the card hides while empty.
 */
export function NoticesCard({ show }: { show: boolean }) {
  const id = useId();
  const now = useNow();
  const list = useQuery(api.automation.notice.listNotices, {});
  const acknowledge = useMutation(api.automation.notice.acknowledgeNotice);
  const [confirm, setConfirm] = useState<ConfirmChange | null>(null);
  if (list === undefined) return show ? <LoadingCard id={id} /> : null;
  if (!show && list.notices.length === 0) return null;

  const unseen = list.notices.filter((notice) => notice.acknowledgedAt === undefined).sort((a, b) => a.createdAt - b.createdAt);
  const seen = list.notices.filter((notice) => notice.acknowledgedAt !== undefined).sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0));
  const perCloser = new Map<string, number>();
  for (const notice of unseen) {
    const name = notice.closerName ?? "A closer no longer on the team";
    perCloser.set(name, (perCloser.get(name) ?? 0) + 1);
  }

  const requestTake = (notice: Notice) => {
    setConfirm({
      title: `Take responsibility for ${notice.personName ?? "this person"}'s notice?`,
      description: `The deal closes as lost ${notice.noticeHours} hours from now unless someone stops it. The notice records that you saw it, in place of the closer.`,
      note: "The closer can still stop it from the meeting until then.",
      confirmLabel: "Take responsibility",
      pendingLabel: "Saving…",
      danger: true,
      run: async () => {
        const result = await acknowledge({ decisionId: notice.decisionId });
        if (!result.ok) throw new Error(panelCommandSentence(result.code));
        toast.success("You took responsibility. The clock has started.");
      },
    });
  };

  return (
    <section aria-labelledby={`${id}-title`} className={cn(CARD, "@container/notices")}>
      <CardHead
        title={<span id={`${id}-title`}>Pending losses</span>}
        meta="Refusals the CRM will close as lost after their notice. Nothing closes until someone has seen it."
      />
      {list.notices.length === 0 ? (
        <SectionEmpty title="No refusal is waiting to close." />
      ) : (
        <>
          {perCloser.size ? (
            <NoteLine className="border-b border-border px-4 py-2">
              Not seen yet:{" "}
              {[...perCloser.entries()].map(([name, count], index) => (
                <span key={name}>
                  {index ? ", " : ""}
                  <span translate="no">{name}</span> <span className={INLINE_FIGURE}>{count}</span>
                </span>
              ))}
            </NoteLine>
          ) : null}
          <ul>
            {[...unseen, ...seen].map((notice) => (
              <li key={notice.decisionId} className="border-t border-border first:border-t-0">
                <NoticeRow notice={notice} now={now} onTake={() => requestTake(notice)} />
              </li>
            ))}
          </ul>
          {list.capped ? (
            <NoteLine className="border-t border-border px-4 py-2.5">Showing the first 100.</NoteLine>
          ) : null}
        </>
      )}
      <StoppedNotices />
      {confirm ? <ConfirmChangeDialog request={confirm} onClose={() => setConfirm(null)} /> : null}
    </section>
  );
}

/**
 * Refusals a person stopped. A stopped loss is never proposed again for the
 * same call until it is released; Release lets a new reading propose it again.
 */
function StoppedNotices() {
  const id = useId();
  const release = useMutation(api.automation.notice.releaseVeto);
  const [confirm, setConfirm] = useState<ConfirmChange | null>(null);
  const { results, status, loadMore } = usePaginatedQuery(
    api.automation.callDecisions.listCallProposals,
    { kind: "refusal_loss", state: "stopped" },
    { initialNumItems: 25 },
  );
  const stopped = results.filter((row) => row.stopCode === "person_stop" && row.vetoReleasedAt === undefined);
  if (status === "LoadingFirstPage" || (stopped.length === 0 && status === "Exhausted")) return null;

  const requestRelease = (row: (typeof stopped)[number]) => {
    setConfirm({
      title: `Release the stop on ${row.personName}?`,
      description: "The same loss can be proposed again after a new reading of the call. Nothing changes now.",
      note: "A person stopped this refusal. Release it only when that stop no longer holds.",
      confirmLabel: "Release",
      pendingLabel: "Releasing…",
      danger: true,
      run: async () => {
        const result = await release({ decisionId: row._id });
        if (!result.ok) throw new Error(panelCommandSentence(result.code));
        toast.success("Released. A new reading can propose it again.");
      },
    });
  };

  return (
    <section aria-labelledby={`${id}-title`} className="border-t border-border">
      <h3 id={`${id}-title`} className="bg-background px-4 py-2.5 text-[13px] font-semibold">Stopped by a person</h3>
      <ul>
        {stopped.map((row) => (
          <li key={row._id} className="flex flex-col gap-2 border-t border-border px-4 py-3 @2xl/notices:flex-row @2xl/notices:items-start @2xl/notices:justify-between">
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="text-[13px]">
                <span className="font-semibold" translate="no">{row.personName}</span>
                <span className="text-muted-foreground"> · <span translate="no">{row.closerName ?? "No closer"}</span></span>
              </p>
              <p className="text-[13px] text-muted-foreground">
                {row.resolvedAt !== undefined ? (
                  <>
                    Stopped <span className="tabular-nums">{dayTimeFormat.format(row.resolvedAt)}</span>.
                  </>
                ) : (
                  "Stopped."
                )}{" "}
                It stays stopped until released.
              </p>
              <RecordLinks opportunityId={row.opportunityId} meetingId={row.meetingId} />
            </div>
            <Button type="button" size="sm" variant="outline" className="self-start" onClick={() => requestRelease(row)}>
              Release
            </Button>
          </li>
        ))}
      </ul>
      {status === "CanLoadMore" ? (
        <div className="border-t border-border px-4 py-2.5">
          <Button type="button" size="sm" variant="outline" onClick={() => loadMore(25)}>
            Show older
          </Button>
        </div>
      ) : null}
      {confirm ? <ConfirmChangeDialog request={confirm} onClose={() => setConfirm(null)} /> : null}
    </section>
  );
}

function NoticeRow({ notice, now, onTake }: { notice: Notice; now: number; onTake: () => void }) {
  const unseen = notice.acknowledgedAt === undefined;
  return (
    <div className="flex flex-col gap-2 px-4 py-3 @2xl/notices:flex-row @2xl/notices:items-start @2xl/notices:justify-between">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <StatusWord tone={unseen ? "warning" : "muted"}>{unseen ? "Not seen" : "Seen"}</StatusWord>
          <p className="text-[13px] font-semibold" translate="no">{notice.personName ?? "Unnamed person"}</p>
          <p className="text-[13px] text-muted-foreground">
            · <span translate="no">{notice.closerName ?? "A closer no longer on the team"}</span>
          </p>
        </div>
        <p className="text-[13px] text-muted-foreground">
          Refused on the call of <span className="tabular-nums">{dayTimeFormat.format(notice.callAt)}</span>.
        </p>
        {unseen ? (
          <p className="text-[13px]">
            Waiting <span className={INLINE_FIGURE}>{ageWords(notice.createdAt, now)}</span> for someone to see it.
            <span className="text-muted-foreground"> Closes {notice.noticeHours} hours after that.</span>
          </p>
        ) : (
          <p className="text-[13px]">
            Seen <span className="tabular-nums">{dayTimeFormat.format(notice.acknowledgedAt as number)}</span>
            {notice.dueAt !== undefined ? (
              <>
                {" "}· closes as lost <span className={INLINE_FIGURE}>{dayTimeFormat.format(notice.dueAt)}</span>
              </>
            ) : null}
          </p>
        )}
        <RecordLinks opportunityId={notice.opportunityId} meetingId={notice.meetingId} />
      </div>
      <div className="flex shrink-0 flex-col gap-1 @2xl/notices:max-w-64 @2xl/notices:items-end @2xl/notices:text-right">
        {unseen ? (
          <Button type="button" size="sm" variant="outline" onClick={onTake}>
            Take responsibility
          </Button>
        ) : null}
        <NoteLine>To stop it, open the meeting.</NoteLine>
      </div>
    </div>
  );
}

function LoadingCard({ id }: { id: string }) {
  return (
    <section aria-labelledby={`${id}-title`} className={CARD}>
      <CardHead title={<span id={`${id}-title`}>Pending losses</span>} />
      <p role="status" className="px-4 py-3 text-[13px] text-muted-foreground">Loading…</p>
    </section>
  );
}
