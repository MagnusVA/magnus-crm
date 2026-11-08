import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { HelpTip, LABEL } from "@/app/workspace/team/_components/team-ui";
import { cn } from "@/lib/utils";

// The action dialogs' frame (DESIGN.md, Form and Settings Cards; the correction
// dialog and the tenant delete dialog are the models). A dialog is a header that
// names the record, ruled `Field` rows or dense facts, and a paper footer.
// Risky actions (payment, lost, no-show, void, delete) name the record, say what
// happens, then confirm. No hooks here, so any dialog can use it.

/** `DialogContent` for an action dialog: no padding, rows run edge to edge. */
export const ACTION_DIALOG = "gap-0 overflow-hidden p-0 sm:max-w-lg";
/** A wider frame for forms with many rows. */
export const ACTION_DIALOG_WIDE = "gap-0 overflow-hidden p-0 sm:max-w-xl";

/**
 * The header: a 17px title that names the record, and one 13px line under it.
 * `tone="danger"` sets the line in danger ink, for what can't be undone.
 */
export function ActionDialogHeader({
  title,
  description,
  tone = "muted",
}: {
  title: ReactNode;
  description?: ReactNode;
  tone?: "muted" | "danger";
}) {
  return (
    <DialogHeader className="gap-1 border-b px-4 pt-4 pr-12 pb-3.5 text-left">
      <DialogTitle className="text-[17px] leading-snug font-semibold text-balance">{title}</DialogTitle>
      {description ? (
        <DialogDescription
          className={cn("text-[13px] leading-[1.45]", tone === "danger" ? "text-danger-ink" : "text-muted-foreground")}
        >
          {description}
        </DialogDescription>
      ) : null}
    </DialogHeader>
  );
}

/** The `<form>` under the header: the container the rows fold by. */
export const ACTION_FORM = "@container flex min-h-0 flex-col";

/** Ruled rows that scroll inside the dialog when they run long. */
export function FormRows({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <FieldGroup className={cn("max-h-[min(60vh,34rem)] gap-0 divide-y overflow-y-auto", className)}>
      {children}
    </FieldGroup>
  );
}

const ROW =
  "grid gap-1.5 px-4 py-3 data-[invalid=true]:text-foreground @lg:grid-cols-[7.5rem_minmax(0,1fr)] @lg:items-start @lg:gap-x-3";
const ROW_LABEL = "text-[13px] leading-snug font-normal text-muted-foreground @lg:min-h-8 @lg:items-center";
/** Field errors in danger ink, which reads at 4.5:1 where the fill red doesn't. */
export const FIELD_ERROR = "text-[13px] text-danger-ink";

/**
 * One ruled form row: a 13px slate label in a 120px column beside the control
 * from `@lg`, over it narrower; the description and the error under the control.
 * `labelHidden` keeps the label for screen readers only and gives the control
 * the full width (when the header already names what the row asks for).
 */
