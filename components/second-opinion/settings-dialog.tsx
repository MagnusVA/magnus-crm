"use client";
import { useId, useState } from "react";
import { useMutation } from "convex/react";
import { useForm, Controller } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Field,
  FieldLabel,
  FieldGroup,
  FieldError,
} from "@/components/ui/field";
import { getErrorMessage } from "@/lib/errors";
const capSchema = z.object({ cap: z.number().positive().max(10000) });
export default function OpinionSettingsDialog({
  kind,
  mode,
  cap,
  onClose,
}: {
  kind: "consent" | "cap" | "open";
  mode: "off" | "shadow" | "on";
  cap: number;
  onClose: () => void;
}) {
  const update = useMutation(api.secondOpinion.setMode);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const form = useForm({
    resolver: standardSchemaResolver(capSchema),
    defaultValues: { cap },
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {kind === "consent"
              ? "Turn on the second opinion?"
              : kind === "open"
                ? "Open results to closers and admins?"
                : "Monthly cap"}
          </DialogTitle>
          <DialogDescription>
            {kind === "consent"
              ? "Transcripts of recorded sales calls go to TypeSafe's Jev model through the Convex AI Gateway, on zero-data-retention endpoints only. Jev returns labels and numbers, never text."
              : kind === "open"
                ? "Closers will see results after they record a result. Admins will see every check and can review disagreements."
                : "Magnus stops calling Jev once the month's cost reaches the cap."}
          </DialogDescription>
        </DialogHeader>
        {kind === "consent" && (
          <p className="text-sm text-muted-foreground">
            For the first 14 days only owners see results. Magnus stops calling
            Jev once the month&apos;s cost reaches the cap.
          </p>
        )}
        <form
          className="flex flex-col gap-4"
          onSubmit={form.handleSubmit(async (values) => {
            setBusy(true);
            try {
              await update({
                mode: kind === "cap" ? mode : "on",
                monthlyCapUsd: values.cap,
              });
              onClose();
            } catch (error) {
              toast.error(
                getErrorMessage(error, "Could not update the second opinion."),
              );
            } finally {
              setBusy(false);
            }
          })}
        >
          <FieldGroup>
            <Controller
              control={form.control}
              name="cap"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor={id}>Monthly cap · USD</FieldLabel>
                  <Input
                    {...field}
                    id={id}
                    type="number"
                    min="0.01"
                    max="10000"
                    step="0.01"
                    onChange={(event) =>
                      field.onChange(
                        event.target.value === ""
                          ? NaN
                          : Number(event.target.value),
                      )
                    }
                    aria-invalid={fieldState.invalid}
                  />
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
          </FieldGroup>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy
                ? "Saving…"
                : kind === "consent"
                  ? "Turn on"
                  : kind === "open"
                    ? "Open results"
                    : "Save cap"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
