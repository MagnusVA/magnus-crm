import type { ReactNode } from "react";
import { Spinner } from "@/components/ui/spinner";
import { CARD } from "@/app/workspace/team/_components/team-ui";
import { cn } from "@/lib/utils";

// Pieces shared by the two onboarding pages, in the Departures Board grammar
// (DESIGN.md, Form and Settings Cards).

export type Tone = "ink" | "warning" | "danger" | "muted";

const TONE: Record<Tone, string> = {
  ink: "text-foreground",
  warning: "text-warning-ink",
  danger: "text-danger-ink",
  muted: "text-muted-foreground",
};

/** One condensed status word, coloured by meaning. */
export function StatusWord({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "font-condensed text-[13px] leading-[1.1] font-bold tracking-[0.08em] whitespace-nowrap uppercase",
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** While something runs: one small ruled card, a slate spinner and one line. */
export function WaitCard({ children }: { children: ReactNode }) {
  return (
    <div role="status" className={cn(CARD, "flex min-h-11 items-center gap-2.5 px-4 py-2.5")}>
      <Spinner aria-hidden="true" className="text-muted-foreground" />
      <h1 className="text-sm">{children}</h1>
    </div>
  );
}

/**
 * A card that stands for the whole page (a problem, a blocked setup): a 44px
 * title row holding the page's h1 and one status word, one 14px line saying
 * what to do, then whatever facts and the footer the caller adds.
 */
export function NoticeCard({
  title,
  status,
  line,
  children,
}: {
  title: string;
  status?: ReactNode;
  line: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section aria-labelledby="setup-notice-title" className={CARD}>
      <div className="flex min-h-11 items-center gap-3 border-b border-border px-4 py-2">
        <h1 id="setup-notice-title" className="min-w-0 flex-1 text-[15px] font-semibold text-balance">
          {title}
        </h1>
        {status}
      </div>
      <p className="px-4 py-3 text-sm text-pretty">{line}</p>
      {children}
    </section>
  );
}

/** One dense fact: a 110px slate label beside its value, about 32px tall, ruled above. */
export function FactRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <dl className="border-t border-border py-1">
      <div className="grid min-h-8 grid-cols-[6.875rem_minmax(0,1fr)] items-baseline gap-x-3 px-4 py-1.5">
        <dt className="text-[13px] text-muted-foreground">{label}</dt>
        <dd className="min-w-0 text-sm font-medium text-pretty">{children}</dd>
      </div>
    </dl>
  );
}

/** A card's footer: a paper band, ruled above, a 13px slate line left and the actions right. */
export function CardFooter({ aside, children }: { aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 border-t border-border bg-background px-4 py-3">
      {aside ? <p className="mr-auto min-w-0 text-[13px] text-muted-foreground">{aside}</p> : null}
      <div className="flex flex-wrap items-center justify-end gap-2">{children}</div>
    </div>
  );
}