export function FormRow({
  label,
  htmlFor,
  tip,
  invalid,
  error,
  description,
  labelHidden,
  children,
  className,
}: {
  label: ReactNode;
  /** The control's id. Leave it out for a group (radio, checkboxes) labelled another way. */
  htmlFor?: string;
  tip?: ReactNode;
  invalid?: boolean;
  /** A react-hook-form `fieldState.error`, or any `{ message }`. */
  error?: { message?: string } | undefined;
  description?: ReactNode;
  labelHidden?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const labelContent = tip ? <HelpTip tip={tip}>{label}</HelpTip> : label;
  return (
    <Field data-invalid={invalid || undefined} className={cn(ROW, labelHidden && "@lg:grid-cols-1", className)}>
      {htmlFor ? (
        <FieldLabel htmlFor={htmlFor} className={cn(ROW_LABEL, labelHidden && "sr-only")}>
          {labelContent}
        </FieldLabel>
      ) : (
        <div className={cn(ROW_LABEL, "flex", labelHidden && "sr-only")}>{labelContent}</div>
      )}
      <div className="flex min-w-0 flex-col gap-1.5">
        {children}
        {description ? (
          <FieldDescription className="text-[13px] leading-[1.45] text-muted-foreground">{description}</FieldDescription>
        ) : null}
        <FieldError className={FIELD_ERROR} errors={[error]} />
      </div>
    </Field>
  );
}

/** A submit failure, at the top of the form, in danger ink. */
export function SubmitError({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="border-b px-4 py-3 text-[13px] leading-[1.45] text-danger-ink">
      {children}
    </p>
  );
}

/** A ruled 13px note across the dialog: what a choice changes, or why it can't go ahead. */
export function DialogNote({
  tone = "muted",
  children,
}: {
  tone?: "muted" | "warning" | "danger";
  children: ReactNode;
}) {
  return (
    <p
      role={tone === "muted" ? undefined : "status"}
      className={cn(
        "border-b px-4 py-3 text-[13px] leading-[1.45]",
        tone === "warning" && "bg-warning-surface font-medium text-warning-ink",
        tone === "danger" && "text-danger-ink",
        tone === "muted" && "text-muted-foreground",
      )}
    >
      {children}
    </p>
  );
}

/** A group of dense facts about the record, ruled below. */
export function RecordFacts({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn("border-b py-1", className)}>{children}</dl>;
}

/** One dense fact: a slate label column beside the value, about 32px. */
export function RecordFact({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="grid min-h-8 grid-cols-[7.5rem_minmax(0,1fr)] items-baseline gap-x-3 px-4 py-1.5">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

/** An amount or time in a fact: condensed, tabular. */
export const FACT_FIGURE = "font-condensed text-[15px] leading-none font-semibold tabular-nums";

/** "What happens": the consequences in the order the server applies them, as ruled numbered rows. */
export function WhatHappens({ steps, label = "What happens" }: { steps: ReactNode[]; label?: string }) {
  return (
    <div className="border-b pt-2.5">
      <p className={`${LABEL} px-4 pb-1.5`}>{label}</p>
      <ol className="text-[13px] leading-[1.45]">
        {steps.map((step, index) => (
          <li key={index} className="flex gap-2.5 border-t px-4 py-[7px]">
            <span className="w-3 shrink-0 font-condensed text-[14px] font-semibold text-muted-foreground tabular-nums">
              {index + 1}
            </span>
            <span className="min-w-0">{step}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The footer: a paper band, ruled above, Cancel then the action on the right. */
export function ActionDialogFooter({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 border-t bg-background px-4 py-3">
      {aside ? <div className="mr-auto min-w-0 text-[13px] text-muted-foreground">{aside}</div> : null}
      <div className="flex flex-wrap items-center justify-end gap-2">{children}</div>
    </div>
  );
}

/** The footer's action. `danger` for what can't be undone (lost, no-show, void, delete). */
export function SubmitButton({
  pending,
  pendingLabel,
  danger,
  disabled,
  type = "submit",
  onClick,
  children,
}: {
  pending: boolean;
  /** "Saving…", "Deleting…": what the button says while the server works. */
  pendingLabel: string;
  danger?: boolean;
  disabled?: boolean;
  type?: "submit" | "button";
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      type={type}
      onClick={onClick}
      variant={danger ? "destructive" : "default"}
      disabled={pending || disabled}
      className={cn("font-semibold", danger && "text-danger-ink")}
    >
      {pending ? <Spinner data-icon="inline-start" /> : null}
      {pending ? pendingLabel : children}
    </Button>
  );
}

/** The footer's outline Cancel (or Back, on a confirm step). */
export function CancelButton({
  disabled,
  onClick,
  children = "Cancel",
}: {
  disabled?: boolean;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <Button type="button" variant="outline" onClick={onClick} disabled={disabled}>
      {children}
    </Button>
  );
}
