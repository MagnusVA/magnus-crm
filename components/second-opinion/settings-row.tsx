"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { HelpTip, LABEL } from "@/app/workspace/team/_components/team-ui";
import { FACT_FIGURE, Fact, Facts, NoteLine, StatusWord, type Tone } from "@/app/workspace/settings/_components/settings-ui";
import { getErrorMessage } from "@/lib/errors";

const SettingsDialog = dynamic(() => import("./settings-dialog"));

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/**
 * The Fathom card's second opinion section (docs/plans/closer-assistant.md
 * §6.9): a labelled heading row with the status word and the switch, then
 * the month's cost and counts as dense facts. Hidden while Fathom isn't
 * connected, unless it is still on, so an owner can turn it off.
 */
export function SecondOpinionSettingsRow({ fathomConnected }: { fathomConnected: boolean }) {
  const settings = useQuery(api.secondOpinion.getSettings, {});
  const update = useMutation(api.secondOpinion.setMode);
  const [dialog, setDialog] = useState<"consent" | "cap" | "open" | null>(null);
  const [busy, setBusy] = useState(false);
  if (!settings || (!fathomConnected && settings.mode === "off")) return null;

  const state: { word: string; tone: Tone } =
    settings.mode === "off"
      ? { word: "Off", tone: "muted" }
      : settings.paused
        ? { word: "Paused", tone: "warning" }
        : settings.mode === "shadow"
          ? { word: "Shadow run", tone: "muted" }
          : { word: "On", tone: "ok" };
  const resetMonth = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short" }).format(settings.resetsAt);

  async function turnOff() {
    if (!settings) return;
    setBusy(true);
    try {
      await update({ mode: "off", monthlyCapUsd: settings.monthlyCapUsd });
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not turn off the second opinion."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-b border-border last:border-b-0">
      <div className="flex min-h-11 items-center gap-2.5 border-b border-border px-4 py-1.5 last:border-b-0">
        <span className={LABEL}>
          <HelpTip tip="Jev checks each recorded call against the result the closer recorded. Transcripts go to TypeSafe's Jev model through the Convex AI Gateway, on zero-data-retention endpoints only.">
            Second opinion
          </HelpTip>
        </span>
        <StatusWord tone={state.tone}>{state.word}</StatusWord>
        <Switch
          aria-label="Second opinion on recorded calls"
          className="ml-auto"
          checked={settings.mode !== "off"}
          disabled={!settings.canManage || busy}
          onCheckedChange={(enabled) => {
            if (enabled) setDialog("consent");
            else void turnOff();
          }}
        />
      </div>

      {!settings.canManage || settings.mode === "shadow" || settings.paused ? (
        <div className="flex flex-col gap-1 border-b border-border px-4 py-2.5 last:border-b-0">
          {!settings.canManage ? <NoteLine>Only an owner can turn it on or off.</NoteLine> : null}
          {settings.mode === "shadow" ? (
            <NoteLine>
              Shadow run, day <span className="font-condensed text-[14px] tabular-nums">{settings.shadowDay}</span> of 14.
              Only owners and admins see results.
            </NoteLine>
          ) : null}
          {settings.paused ? (
            <NoteLine tone="warning" role="status">
              The monthly cap is reached. Checks resume on 1 {resetMonth}.
            </NoteLine>
          ) : null}
        </div>
      ) : null}

      {settings.visible ? (
        <Facts>
          <Fact label="This month" tip="What the checks cost through the Convex AI Gateway, against the cap. Magnus stops calling Jev at the cap.">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className={FACT_FIGURE}>
                {settings.month.capped ? "≥ " : ""}
                {usd.format(settings.month.costUsd)}
              </span>
              <span className="text-[13px] text-muted-foreground">
                of <span className="font-condensed text-[14px] tabular-nums">{usd.format(settings.monthlyCapUsd)}</span>
              </span>
              {settings.canManage ? (
                <Button variant="outline" size="xs" className="ml-auto" onClick={() => setDialog("cap")}>
                  {settings.paused ? "Raise cap" : "Change cap"}
                </Button>
              ) : null}
            </span>
          </Fact>
          <Fact label="Checked" tip="Calls Jev checked this month, and what it found. Checked by an admin: disagreements an admin has reviewed.">
            <span className="text-[13px] text-muted-foreground">
              <Count n={settings.month.answered} /> calls · <Count n={settings.month.disagrees} /> disagree ·{" "}
              <Count n={settings.month.unsure} /> not sure · <Count n={settings.month.checked} /> checked by an admin ·{" "}
              <Count n={settings.month.failed} /> failed
              {settings.month.capped ? " · partial totals" : ""}
            </span>
          </Fact>
          <div className="px-4 py-1.5">
            <Link href="/workspace/pipeline/second-opinions" className={detailLinkClass}>
              Open second opinions
            </Link>
          </div>
        </Facts>
      ) : null}

      {settings.canManage && settings.readyToOpen ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2.5 last:border-b-0">
          <NoteLine className="min-w-0 flex-1">The 14-day shadow run is done. Open results to closers and admins?</NoteLine>
          <Button variant="outline" size="sm" onClick={() => setDialog("open")}>
            Open results
          </Button>
        </div>
      ) : null}

      {dialog ? (
        <SettingsDialog kind={dialog} mode={settings.mode} cap={settings.monthlyCapUsd} onClose={() => setDialog(null)} />
      ) : null}
    </div>
  );
}

function Count({ n }: { n: number }) {
  return <span className="font-condensed text-[14px] text-foreground tabular-nums">{n}</span>;
}
