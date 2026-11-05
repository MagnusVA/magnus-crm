"use client";

import type { ReactNode } from "react";
import { toast } from "sonner";
import posthog from "@/lib/posthog-browser";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";
import { cn } from "@/lib/utils";
import { HelpTip, LABEL } from "../team-ui";

// Layout pieces the member card's sections share.

/** One ruled section of the card: a title row with its meta, then the body. */
export function CardSection({
  id,
  title,
  meta,
  action,
  children,
}: {
  id?: string;
  title: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-2 border-t border-border px-5 pt-3.5 pb-4 first:border-t-0" aria-label={typeof title === "string" ? title : undefined}>
      <div className="mb-2.5 flex min-h-7 flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h3 className="text-[15px] font-semibold">{title}</h3>
        {meta ? <span className="text-[13px] text-muted-foreground">{meta}</span> : null}
        {action ? <span className="ml-auto flex items-center gap-2">{action}</span> : null}
      </div>
      {children}
    </section>
  );
}

/** The white ruled frame a section's rows sit in. */
export function RuledBlock({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("overflow-hidden rounded-lg border border-border bg-card", className)}>{children}</div>;
}

/**
 * A labelled row in a ruled block: the label (with hover help), what it holds
 * and a second line, then its actions. Narrow cards put the actions under it.
 */
export function RecordRow({
  label,
  tip,
  primary,
  secondary,
  actions,
  className,
}: {
  label: string;
  tip: ReactNode;
  primary: ReactNode;
  secondary?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid min-h-14 grid-cols-1 items-center gap-x-4 gap-y-1.5 border-t border-border px-3 py-2.5 first:border-t-0 @lg/card:grid-cols-[8.5rem_minmax(0,1fr)_auto]",
        className,
      )}
    >
      <span className={LABEL}>
        <HelpTip tip={tip}>{label}</HelpTip>
      </span>
      <div className="min-w-0">
        <div className="text-[14px] break-words">{primary}</div>
        {secondary ? <div className="text-[12.5px] text-muted-foreground">{secondary}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2 @lg/card:justify-end">{actions}</div> : null}
    </div>
  );
}

/** A field label above its control, with hover help. */
export function FieldLabel({ label, tip, htmlFor }: { label: string; tip: ReactNode; htmlFor?: string }) {
  const text = <HelpTip tip={tip}>{label}</HelpTip>;
  return htmlFor ? (
    <label htmlFor={htmlFor} className={LABEL}>
      {text}
    </label>
  ) : (
    <span className={LABEL}>{text}</span>
  );
}

/**
 * Run a save, then offer Undo in the toast. Errors land in a toast and in
 * PostHog; the Undo's own error does too.
 */
export async function saveWithUndo<T>({
  run,
  undo,
  message,
  description,
  flow,
  event,
}: {
  run: () => Promise<T>;
  undo: (result: T) => Promise<unknown>;
  message: string | ((result: T) => string);
  description?: string | ((result: T) => string | undefined);
  flow: string;
  event?: string;
}) {
  try {
    const result = await run();
    if (event) posthog.capture(event);
    toast.success(typeof message === "function" ? message(result) : message, {
      description: typeof description === "function" ? description(result) : description,
      action: {
        label: "Undo",
        onClick: () => {
          undo(result).catch((error: unknown) => {
            reportClientError(error, { flow: `${flow}_undo` });
            toast.error(getErrorMessage(error, "Couldn’t undo that change."));
          });
        },
      },
    });
    return true;
  } catch (error) {
    reportClientError(error, { flow });
    toast.error(getErrorMessage(error, "Couldn’t save that change."));
    return false;
  }
}
