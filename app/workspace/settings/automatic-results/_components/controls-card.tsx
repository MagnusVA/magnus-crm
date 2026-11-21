"use client";

import { useId, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { TranslatableText } from "@/components/translatable-text";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { CARD, CardHead } from "@/app/workspace/team/_components/team-ui";
import { NoteLine, StatusWord } from "@/app/workspace/settings/_components/settings-ui";
import { useNow } from "@/hooks/use-now";
import { getErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import {
  AUTOMATION_KINDS,
  CALL_INSIGHTS_SETTINGS_HREF,
  LOWER_WORDS,
  kindSentence,
  levelDefinition,
  levelRank,
  type AlertLevel,
  type AutomationKind,
  type AutomationSettingsView,
  type CertificateView,
  type KindDefinition,
  type Level,
} from "./automation-kinds";
import { INLINE_FIGURE, LevelControl, SEGMENT, SEGMENT_GROUP } from "./automation-ui";
import { automaticHeldWords, automaticLockReason } from "./automatic-status";
import type { ConfirmChange } from "./confirm-change-dialog";

const ConfirmChangeDialog = dynamic(() => import("./confirm-change-dialog"));
const PromoteDialog = dynamic(() => import("./promote-dialog"));

type Running = "running" | "paused";

const DEFAULT_GRACE_MINUTES = 120;
const DEFAULT_NOTICE_HOURS = 48;

const ALERT_LEVELS: ReadonlyArray<{ value: AlertLevel; label: string }> = [
  { value: "off", label: "Off" },
  { value: "shadow", label: "Shadow" },
  { value: "on", label: "On" },
];
const ALERT_RANK: Record<AlertLevel, number> = { off: 0, shadow: 1, on: 2 };

/**
 * The switches: Everything (Paused or Running), one row per kind with its
 * level and its clean sample, the paid-on-call alert, and the refusal notice.
 * Every change asks once and says what changes. Raising needs `canRaise` (the
 * owner); lowering and pausing need `canLower`. Automatic is earned per kind
 * and needs the typed confirmation in the promote dialog.
 */
export function ControlsCard({
  view,
  certificates,
  whopConnected,
}: {
  view: AutomationSettingsView;
  certificates: readonly CertificateView[] | undefined;
  whopConnected: boolean;
}) {
  const now = useNow();
  const setEnabled = useMutation(api.automation.settings.setEnabled);
  const setKindMode = useMutation(api.automation.settings.setKindMode);
  const demoteKind = useMutation(api.automation.certificates.demoteKind);
  const setAlertMode = useMutation(api.automation.settings.setAlertMode);
  const [confirm, setConfirm] = useState<ConfirmChange | null>(null);
  const [promote, setPromote] = useState<{ definition: KindDefinition; sampleId: Id<"automationSamples"> } | null>(null);
  const { configured, canRaise, canLower } = view;
  const running = configured?.enabled === true;
  const noticeHours = configured?.refusalNoticeHours ?? DEFAULT_NOTICE_HOURS;
  const callOff = !view.callInsightsOn;

  const modeOf = (kind: AutomationKind): Level => configured?.kinds[kind]?.mode ?? "off";
  const certificateOf = (kind: AutomationKind) => certificates?.find((row) => row.kind === kind);

  const requestRunning = (next: Running) => {
    if (next === "paused") {
      setConfirm({
        title: "Pause everything?",
        description:
          "Every automatic write, every pending proposal and every pending refusal notice stops at once. Whop intake and manual recording keep running.",
        note: "Results already recorded stay as they are. Nothing resumes by itself.",
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
    const automaticOn = AUTOMATION_KINDS.filter((definition) => modeOf(definition.kind) === "automatic");
    setConfirm({
      title: "Set everything running?",
      description: `Each kind runs at its own level: ${levels}.`,
      note: automaticOn.length
        ? `${automaticOn.map((definition) => definition.shortName).join(", ")} will record by itself again. Proposals cancelled by the pause stay cancelled.`
        : "Proposals cancelled by the pause stay cancelled.",
      confirmLabel: "Set running",
      pendingLabel: "Saving…",
      run: async () => {
        await setEnabled({ enabled: true });
        toast.success("Automatic results are running.");
      },
    });
  };

  const requestLevel = (definition: KindDefinition, next: Level) => {
    const current = modeOf(definition.kind);
    const target = levelDefinition(next);
    if (next === "automatic") {
      const sampleId = view.automatic[definition.kind].sampleId;
      if (view.automatic[definition.kind].canPromote && sampleId) setPromote({ definition, sampleId });
      return;
    }
    const title = `Set ${definition.shortName} to ${target.label}?`;
    if (current === "automatic") {
      setConfirm({
        title,
        description: `The CRM stops recording ${definition.shortName} by itself. ${LOWER_WORDS}`,
        note:
          next === "ask"
            ? "Each one asks for a tap again. Results it already recorded stay, and stay listed below with Undo. Switching back to Automatic needs a current certificate and the typed confirmation."
            : `${target.raiseWords} Results it already recorded stay, and stay listed below with Undo. Switching back to Automatic needs a current certificate and the typed confirmation.`,
        confirmLabel: `Set to ${target.label}`,
        pendingLabel: "Saving…",
        danger: true,
        run: async () => {
          if (next === "ask") await demoteKind({ kind: definition.kind });
          else await setKindMode({ kind: definition.kind, mode: next });
          toast.success(`${definition.shortName} is set to ${target.label}.`);
        },
      });
      return;
    }
    const raising = levelRank(next) > levelRank(current);
    const save = async () => {
      await setKindMode({ kind: definition.kind, mode: next });
      toast.success(`${definition.shortName} is set to ${target.label}.`);
    };
    const callNote = definition.source === "call" && callOff
      ? "Call insights is off, so this kind does nothing until Call insights is switched on."
      : undefined;
    const pausedNote = running ? undefined : "Everything is paused, so nothing runs until it is set to Running.";
    if (raising) {
      setConfirm({
        title,
        description: definition.raiseWords?.[next] ?? target.raiseWords,
        note: callNote ?? pausedNote,
        confirmLabel: `Set to ${target.label}`,
        pendingLabel: "Saving…",
        run: save,
      });
    } else {
      setConfirm({
        title,
        description: LOWER_WORDS,
        note: `${definition.raiseWords?.[next] ?? target.raiseWords} An unfinished sample for this kind closes, and counting starts again.`,
        confirmLabel: `Set to ${target.label}`,
        pendingLabel: "Saving…",
        danger: true,
        run: save,
      });
    }
  };

  const alert = configured?.paidOnCallAlert;
  const alertMode: AlertLevel = alert?.mode ?? "off";
  const graceMinutes = alert?.graceMinutes ?? DEFAULT_GRACE_MINUTES;

  const requestAlert = (next: AlertLevel) => {
    const raising = ALERT_RANK[next] > ALERT_RANK[alertMode];
    const words: Record<AlertLevel, string> = {
      off: "The CRM stops watching for this.",
      shadow: "The CRM will note each call where a closer says the payment came through and none shows up, and change nothing. No one is asked.",
      on: `Closers will be asked about it when no payment shows up ${graceMinutes} minutes after the call.`,
    };
    setConfirm({
      title: `Set the paid-on-call alert to ${ALERT_LEVELS.find((level) => level.value === next)?.label}?`,
      description: raising ? words[next] : "Questions waiting under this alert are cancelled. Nothing resumes by itself.",
      note: raising
        ? callOff
          ? "Call insights is off, so the alert does nothing until Call insights is switched on."
          : undefined
        : words[next],
      confirmLabel: "Save",
      pendingLabel: "Saving…",
      danger: !raising,
      run: async () => {
        await setAlertMode({ mode: next });
        toast.success("The alert is saved.");
      },
    });
  };

  const status = configured === null ? { word: "Off", tone: "muted" as const }
    : running ? { word: "Running", tone: "ok" as const }
    : { word: "Paused", tone: "warning" as const };

  return (
    <section aria-labelledby="automatic-results-controls-title" className={`${CARD} @container/controls`}>
      <CardHead
        title={<span id="automatic-results-controls-title">Automatic results</span>}
        meta="Only the owner can raise a level or switch on Automatic. Admins can lower one or pause everything."
      >
        <StatusWord tone={status.tone}>
          <TranslatableText>{status.word}</TranslatableText>
        </StatusWord>
      </CardHead>

      {configured === null ? (
        <div className="border-b border-border px-4 py-3">
          <NoteLine tone="ok">
            Nothing is on yet, and every kind is Off. At Shadow the CRM decides and logs, without changing anything,
            so a person can grade the decisions. At Ask a closer or Billing confirms each one with one tap. Automatic
            is earned kind by kind with a clean graded sample.
          </NoteLine>
        </div>
      ) : null}

      <ControlRow
        label="Everything"
        sentence="Pause stops every automatic write, every pending proposal and every pending notice at once. Whop intake and manual recording keep running."
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

      {AUTOMATION_KINDS.map((definition) => {
        const level = modeOf(definition.kind);
        const automatic = view.automatic[definition.kind];
        const certificate = certificateOf(definition.kind);
        const lock = automaticLockReason({ mode: level, status: automatic, certificate, canRaise, now });
        return (
          <KindRow
            key={definition.kind}
            definition={definition}
            sentence={kindSentence(definition, noticeHours)}
            level={level}
            paused={!running}
            canRaise={canRaise}
            canLower={canLower}
            locked={lock ? { automatic: lock } : undefined}
            blockedReason={
              definition.needsWhop && !whopConnected ? (
                "Needs a Whop connection to decide anything."
              ) : definition.source === "call" && callOff ? (
                <>
                  Needs Call insights switched on.{" "}
                  <Link href={CALL_INSIGHTS_SETTINGS_HREF} className={cn(detailLinkClass, "inline text-[13px]")}>
                    Call insights settings
                  </Link>
                </>
              ) : null
            }
            held={level === "automatic" ? automaticHeldWords(automatic) : null}
            record={<CertificateLine certificate={certificate} />}
            onRequest={(next) => requestLevel(definition, next)}
          />
        );
      })}

      <ControlRow
        label="Paid on the call, no payment"
        sentence="When a closer says on the call that the payment came through and no payment shows up, ask them about it."
        detail="Never recorded by itself. The closer answers: add the payment, paid in Whop by someone else, or not paid yet."
        control={
          <ToggleGroup
            type="single"
            value={alertMode}
            aria-label="Level for the paid-on-call alert"
            className={SEGMENT_GROUP}
            onValueChange={(next) => {
              if (next && next !== alertMode) requestAlert(next as AlertLevel);
            }}
          >
            {ALERT_LEVELS.map((level) => {
              const rank = ALERT_RANK[level.value];
              const blocked = (rank > ALERT_RANK[alertMode] && !canRaise) || (rank < ALERT_RANK[alertMode] && !canLower);
              return (
                <ToggleGroupItem key={level.value} value={level.value} disabled={blocked} className={SEGMENT}>
                  {level.label}
                </ToggleGroupItem>
              );
            })}
          </ToggleGroup>
        }
        below={
          <div className="flex flex-col gap-1 @2xl/controls:items-end @2xl/controls:text-right">
            <GraceField mode={alertMode} current={graceMinutes} canChange={canRaise} />
            {callOff ? (
              <NoteLine tone="warning">
                Needs Call insights switched on.{" "}
                <Link href={CALL_INSIGHTS_SETTINGS_HREF} className={cn(detailLinkClass, "inline text-[13px]")}>
                  Call insights settings
                </Link>
              </NoteLine>
            ) : null}
            {!running && alertMode !== "off" ? <NoteLine tone="warning">Paused, so nothing runs now.</NoteLine> : null}
            {canRaise ? null : <NoteLine>You can lower this. Only the owner can raise it or change the wait.</NoteLine>}
          </div>
        }
      />

      <NoticeHoursRow current={noticeHours} canChange={canRaise} />

      <p className="border-t border-border bg-background px-4 py-2.5 text-[13px] leading-[1.45] text-muted-foreground">
        Changing a switch cancels what was pending under that switch only. Nothing resumes by itself.
      </p>

      {confirm ? <ConfirmChangeDialog request={confirm} onClose={() => setConfirm(null)} /> : null}
      {promote ? (
        <PromoteDialog
          definition={promote.definition}
          sampleId={promote.sampleId}
          noticeHours={noticeHours}
          onClose={() => setPromote(null)}
        />
      ) : null}
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
        {detail ? <p className="mt-0.5 max-w-[62ch] text-[13px] text-muted-foreground">{detail}</p> : null}
      </div>
      <div className="flex min-w-0 flex-col gap-1.5 @2xl/controls:max-w-[24rem] @2xl/controls:items-end">
        {control}
        {below}
      </div>
    </div>
  );
}

/**
 * One kind of result: its sentence, its level and its record. `record` is the
 * clean-sample line; `blockedReason` says why the kind can't work right now,
 * such as a missing connection; `held` says what an Automatic kind does instead.
 */
export function KindRow({
  definition,
  sentence,
  level,
  paused,
  canRaise,
  canLower,
  locked,
  blockedReason,
  held,
  record,
  onRequest,
}: {
  definition: KindDefinition;
  sentence?: string;
  level: Level;
  paused: boolean;
  canRaise: boolean;
  canLower: boolean;
  locked?: Partial<Record<Level, string>>;
  blockedReason?: ReactNode;
  held?: string | null;
  record?: ReactNode;
  onRequest: (next: Level) => void;
}) {
  return (
    <ControlRow
      sentence={sentence ?? definition.sentence}
      detail={definition.detail}
      control={
        <LevelControl
          value={level}
          label={`Level for ${definition.shortName}`}
          canRaise={canRaise}
          canLower={canLower}
          locked={locked}
          onRequest={onRequest}
        />
      }
      below={
        <div className="flex flex-col gap-0.5 @2xl/controls:items-end @2xl/controls:text-right">
          {record}
          {locked?.automatic && canRaise ? <NoteLine>Automatic: {locked.automatic}</NoteLine> : null}
          {held ? <NoteLine tone="warning">{held}</NoteLine> : null}
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

/** "41 of 300 clean · 0 wrong", from the kind's latest sample, or the reason it can't be earned. */
function CertificateLine({ certificate }: { certificate: CertificateView | undefined }) {
  if (certificate === undefined) return <NoteLine role="status">Loading the record…</NoteLine>;
  const sample = certificate.sample && certificate.sample.status !== "lapsed" ? certificate.sample : null;
  return (
    <p className="text-[13px] leading-[1.45]">
      {sample?.status === "certified" ? (
        <span className="font-medium">Certified · </span>
      ) : null}
      <span className={INLINE_FIGURE}>{sample?.correct ?? 0}</span>
      <span className="text-muted-foreground"> of </span>
      <span className={INLINE_FIGURE}>{certificate.target}</span>
      <span className="text-muted-foreground"> clean · </span>
      <span className={INLINE_FIGURE}>{sample?.wrong ?? 0}</span>
      <span className="text-muted-foreground"> wrong</span>
      {sample && sample.unsureOpen > 0 ? (
        <>
          <span className="text-muted-foreground"> · </span>
          <span className={INLINE_FIGURE}>{sample.unsureOpen}</span>
          <span className="text-muted-foreground"> unsure</span>
        </>
      ) : null}
      {certificate.notEnoughRecordedCalls ? (
        <span className="text-muted-foreground"> · Not enough recorded calls to earn automatic</span>
      ) : null}
    </p>
  );
}

/** The wait after the call before a closer is asked. Owner only; 30 to 1440 minutes. */
function GraceField({ mode, current, canChange }: { mode: AlertLevel; current: number; canChange: boolean }) {
  const id = useId();
  const setAlertMode = useMutation(api.automation.settings.setAlertMode);
  const [value, setValue] = useState(String(current));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const minutes = Number(value);
  const valid = Number.isInteger(minutes) && minutes >= 30 && minutes <= 1440;
  const changed = valid && minutes !== current;

  const save = async () => {
    if (!changed) return;
    setPending(true);
    setError(null);
    try {
      await setAlertMode({ mode, graceMinutes: minutes });
      toast.success(`Closers are asked ${minutes} minutes after the call.`);
    } catch (cause) {
      setError(getErrorMessage(cause, "Couldn't save the wait."));
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-1 @2xl/controls:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-wrap items-center gap-2 @2xl/controls:justify-end">
        <label htmlFor={id} className="text-[13px] text-muted-foreground">Ask after</label>
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={30}
          max={1440}
          step={1}
          value={value}
          disabled={!canChange || pending}
          aria-invalid={!valid || undefined}
          onChange={(event) => setValue(event.target.value)}
          className="h-8 w-24 font-condensed text-[15px] tabular-nums"
        />
        <span className="text-[13px] text-muted-foreground">minutes with no payment</span>
        {canChange ? (
          <Button type="submit" size="sm" variant="outline" disabled={!changed || pending}>
            {pending ? <Spinner data-icon="inline-start" /> : null}
            <TranslatableText>{pending ? "Saving…" : "Save"}</TranslatableText>
          </Button>
        ) : null}
      </div>
      {!valid ? <NoteLine tone="danger">Enter a whole number from 30 to 1440.</NoteLine> : null}
      {error ? <NoteLine tone="danger" role="alert">{error}</NoteLine> : null}
    </form>
  );
}

/** How long a refusal the CRM records by itself waits after the closer has seen it. Owner only. */
function NoticeHoursRow({ current, canChange }: { current: number; canChange: boolean }) {
  const id = useId();
  const setHours = useMutation(api.automation.settings.setRefusalNoticeHours);
  const [value, setValue] = useState(String(current));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hours = Number(value);
  const valid = Number.isInteger(hours) && hours >= 24 && hours <= 168;
  const changed = valid && hours !== current;

  const save = async () => {
    if (!changed) return;
    setPending(true);
    setError(null);
    try {
      await setHours({ hours });
      toast.success(`Refusal notices now wait ${hours} hours.`);
    } catch (cause) {
      setError(getErrorMessage(cause, "Couldn't save the notice time."));
    } finally {
      setPending(false);
    }
  };

  return (
    <ControlRow
      label="Refusal notice"
      sentence={`A refusal the CRM records by itself waits ${valid ? hours : current} hours after the closer has seen the notice. Anyone can stop it in that time.`}
      detail="Notices already seen keep the time they started with. From 24 to 168 hours."
      control={
        <form
          className="flex flex-wrap items-center gap-2 @2xl/controls:justify-end"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label htmlFor={id} className="sr-only">Refusal notice in hours</label>
          <Input
            id={id}
            type="number"
            inputMode="numeric"
            min={24}
            max={168}
            step={1}
            value={value}
            disabled={!canChange || pending}
            aria-invalid={!valid || undefined}
            aria-describedby={`${id}-help`}
            onChange={(event) => setValue(event.target.value)}
            className="h-8 w-24 font-condensed text-[15px] tabular-nums"
          />
          <span className="text-[13px] text-muted-foreground">hours</span>
          {canChange ? (
            <Button type="submit" size="sm" variant="outline" disabled={!changed || pending}>
              {pending ? <Spinner data-icon="inline-start" /> : null}
              <TranslatableText>{pending ? "Saving…" : "Save"}</TranslatableText>
            </Button>
          ) : null}
        </form>
      }
      below={
        <div id={`${id}-help`} className="flex flex-col gap-0.5 @2xl/controls:items-end @2xl/controls:text-right">
          {!valid ? <NoteLine tone="danger">Enter a whole number from 24 to 168.</NoteLine> : null}
          {error ? <NoteLine tone="danger" role="alert">{error}</NoteLine> : null}
          {canChange ? null : <NoteLine>Only the owner can change the notice time.</NoteLine>}
        </div>
      }
    />
  );
}

