"use client";
import { useState, useId } from "react";
import { useMutation } from "convex/react";
import { useForm, Controller, useWatch } from "react-hook-form";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldGroup,
  FieldError,
} from "@/components/ui/field";
import { getErrorMessage } from "@/lib/errors";
import type { OpinionDetail } from "./presentation";
const reopenSchema = z
  .object({
    choice: z.enum(["reopen", "leave"]),
    date: z.string(),
    time: z.string(),
  })
  .superRefine((value, ctx) => {
    if (value.choice !== "reopen") return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value.date))
      ctx.addIssue({
        code: "custom",
        path: ["date"],
        message: "Choose a date.",
      });
    if (!/^\d{2}:\d{2}$/.test(value.time))
      ctx.addIssue({
        code: "custom",
        path: ["time"],
        message: "Choose a time.",
      });
  });
export default function ReopenOpinionDialog({
  detail,
  onClose,
}: {
  detail: OpinionDetail;
  onClose: () => void;
}) {
  const check = useMutation(api.secondOpinion.check);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const form = useForm({
    resolver: standardSchemaResolver(reopenSchema),
    defaultValues: {
      choice: "leave" as "reopen" | "leave",
      date: "",
      time: "",
    },
  });
  const reopen =
    useWatch({ control: form.control, name: "choice" }) === "reopen";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>The second opinion is right</DialogTitle>
          <DialogDescription>
            Choose what happens to the deal.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={form.handleSubmit(async (values) => {
            setBusy(true);
            try {
              await check({
                secondOpinionId: detail.opinion._id,
                outcome: "second_opinion_right",
                ...(values.choice === "reopen"
                  ? { reopen: { date: values.date, time: values.time } }
                  : {}),
              });
              onClose();
            } catch (error) {
              toast.error(
                getErrorMessage(error, "Could not check this disagreement."),
              );
            } finally {
              setBusy(false);
            }
          })}
        >
          <FieldGroup>
            <Controller
              control={form.control}
              name="choice"
              render={({ field }) => (
                <RadioGroup value={field.value} onValueChange={field.onChange}>
                  <Field orientation="horizontal">
                    <RadioGroupItem value="reopen" id={`${id}-reopen`} />
                    <FieldLabel htmlFor={`${id}-reopen`}>
                      Reopen {detail.person}&apos;s deal at Follow-up, with a
                      call-back for {detail.closer}
                    </FieldLabel>
                  </Field>
                  <Field orientation="horizontal">
                    <RadioGroupItem value="leave" id={`${id}-leave`} />
                    <FieldLabel htmlFor={`${id}-leave`}>
                      Leave the deal closed
                    </FieldLabel>
                  </Field>
                </RadioGroup>
              )}
            />
            {reopen && (
              <>
                <Controller
                  control={form.control}
                  name="date"
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid}>
                      <FieldLabel htmlFor={`${id}-date`}>
                        Call-back date
                      </FieldLabel>
                      <Input
                        {...field}
                        id={`${id}-date`}
                        type="date"
                        aria-invalid={fieldState.invalid}
                      />
                      <FieldError errors={[fieldState.error]} />
                    </Field>
                  )}
                />
                <Controller
                  control={form.control}
                  name="time"
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid}>
                      <FieldLabel htmlFor={`${id}-time`}>
                        Call-back time
                      </FieldLabel>
                      <Input
                        {...field}
                        id={`${id}-time`}
                        type="time"
                        aria-invalid={fieldState.invalid}
                      />
                      <FieldDescription>
                        In {detail.closer}&apos;s local time,{" "}
                        {detail.callbackTimeZone}.
                      </FieldDescription>
                      <FieldError errors={[fieldState.error]} />
                    </Field>
                  )}
                />
              </>
            )}
          </FieldGroup>
          <p className="text-sm text-muted-foreground">
            Attendance stays no-show. Magnus can&apos;t correct it to held yet.
          </p>
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
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
