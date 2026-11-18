"use client";

import { useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { TranslatableText } from "@/components/translatable-text";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { CARD, CardHead } from "@/app/workspace/team/_components/team-ui";
import { NoteLine, StatusWord } from "@/app/workspace/settings/_components/settings-ui";
import {
  AUTOMATION_KINDS,
  LEVELS,
  LOWER_WORDS,
  countWords,
  levelDefinition,
  levelRank,
  type AutomationKind,
  type AutomationSettingsView,
  type KindDefinition,
  type Level,
  type StoredLevel,
} from "./automation-kinds";
import { INLINE_FIGURE, LevelControl, SEGMENT, SEGMENT_GROUP } from "./automation-ui";
import type { ConfirmChange } from "./confirm-change-dialog";

const ConfirmChangeDialog = dynamic(() => import("./confirm-change-dialog"));

type Running = "running" | "paused";

/**
 * The switches: Everything (Paused or Running), then one row per kind with its
 * level and its graded record. Every change asks once and says what changes.
 * Raising needs `canRaise` (the owner); lowering and pausing need `canLower`.
 */
export function ControlsCard({
  view,
  whopConnected,
  canGrade,
}: {
  view: AutomationSettingsView;
  whopConnected: boolean;
  canGrade: boolean;
}) {
  const setEnabled = useMutation(api.automation.settings.setEnabled);
  const setKindMode = useMutation(api.automation.settings.setKindMode);
  const [confirm, setConfirm] = useState<ConfirmChange | null>(null);
  const { configured, canRaise, canLower } = view;
  const running = configured?.enabled === true;

  const modeOf = (kind: AutomationKind): StoredLevel => configured?.kinds[kind]?.mode ?? "off";

  const requestRunning = (next: Running) => {
    if (next === "paused") {
      setConfirm({
        title: "Pause everything?",
        description:
          "Every automatic write and every pending proposal stops at once. Whop intake and manual recording keep running.",
        note: "Nothing resumes by itself.",
        confirmLabel: "Pause everything",
        pendingLabel: "Pausing…",
        danger: true,
        run: async () => {
          await setEnabled({ enabled: false });
          toast.success("Automatic results are paused.");
        },
      });
      return;
    }
    const levels = AUTOMATION_KINDS.map(
      (definition) => `${definition.shortName} at ${levelDefinition(modeOf(definition.kind)).label}`,
    ).join(", ");
    setConfirm({
      title: "Set everything running?",
      description: `Each kind runs at its own level: ${levels}.`,
      note: "Proposals cancelled by the pause stay cancelled.",
      confirmLabel: "Set running",
      pendingLabel: "Saving…",
      run: async () => {
        await setEnabled({ enabled: true });
        toast.success("Automatic results are running.");
      },
    });
  };

  const requestLevel = (definition: KindDefinition, next: Level) => {
    if (next === "automatic") return;
    const current = modeOf(definition.kind);
    const raising = levelRank(next) > levelRank(current);
    const target = levelDefinition(next);
    const title = `Set ${definition.shortName} to ${target.label}?`;
    const save = async () => {
      await setKindMode({ kind: definition.kind, mode: next });
      toast.success(`${definition.shortName} is set to ${target.label}.`);
    };
    if (raising) {
      setConfirm({
        title,
        description: definition.raiseWords?.[next] ?? target.raiseWords,
        note: running ? undefined : "Everything is paused, so nothing runs until it is set to Running.",
        confirmLabel: `Set to ${target.label}`,
        pendingLabel: "Saving…",
        run: save,
      });
    } else {
      setConfirm({
        title,
        description: LOWER_WORDS,
        note: definition.raiseWords?.[next] ?? target.raiseWords,
        confirmLabel: `Set to ${target.label}`,
        pendingLabel: "Saving…",
        danger: true,
        run: save,
      });
    }
  };

  const status = configured === null ? { word: "Off", tone: "muted" as const }
    : running ? { word: "Running", tone: "ok" as const }
    : { word: "Paused", tone: "warning" as const };

  return (
    <section aria-labelledby="automatic-results-controls-title" className={`${CARD} @container/controls`}>
      <CardHead
        title={<span id="automatic-results-controls-title">Automatic results</span>}
        meta="Only the owner can raise a level. Admins can lower one or pause everything."
      >
        <StatusWord tone={status.tone}>
          <TranslatableText>{status.word}</TranslatableText>
        </StatusWord>
      </CardHead>

      {configured === null ? (
        <div className="border-b border-border px-4 py-3">
          <NoteLine tone="ok">
            Nothing is on yet, and every kind is Off. At Shadow the CRM decides what each Whop payment means and logs
            it, without changing anything, so a person can grade the decisions. At Ask a closer or Billing confirms
            each one with one tap.
          </NoteLine>
        </div>
      ) : null}

      <ControlRow
        label="Everything"
        sentence="Pause stops every automatic write and every pending proposal at once. Whop intake and manual recording keep running."
        control={
          <ToggleGroup
            type="single"
            value={running ? "running" : "paused"}
            aria-label="Everything"
            className={SEGMENT_GROUP}
            onValueChange={(next) => {
              if (next && next !== (running ? "running" : "paused")) requestRunning(next as Running);
            }}
          >
            <ToggleGroupItem value="paused" disabled={!canLower} className={SEGMENT}>
              Paused
            </ToggleGroupItem>
            <ToggleGroupItem value="running" disabled={!canRaise} className={SEGMENT}>
              Running
            </ToggleGroupItem>
          </ToggleGroup>
        }
        below={
          canRaise ? null : (
            <NoteLine>{running ? "You can pause everything. Only the owner can set it running." : "Only the owner can set it running."}</NoteLine>
          )
        }
      />

      {AUTOMATION_KINDS.map((definition) => (
        <KindRow
          key={definition.kind}
          definition={definition}
          level={modeOf(definition.kind)}
          paused={!running}
          canRaise={canRaise}
          canLower={canLower}
          blockedReason={definition.needsWhop && !whopConnected ? "Needs a Whop connection to decide anything." : null}
          record={canGrade ? <KindRecord kind={definition.kind} cleanTarget={definition.cleanTarget} /> : null}
          onRequest={(next) => requestLevel(definition, next)}
        />
      ))}

      <p className="border-t border-border bg-background px-4 py-2.5 text-[13px] leading-[1.45] text-muted-foreground">
        Changing a switch cancels what was pending under that switch only. Nothing resumes by itself.
      </p>

      {confirm ? <ConfirmChangeDialog request={confirm} onClose={() => setConfirm(null)} /> : null}
    </section>
  );
}

/** A ruled row: the name and its sentence on the left, the control on the right from `@2xl`. */
function ControlRow({
  label,
  sentence,
  detail,
  control,
  below,
}: {
  label?: string;
  sentence: string;
  detail?: string;
  control: ReactNode;
  below?: ReactNode;
}) {
  return (
    <div className="grid gap-x-6 gap-y-2.5 border-t border-border px-4 py-3 first:border-t-0 @2xl/controls:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0">
        {label ? <p className="text-[14px] font-semibold">{label}</p> : null}
        <p className="max-w-[62ch] text-[14px] leading-[1.45]">{sentence}</p>
        {detail ? <p className="mt-0.5 text-[13px] text-muted-foreground">{detail}</p> : null}
      </div>
      <div className="flex min-w-0 flex-col gap-1.5 @2xl/controls:items-end">
        {control}
        {below}
      </div>
    </div>
  );
}

/**
 * One kind of result: its sentence, its level and its record. `record` is the
 * graded record line (or nothing when the viewer can't grade); `blockedReason`
 * says why the kind can't work right now, such as a missing connection.
 */
export function KindRow({
  definition,
  level,
  paused,
  canRaise,
  canLower,
  blockedReason,
  record,
  onRequest,
}: {
  definition: KindDefinition;
  level: Level;
  paused: boolean;
  canRaise: boolean;
  canLower: boolean;
  blockedReason?: string | null;
  record?: ReactNode;
  onRequest: (next: Level) => void;
}) {
  return (
    <ControlRow
      sentence={definition.sentence}
      detail={definition.detail}
      control={
        <LevelControl
          value={level}
          label={`Level for ${definition.shortName}`}
          canRaise={canRaise}
          canLower={canLower}
          onRequest={onRequest}
        />
      }
      below={
        <div className="flex flex-col gap-0.5 @2xl/controls:items-end @2xl/controls:text-right">
          {record}
          {LEVELS.filter((option) => !option.available).map((option) => (
            <NoteLine key={option.value}>
              {option.label}: {option.lockedReason?.toLowerCase() ?? "not available"}.
            </NoteLine>
          ))}
          {paused && level !== "off" ? (
            <NoteLine tone="warning">Set to {levelDefinition(level).label}. Paused, so nothing runs now.</NoteLine>
          ) : null}
          {blockedReason ? <NoteLine tone="warning">{blockedReason}</NoteLine> : null}
          {canRaise ? null : <NoteLine>You can lower this level. Only the owner can raise it.</NoteLine>}
        </div>
      }
    />
  );
}

/** "41 of 300 clean · 0 wrong": blind clean grades on proposals the rule would have written. */
export function KindRecord({ kind, cleanTarget }: { kind: AutomationKind; cleanTarget: number }) {
  const tally = useQuery(api.automation.grading.getGradeTally, { kind });
  if (tally === undefined) {
    return <NoteLine role="status">Loading the record…</NoteLine>;
  }
  const { writes, capped } = tally;
  return (
    <p className="text-[13px] leading-[1.45]">
      <span className={INLINE_FIGURE}>{countWords(writes.cleanBlind, capped)}</span>
      <span className="text-muted-foreground"> of </span>
      <span className={INLINE_FIGURE}>{cleanTarget}</span>
      <span className="text-muted-foreground"> clean · </span>
      <span className={INLINE_FIGURE}>{countWords(writes.wrong, capped)}</span>
      <span className="text-muted-foreground"> wrong</span>
      {writes.unsure > 0 ? (
        <>
          <span className="text-muted-foreground"> · </span>
          <span className={INLINE_FIGURE}>{writes.unsure}</span>
          <span className="text-muted-foreground"> unsure</span>
        </>
      ) : null}
    </p>
  );
}
