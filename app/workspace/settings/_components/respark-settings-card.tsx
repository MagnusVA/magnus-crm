"use client";
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group";
import { Skeleton } from "@/components/ui/skeleton";
import { BATCH_SIZE_RANGE, INACTIVE_AFTER_DAYS_RANGE } from "@/convex/lib/respark/settings";
import { getErrorMessage } from "@/lib/errors";
import { useNow } from "@/hooks/use-now";

const COUNT_FORMATTER = new Intl.NumberFormat("en-US");
const HOUR_MS = 60 * 60_000;

type Draft = { inactiveAfterDays: string; batchSize: string };

function wholeNumberIn(value: string, range: { min: number; max: number }): number | null {
  const parsed = Number(value);
  return value.trim() !== "" && Number.isInteger(parsed) && parsed >= range.min && parsed <= range.max ? parsed : null;
}

function holdText(businessDay: { timeZone: string; dayStartHour: number }) {
  const hour = String(businessDay.dayStartHour).padStart(2, "0");
  return `Held until the business day ends (${hour}:00, ${businessDay.timeZone})`;
}

// Respark settings (docs/plans/respark.md §6.4): when a person counts as
// inactive, with a live count, and the batch size. The hold isn't a setting.
export function ResparkSettingsCard() {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const update = useMutation(api.respark.settings.updateResparkSettings);
  const previewDays = draft ? wholeNumberIn(draft.inactiveAfterDays, INACTIVE_AFTER_DAYS_RANGE) : null;
  // An hour-rounded clock keeps "today" current without re-running the
  // query every minute.
  const hour = Math.floor(useNow(60 * 60_000) / HOUR_MS) * HOUR_MS;
  const result = useQuery(
    api.respark.settings.getResparkSettings,
    previewDays === null ? { now: hour } : { inactiveAfterDays: previewDays, now: hour },
  );
  // Keep the last answer on screen while the preview count for a new value loads.
  const [shown, setShown] = useState(result);
  if (result !== undefined && result !== shown) setShown(result);

  if (shown === undefined) {
    return <Card><CardContent><Skeleton role="status" aria-label="Loading respark settings" className="h-48 w-full" /></CardContent></Card>;
  }

  const values: Draft = draft ?? {
    inactiveAfterDays: String(shown.settings.inactiveAfterDays),
    batchSize: String(shown.settings.batchSize),
  };
  const inactiveAfterDays = wholeNumberIn(values.inactiveAfterDays, INACTIVE_AFTER_DAYS_RANGE);
  const batchSize = wholeNumberIn(values.batchSize, BATCH_SIZE_RANGE);
  const changed = draft !== null && (inactiveAfterDays !== shown.settings.inactiveAfterDays || batchSize !== shown.settings.batchSize);
  const count = draft === null || shown.inactive?.inactiveAfterDays === inactiveAfterDays ? shown.inactive : null;

  const save = async () => {
    if (inactiveAfterDays === null || batchSize === null) return;
    setSaving(true);
    try { await update({ inactiveAfterDays, batchSize }); setDraft(null); toast.success("Respark settings saved."); }
    catch (error) { toast.error(getErrorMessage(error, "Could not save the respark settings.")); }
    finally { setSaving(false); }
  };

  return <Card>
    <CardHeader><CardTitle>Respark</CardTitle><CardDescription>When a person counts as inactive, and what a lead generator gets when they ask for a batch.</CardDescription></CardHeader>
    <CardContent className="flex flex-col gap-4">
      <FieldGroup>
        <Field data-invalid={inactiveAfterDays === null || undefined}>
          <FieldLabel htmlFor="respark-inactive-after">Inactive after</FieldLabel>
          <InputGroup className="max-w-56">
            <InputGroupInput id="respark-inactive-after" type="number" inputMode="numeric" min={INACTIVE_AFTER_DAYS_RANGE.min} max={INACTIVE_AFTER_DAYS_RANGE.max} step={1}
              value={values.inactiveAfterDays} disabled={saving} aria-invalid={inactiveAfterDays === null}
              onChange={(event) => setDraft({ ...values, inactiveAfterDays: event.target.value })} />
            <InputGroupAddon align="inline-end"><InputGroupText>days without a touch</InputGroupText></InputGroupAddon>
          </InputGroup>
          <FieldDescription aria-live="polite">
            {inactiveAfterDays === null
              ? `Enter a whole number of days from ${INACTIVE_AFTER_DAYS_RANGE.min} to ${INACTIVE_AFTER_DAYS_RANGE.max}.`
              : count
                ? `At ${COUNT_FORMATTER.format(count.inactiveAfterDays)} days, ${COUNT_FORMATTER.format(count.count)} ${count.count === 1 ? "person is" : "people are"} inactive today.`
                : "Counting inactive people..."}
          </FieldDescription>
        </Field>
        <Field data-invalid={batchSize === null || undefined}>
          <FieldLabel htmlFor="respark-batch-size">Batch size</FieldLabel>
          <InputGroup className="max-w-56">
            <InputGroupInput id="respark-batch-size" type="number" inputMode="numeric" min={BATCH_SIZE_RANGE.min} max={BATCH_SIZE_RANGE.max} step={1}
              value={values.batchSize} disabled={saving} aria-invalid={batchSize === null}
              onChange={(event) => setDraft({ ...values, batchSize: event.target.value })} />
            <InputGroupAddon align="inline-end"><InputGroupText>people</InputGroupText></InputGroupAddon>
          </InputGroup>
          <FieldDescription>
            {batchSize === null ? `Enter a whole number from ${BATCH_SIZE_RANGE.min} to ${BATCH_SIZE_RANGE.max}.` : "What a lead generator gets when they ask for a batch."}
          </FieldDescription>
        </Field>
      </FieldGroup>
      <p className="text-sm text-muted-foreground">{holdText(shown.businessDay)}. When the hold ends, unworked people go back to the pool.</p>
    </CardContent>
    <CardFooter><Button disabled={saving || !changed || inactiveAfterDays === null || batchSize === null} onClick={() => void save()}>{saving ? "Saving..." : "Save respark settings"}</Button></CardFooter>
  </Card>;
}
