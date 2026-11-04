"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { toast } from "sonner";
import posthog from "posthog-js";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";
import { cn } from "@/lib/utils";
import { CARD, HelpTip, Initials } from "../team-ui";

// Team › Review: the pieces every kind of item shares.

/** One card per kind: title, what it holds, and "3 TO DECIDE" at the right. */
export function ReviewSection({
  id,
  title,
  tip,
  meta,
  count,
  children,
}: {
  id: string;
  title: string;
  tip: ReactNode;
  meta: ReactNode;
  count: number;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={CARD}>
      <div className="flex min-h-11 flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-border px-4 py-2">
        <h2 id={`${id}-title`} className="text-[15px] font-semibold">
          <HelpTip tip={tip} side="bottom">
            {title}
          </HelpTip>
        </h2>
        <span className="text-[13px] text-muted-foreground">{meta}</span>
        <span className="ml-auto font-condensed text-[13px] font-bold tracking-[0.08em] whitespace-nowrap text-warning-ink uppercase tabular-nums">
          {count} to decide
        </span>
      </div>
      <ul className="flex flex-col">{children}</ul>
    </section>
  );
}

/**
 * One decision: what it is about on the left, the choices on the right, and
 * a line under both saying why it's here and what each choice changes. The
 * choices drop under the subject when the card is narrow.
 */
export function ReviewRow({
  subject,
  actions,
  why,
  busy,
}: {
  subject: ReactNode;
  actions: ReactNode;
  why: ReactNode;
  busy?: boolean;
}) {
  return (
    <li
      aria-busy={busy || undefined}
      className={cn(
        "grid grid-cols-1 items-center gap-x-4 gap-y-2.5 border-b border-border px-4 py-3.5 transition-opacity last:border-b-0 @4xl:grid-cols-[minmax(0,1fr)_auto]",
        busy && "opacity-60",
      )}
    >
      <div className="min-w-0">{subject}</div>
      <div className="flex flex-wrap items-center gap-2 @4xl:justify-end">{actions}</div>
      <div className="flex flex-wrap items-center gap-1.5 text-[12.5px] leading-snug text-muted-foreground @4xl:col-span-2">
        {why}
      </div>
    </li>
  );
}

/** A team member's name that opens their card. */
export function MemberLink({ href, name, className }: { href: string; name: string; className?: string }) {
  return (
    <Link
      href={href}
      scroll={false}
      className={cn(
        "truncate rounded-[3px] font-semibold underline decoration-foreground/0 underline-offset-2 outline-none hover:decoration-foreground/40 focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {name}
    </Link>
  );
}

/** A small bordered card: initials, the name (opens the card), one line under it. */
export function MiniCard({
  name,
  href,
  line,
  status,
  bare,
}: {
  name: string;
  /** Opens the member's card; none for a member the card can't show. */
  href?: string;
  line: ReactNode;
  status?: ReactNode;
  /** No border: the subject of a row rather than one of a pair. */
  bare?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2.5",
        !bare && "rounded-lg border border-border px-2.5 py-2",
      )}
    >
      <Initials name={name} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-2 text-[14px]">
          {href ? <MemberLink href={href} name={name} /> : <span className="truncate font-semibold">{name}</span>}
          {status}
        </span>
        <span className="truncate text-[12.5px] text-muted-foreground">{line}</span>
      </div>
    </div>
  );
}

/** A reason chip (SAME EMAIL) that explains itself on hover and focus. */
export function ReasonChip({ label, tip }: { label: string; tip: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="inline-flex h-5 cursor-help items-center rounded-[4px] border border-border bg-card px-1.5 font-condensed text-[11px] font-bold tracking-[0.1em] whitespace-nowrap text-foreground uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[17rem] text-[12.5px] leading-snug">
        {tip}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Run a reversible review action: a success toast with Undo, and errors in a
 * toast. Returns whether the action went through.
 */
export async function runWithUndo<T>({
  run,
  undo,
  message,
  flow,
  failure,
  event,
}: {
  run: () => Promise<T>;
  undo: (result: T) => Promise<unknown>;
  message: (result: T) => string;
  flow: string;
  failure: string;
  event?: Record<string, unknown>;
}) {
  try {
    const result = await run();
    posthog.capture(flow, event);
    toast.success(message(result), {
      // Twice sonner's default: long enough to read what changed and take it back.
      duration: 8000,
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
    toast.error(getErrorMessage(error, failure));
    return false;
  }
}
