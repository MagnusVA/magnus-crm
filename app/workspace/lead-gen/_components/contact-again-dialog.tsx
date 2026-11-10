"use client";

import { useId, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Controller, useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { ContactAgainView } from "@/convex/leadGen/contactAgain";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useCurrentBusinessDate } from "@/hooks/use-current-business-date";
import { addBusinessDays } from "@/lib/businessDay";
import { ContactAgainNote } from "./respark-ui";
import { getErrorMessage } from "@/lib/errors";

type Target =
  | { submissionId: Id<"leadGenSubmissions">; itemId?: never; leadId?: never }
  | { itemId: Id<"resparkBatchItems">; submissionId?: never; leadId?: never }
  | { leadId: Id<"leads">; submissionId?: never; itemId?: never };
const formSchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date."), note: z.string().trim().min(1, "Write a short note.").max(500, "Keep the note to 500 characters.") });

/** Includes its trigger, safe read, save and clear. Mount with a submissionId or itemId. */
export function ContactAgainDialog(target: Target) {
  const [open, setOpen] = useState(false);
  const { setting } = useBusinessDay("lead-gen");
  const currentBusinessDate = useCurrentBusinessDate(setting);
  const current = useQuery(api.leadGen.contactAgain.getContactAgain, open ? { ...target, currentBusinessDate } : "skip");
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button size="xs" variant="outline">Contact again</Button></DialogTrigger>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Contact again</DialogTitle>
        <DialogDescription>Until this date, nobody can pick this person in a new respark batch or mark them resparked. If you just sent a message from your batch, mark them resparked first, then save the date.</DialogDescription>
      </DialogHeader>
      {current === undefined ? <p role="status">Loading date…</p> : current.hidden ? <p>This person can&apos;t have a contact-again date.</p> : !current.canEdit ? (current.contactAgain ? <ContactAgainNote saved={current.contactAgain} /> : <p>No contact-again date is saved.</p>) :
        <DateForm key={JSON.stringify(current.contactAgain)} target={target} saved={current.contactAgain} min={addBusinessDays(currentBusinessDate, 1)} onClose={() => setOpen(false)} />}
    </DialogContent>
  </Dialog>;
}

function DateForm({ target, saved, min, onClose }: { target: Target; saved: ContactAgainView | null; min: string; onClose: () => void }) {
  const ids = useId();
  const save = useMutation(api.leadGen.contactAgain.setContactAgain);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const form = useForm({ resolver: standardSchemaResolver(formSchema), defaultValues: { date: saved?.date ?? "", note: saved?.note?.text ?? "" } });
  const busy = clearing || form.formState.isSubmitting;
  const submit = async (values: z.infer<typeof formSchema>) => {
    setError(null);
    try { await save({ ...target, ...values }); onClose(); }
    catch (cause) { setError(getErrorMessage(cause, "Couldn't save the date.")); }
  };
  const clear = async () => {
    setError(null); setClearing(true);
    try { await save({ ...target, date: null }); onClose(); }
    catch (cause) { setError(getErrorMessage(cause, "Couldn't clear the date.")); }
    finally { setClearing(false); }
  };
  return <form onSubmit={form.handleSubmit(submit)} className="flex flex-col gap-4">
    <FieldGroup>
      <Controller control={form.control} name="date" render={({ field, fieldState }) => <Field data-invalid={fieldState.invalid}>
        <FieldLabel htmlFor={`${ids}-date`}>Date</FieldLabel>
        <Input {...field} id={`${ids}-date`} type="date" min={min} aria-invalid={fieldState.invalid} disabled={busy} />
        <FieldDescription>Uses the team&apos;s business day.</FieldDescription>
        <FieldError errors={[fieldState.error]} />
      </Field>} />
      <Controller control={form.control} name="note" render={({ field, fieldState }) => <Field data-invalid={fieldState.invalid}>
        <FieldLabel htmlFor={`${ids}-note`}>Note</FieldLabel>
        <Textarea {...field} id={`${ids}-note`} maxLength={500} aria-invalid={fieldState.invalid} disabled={busy} />
        <FieldDescription>Why this date? Closers and admins can read this note.</FieldDescription>
        <FieldError errors={[fieldState.error]} />
      </Field>} />
    </FieldGroup>
    {saved?.withheldReason ? <p>The saved note can&apos;t be shown. Write a new note to replace it, or clear the date.</p> : null}
    {error ? <p role="alert" className="text-destructive">{error}</p> : null}
    <DialogFooter>
      {saved ? <Button type="button" variant="outline" onClick={() => void clear()} disabled={busy}>Clear date</Button> : null}
      <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
      <Button type="submit" disabled={busy}>{busy ? <Spinner data-icon="inline-start" /> : null}Save date</Button>
    </DialogFooter>
  </form>;
}
