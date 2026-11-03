"use client";
import { useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import { getErrorMessage } from "@/lib/errors";
const SettingsDialog = dynamic(() => import("./settings-dialog"));
export function SecondOpinionSettingsRow() {
  const settings = useQuery(api.secondOpinion.getSettings, {});
  const update = useMutation(api.secondOpinion.setMode);
  const [dialog, setDialog] = useState<"consent" | "cap" | "open" | null>(null);
  const [busy, setBusy] = useState(false);
  if (!settings) return null;
  const usd = (value: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(value);
  return (
    <div className="flex flex-col gap-3">
      <Separator />
      <Field orientation="horizontal">
        <div className="flex flex-1 flex-col gap-1">
          <FieldLabel htmlFor="second-opinion-enabled">
            Second opinion on recorded calls
          </FieldLabel>
          <FieldDescription>
            Jev checks each recorded call against the result the closer
            recorded.
          </FieldDescription>
        </div>
        <Switch
          id="second-opinion-enabled"
          checked={settings.mode !== "off"}
          disabled={!settings.canManage || busy}
          onCheckedChange={async (enabled) => {
            if (enabled) {
              setDialog("consent");
              return;
            }
            setBusy(true);
            try {
              await update({
                mode: "off",
                monthlyCapUsd: settings.monthlyCapUsd,
              });
            } catch (error) {
              toast.error(
                getErrorMessage(
                  error,
                  "Could not turn off the second opinion.",
                ),
              );
            } finally {
              setBusy(false);
            }
          }}
        />
      </Field>
      {!settings.canManage && (
        <p className="text-xs text-muted-foreground">
          Only an owner can change this setting.
        </p>
      )}
      {settings.mode === "shadow" && (
        <p className="text-sm text-muted-foreground">
          Shadow run · day {settings.shadowDay} of 14 · only owners see results
        </p>
      )}
      {settings.visible && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm tabular-nums">
              {settings.month.capped ? "At least " : ""}
              {usd(settings.month.costUsd)} of {usd(settings.monthlyCapUsd)}{" "}
              this month
            </p>
            {settings.canManage && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDialog("cap")}
              >
                {settings.paused ? "Raise cap" : "Monthly cap"}
              </Button>
            )}
          </div>
          {settings.paused && (
            <p className="text-sm">
              Paused until 1{" "}
              {new Intl.DateTimeFormat("en-US", {
                timeZone: "UTC",
                month: "short",
              }).format(settings.resetsAt)}{" "}
              · monthly cap reached
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            This month{settings.month.capped ? " · partial totals" : ""} ·{" "}
            {settings.month.answered} calls checked · {settings.month.disagrees}{" "}
            disagree · {settings.month.unsure} not sure ·{" "}
            {settings.month.checked} checked by an admin ·{" "}
            {settings.month.failed} failed
          </p>
          <Button variant="link" asChild className="self-start">
            <Link href="/workspace/pipeline/second-opinions">
              Second opinions
            </Link>
          </Button>
        </>
      )}
      {settings.canManage && settings.readyToOpen && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm">
            Your 14-day shadow run is complete. Open results to closers and
            admins?
          </p>
          <Button size="sm" onClick={() => setDialog("open")}>
            Open results
          </Button>
        </div>
      )}
      {dialog && (
        <SettingsDialog
          kind={dialog}
          mode={settings.mode}
          cap={settings.monthlyCapUsd}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
