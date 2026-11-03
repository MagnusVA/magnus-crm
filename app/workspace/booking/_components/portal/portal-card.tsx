import { TriangleAlertIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// Concept C's card: a 44px head with the title and a one-line meta, ruled
// rows, and a muted foot.

export function PortalCard({
  id,
  title,
  meta,
  right,
  className,
  children,
}: {
  id?: string;
  title: string;
  meta?: React.ReactNode;
  right?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={id ? `${id}-title` : undefined}
      className={cn("flex min-w-0 flex-col overflow-hidden rounded-[10px] border border-border bg-card", className)}
    >
      <div className="flex min-h-11 flex-none items-center gap-3 border-b border-border px-4 py-1.5">
        <h2 id={id ? `${id}-title` : undefined} className="text-[15px] font-semibold whitespace-nowrap">
          {title}
        </h2>
        {meta ? <span className="min-w-0 truncate text-[13px] text-muted-foreground">{meta}</span> : null}
        {right ? <div className="ml-auto flex flex-none items-center gap-2">{right}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** A ruled row: grows on the left, controls on the right. */
export function PortalRow({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("flex min-h-11 items-center gap-2.5 border-b border-border px-4 py-2.5 last:border-b-0", className)}>
      {children}
    </div>
  );
}

export function RowText({ title, detail }: { title: React.ReactNode; detail?: React.ReactNode }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="text-[13.5px] font-medium">{title}</div>
      {detail ? <div className="text-[12px] text-muted-foreground">{detail}</div> : null}
    </div>
  );
}

export function PortalCardFoot({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("flex flex-none items-center gap-2.5 border-t border-border bg-card px-4 py-2 text-[13px] text-muted-foreground", className)}>
      {children}
    </div>
  );
}

/** The amber "are you sure" strip that opens under a row (rotations). */
export function ConfirmStrip({ children, actions }: { children: React.ReactNode; actions: React.ReactNode }) {
  return (
    <div
      role="alert"
      className="cov-row-in flex flex-wrap items-center gap-2.5 border-t border-[#f1dc94] bg-warning-surface px-4 py-2.5 text-[13px] text-warning-ink dark:border-warning/30"
    >
      <TriangleAlertIcon aria-hidden className="size-[15px] flex-none" />
      <span className="min-w-0 flex-1 basis-48">{children}</span>
      <div className="flex flex-none gap-1.5">{actions}</div>
    </div>
  );
}

/** Small buttons in C's sizes (32px, or 26px with `sm`). */
export function cardButton({ size = "md", tone = "plain" }: { size?: "md" | "sm"; tone?: "plain" | "ink" } = {}) {
  return cn(
    "inline-flex flex-none items-center gap-1.5 rounded-[7px] border font-medium whitespace-nowrap outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-50",
    size === "sm" ? "h-[26px] rounded-[5.6px] px-2 text-[12.5px]" : "h-8 px-[11px] text-[13.5px]",
    tone === "ink"
      ? "border-foreground bg-foreground text-background hover:bg-foreground/85"
      : "border-input bg-background hover:border-foreground/25 hover:bg-card",
  );
}

/** 26px square icon button. */
export const ICON_BUTTON =
  "grid size-[26px] flex-none place-items-center rounded-[5.6px] text-muted-foreground outline-none hover:bg-card hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
