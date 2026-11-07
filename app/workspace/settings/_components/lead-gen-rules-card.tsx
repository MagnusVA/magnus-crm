"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import posthog from "@/lib/posthog-browser";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";
import { cn } from "@/lib/utils";
import { CARD, CardHead } from "@/app/workspace/team/_components/team-ui";
import { FormCardSkeleton } from "./settings-skeleton";
import { FormFooter, SettingRow } from "./settings-ui";

// Lead gen capture rules: the one job Lead Gen settings still had once its
// workers, teams and schedules moved to Team. Same fields and the same Save
// as the old Rules tab (api.leadGen.settings).

// Mirror the bounds in convex/leadGen/settings.ts updateSettings.
const CORRECTION_WINDOW_RANGE = { min: 0, max: 10080 };
const RAW_EXPORT_RANGE = { min: 1, max: 50000 };

type DuplicateDisplayMode = "show_all" | "group_by_prospect";
type Draft = { correctionWindowMinutes: string; rawExportMaxRows: string; duplicateDisplayMode: DuplicateDisplayMode };

function wholeNumberIn(value: string, range: { min: number; max: number }): number | null {
  const parsed = Number(value);
  return value.trim() !== "" && Number.isInteger(parsed) && parsed >= range.min && parsed <= range.max ? parsed : null;
}

export function LeadGenRulesCard() {
  const settings = useQuery(api.leadGen.settings.getSettings, {});
  const update = useMutation(api.leadGen.settings.updateSettings);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  if (settings === undefined) {
    return <FormCardSkeleton id="lead-gen-rules" label="Loading lead gen capture rules" rows={3} />;
  }

  const savedCorrection = "correctionWindowMinutes" in settings ? settings.correctionWindowMinutes : undefined;
  const values: Draft = draft ?? {
    correctionWindowMinutes: savedCorrection === undefined ? "" : String(savedCorrection),
    rawExportMaxRows: String(settings.rawExportMaxRows),
    duplicateDisplayMode: settings.duplicateDisplayMode,
  };
  // An empty correction window is allowed: it leaves the saved one as it is,
  // as the old Rules tab did.
  const correctionBlank = values.correctionWindowMinutes.trim() === "";
  const correctionWindow = correctionBlank ? undefined : wholeNumberIn(values.correctionWindowMinutes, CORRECTION_WINDOW_RANGE);
  const rawExportMaxRows = wholeNumberIn(values.rawExportMaxRows, RAW_EXPORT_RANGE);
  const valid = correctionWindow !== null && rawExportMaxRows !== null;
  const changed =
    draft !== null &&
    (correctionWindow !== savedCorrection ||
      rawExportMaxRows !== settings.rawExportMaxRows ||
      values.duplicateDisplayMode !== settings.duplicateDisplayMode);

  const save = async () => {
    if (correctionWindow === null || rawExportMaxRows === null) return;
    setSaving(true);
    try {
      await update({
        rawExportMaxRows,
        duplicateDisplayMode: values.duplicateDisplayMode,
        ...(correctionWindow !== undefined ? { correctionWindowMinutes: correctionWindow } : {}),
      });
      setDraft(null);
      posthog.capture("lead_gen_rules_saved", {
        duplicate_display_mode: values.duplicateDisplayMode,
        has_correction_window: correctionWindow !== undefined,
      });
      toast.success("Lead gen capture rules saved.");
    } catch (error) {
      reportClientError(error, { flow: "lead_gen_rules_save" });
      toast.error(getErrorMessage(error, "Could not save the capture rules."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section id="lead-gen-rules" aria-labelledby="lead-gen-rules-title" className={cn(CARD, "scroll-mt-20")}>
      <CardHead
        title={<span id="lead-gen-rules-title">Lead gen capture rules</span>}
        meta="Corrections, raw exports and people captured twice."
      />
      <FieldGroup className="gap-0 divide-y divide-border">
        <SettingRow
          label="Correction window"
          htmlFor="lead-gen-correction-window"
          invalid={correctionWindow === null}
          tip="Empty leaves the saved window as it is."
          description={
            correctionWindow === null
              ? `Enter a whole number of minutes from ${CORRECTION_WINDOW_RANGE.min} to ${CORRECTION_WINDOW_RANGE.max}.`
              : "How long after a capture its specialist can still correct it."
          }
        >
          <InputGroup>
            <InputGroupInput
              id="lead-gen-correction-window"
              type="number"
              inputMode="numeric"
              min={CORRECTION_WINDOW_RANGE.min}
              max={CORRECTION_WINDOW_RANGE.max}
              step={1}
              placeholder="None"
              className="font-condensed text-[15px] tabular-nums md:text-[15px]"
              value={values.correctionWindowMinutes}
              disabled={saving}
              aria-invalid={correctionWindow === null}
              onChange={(event) => setDraft({ ...values, correctionWindowMinutes: event.target.value })}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupText>minutes</InputGroupText>
            </InputGroupAddon>
          </InputGroup>
        </SettingRow>
        <SettingRow
          label="Raw export max rows"
          htmlFor="lead-gen-raw-export-rows"
          invalid={rawExportMaxRows === null}
          description={
            rawExportMaxRows === null
              ? `Enter a whole number from ${RAW_EXPORT_RANGE.min} to ${RAW_EXPORT_RANGE.max.toLocaleString("en-US")}.`
              : "The most submissions one raw export from the Lead Gen report holds."
          }
        >
          <InputGroup>
            <InputGroupInput
              id="lead-gen-raw-export-rows"
              type="number"
              inputMode="numeric"
              min={RAW_EXPORT_RANGE.min}
              max={RAW_EXPORT_RANGE.max}
              step={1}
              className="font-condensed text-[15px] tabular-nums md:text-[15px]"
              value={values.rawExportMaxRows}
              disabled={saving}
              aria-invalid={rawExportMaxRows === null}
              onChange={(event) => setDraft({ ...values, rawExportMaxRows: event.target.value })}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupText>rows</InputGroupText>
            </InputGroupAddon>
          </InputGroup>
        </SettingRow>
        <SettingRow
          label="Duplicate display"
          htmlFor="lead-gen-duplicate-display"
          description="Whether a person captured more than once shows once or every time."
        >
          <Select
            value={values.duplicateDisplayMode}
            disabled={saving}
            onValueChange={(value) => setDraft({ ...values, duplicateDisplayMode: value as DuplicateDisplayMode })}
          >
            <SelectTrigger id="lead-gen-duplicate-display" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="show_all">Show every submission</SelectItem>
                <SelectItem value="group_by_prospect">Group by prospect</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </SettingRow>
      </FieldGroup>
      <FormFooter>
        {draft !== null ? (
          <Button variant="ghost" disabled={saving} onClick={() => setDraft(null)}>
            Discard
          </Button>
        ) : null}
        <Button
          variant={changed && valid ? "default" : "outline"}
          className={changed && valid ? "font-semibold" : undefined}
          disabled={saving || !changed || !valid}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save capture rules"}
        </Button>
      </FormFooter>
    </section>
  );
}
