"use client";
import { useId, useState } from "react";
import { useMutation } from "convex/react";
import { useForm, Controller } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldError,
} from "@/components/ui/field";
import { getErrorMessage } from "@/lib/errors";
const noteSchema = z.object({
  note: z.string().trim().min(1, "Write a note.").max(2000),
});
export function CloserOpinionNote({
  secondOpinionId,
}: {
  secondOpinionId: Id<"secondOpinions">;
}) {
  const send = useMutation(api.secondOpinion.addCloserNote);
  const id = useId();
  const [busy, setBusy] = useState(false);
  const form = useForm({
    resolver: standardSchemaResolver(noteSchema),
    defaultValues: { note: "" },
  });
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={form.handleSubmit(async (values) => {
        setBusy(true);
        try {
          await send({ secondOpinionId, note: values.note });
        } catch (error) {
          toast.error(getErrorMessage(error, "Could not send your note."));
        } finally {
          setBusy(false);
        }
      })}
    >
      <FieldGroup>
        <Controller
          control={form.control}
          name="note"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor={id}>Add a note for the admin</FieldLabel>
              <Textarea
                {...field}
                id={id}
                maxLength={2000}
                aria-invalid={fieldState.invalid}
              />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
      </FieldGroup>
      <Button type="submit" disabled={busy} className="self-end">
        {busy ? "Sending…" : "Send"}
      </Button>
    </form>
  );
}
