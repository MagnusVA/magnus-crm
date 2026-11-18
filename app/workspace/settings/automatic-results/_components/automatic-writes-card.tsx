"use client";

import { useId, useState } from "react";
import dynamic from "next/dynamic";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { dayTimeFormat } from "@/components/whop/whop-settings-parts";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { CARD, CardHead } from "@/app/workspace/team/_components/team-ui";
import { NoteLine } from "@/app/workspace/settings/_components/settings-ui";
import { cn } from "@/lib/utils";
import { AUTOMATION_KINDS, kindDefinition, type AutomationKind } from "./automation-kinds";
import { SEGMENT, SEGMENT_GROUP } from "./automation-ui";
import { PersonName, RecordLinks } from "./record-links";
import type { AutomaticWrite } from "./undo-dialog";

const UndoDialog = dynamic(() => import("./undo-dialog"));

const WINDOWS = [7, 30, 90] as const;
type WindowDays = (typeof WINDOWS)[number];
const ALL = "all";

/**
 * Everything the CRM recorded by itself in the window, newest first. Each row
 * says what was recorded, for whom and when, and offers Undo while nobody has
 * worked on the deal since; a touched row points to the reviewed correction.
 */
export function AutomaticWritesCard({ canUndo }: { canUndo: boolean }) {
  const id = useId();
  const [days, setDays] = useState<WindowDays>(7);
  const [kind, setKind] = useState<AutomationKind | typeof ALL>(ALL);
  const [undoing, setUndoing] = useState<AutomaticWrite | null>(null);
  const list = useQuery(api.automation.undo.listAutomaticWrites, kind === ALL ? { days } : { days, kind });

  return (
    <section aria-labelledby={`${id}-title`} className={cn(CARD, "@container/writes")}>
      <CardHead
        title={<span id={`${id}-title`}>Everything it recorded by itself</span>}
        meta={`Last ${days} days, newest first`}
      />
      <div className="flex flex-col gap-2 border-b border-border px-4 py-2.5 @2xl/writes:flex-row @2xl/writes:items-center @2xl/writes:justify-between">
        <ToggleGroup
          type="single"
          value={String(days)}
          aria-label="Window"
          className={SEGMENT_GROUP}
          onValueChange={(next) => {
            if (next) setDays(Number(next) as WindowDays);
          }}
        >
          {WINDOWS.map((value) => (
            <ToggleGroupItem key={value} value={String(value)} className={SEGMENT}>
              {value} days
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="flex items-center gap-2">
          <label htmlFor={`${id}-kind`} className="text-[13px] text-muted-foreground">Kind</label>
          <Select value={kind} onValueChange={(value) => setKind(value as AutomationKind | typeof ALL)}>
            <SelectTrigger id={`${id}-kind`} size="sm" className="w-56 max-w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL}>Every kind</SelectItem>
                {AUTOMATION_KINDS.map((definition) => (
                  <SelectItem key={definition.kind} value={definition.kind}>
                    {definition.shortName}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </div>

      {list === undefined ? (
        <p role="status" className="px-4 py-3 text-[13px] text-muted-foreground">Loading…</p>
      ) : list.writes.length === 0 ? (
        <SectionEmpty title={`Nothing was recorded by itself in the last ${days} days.`}>
          A kind records by itself only once the owner switches it to Automatic.
        </SectionEmpty>
      ) : (
        <>
          <ul>
            {list.writes.map((write) => (
              <li key={write.decisionId} className="border-t border-border first:border-t-0">
                <WriteRow write={write} canUndo={canUndo} onUndo={() => setUndoing(write)} />
              </li>
            ))}
          </ul>
          {list.capped ? (
            <NoteLine className="border-t border-border px-4 py-2.5">
              Showing the newest 100. Pick a shorter window or one kind to see the rest.
            </NoteLine>
          ) : null}
        </>
      )}
      {undoing ? <UndoDialog write={undoing} onClose={() => setUndoing(null)} /> : null}
    </section>
  );
}

function WriteRow({ write, canUndo, onUndo }: { write: AutomaticWrite; canUndo: boolean; onUndo: () => void }) {
  const definition = kindDefinition(write.kind);
  return (
    <div className="flex flex-col gap-2 px-4 py-3 @2xl/writes:flex-row @2xl/writes:items-start @2xl/writes:justify-between">
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-[13px] leading-[1.45]">
          <span className="font-semibold">{definition.recordedWords}</span>
          <span className="text-muted-foreground"> for </span>
          <PersonName leadId={write.leadId} />
        </p>
        <p className="text-[13px] text-muted-foreground">
          {definition.shortName} · <span className="tabular-nums">{dayTimeFormat.format(write.writtenAt)}</span>
          {write.auditOpenDueAt !== undefined ? (
            <>
              {" "}· Waiting for a person&apos;s check by{" "}
              <span className="tabular-nums">{dayTimeFormat.format(write.auditOpenDueAt)}</span>
            </>
          ) : null}
        </p>
        <RecordLinks
          opportunityId={write.opportunityId}
          meetingId={write.meetingId}
          providerPaymentId={write.providerPaymentId}
          paymentRecordId={write.paymentRecordId}
        />
      </div>
      <div className="flex shrink-0 flex-col gap-1 @2xl/writes:max-w-64 @2xl/writes:items-end @2xl/writes:text-right">
        {write.untouched ? (
          <>
            <Button type="button" size="sm" variant="outline" disabled={!canUndo} onClick={onUndo}>
              {write.kind === "refusal_loss" ? "Reopen" : "Undo"}
            </Button>
            {canUndo ? null : <NoteLine>Only an owner or admin can undo this.</NoteLine>}
          </>
        ) : (
          <NoteLine>Changed by a person since. Use the correction on the payment or the meeting.</NoteLine>
        )}
      </div>
    </div>
  );
}
