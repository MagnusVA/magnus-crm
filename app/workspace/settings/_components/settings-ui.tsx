import type { ReactNode } from "react";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { HelpTip } from "@/app/workspace/team/_components/team-ui";
import { cn } from "@/lib/utils";

// Pieces shared by the Settings tabs (DESIGN.md, Form and Settings Cards).
// No hooks here, so loading.tsx can draw the same frame.

/** The page root: the container every tab folds by, on an 1100px measure. */
export const SETTINGS_ROOT =
  "@container mx-auto flex w-full max-w-[1100px] min-w-0 flex-col gap-3.5 pb-6 short:gap-3";

export type Tone = "ok" | "warning" | "danger" | "muted";

const TONE: Record<Tone, string> = {
  ok: "text-foreground",
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

/** A group of dense facts, split from the next group by a rule. */
export function Facts({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn("border-b border-border py-1 last:border-b-0", className)}>{children}</dl>;
}

/** One fact: a ~110px slate label beside its value, about 32px tall. */
export function Fact({
  label,
  tip,
  title,
  children,
}: {
  label: string;
  tip?: ReactNode;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid min-h-8 grid-cols-[6.875rem_minmax(0,1fr)] items-baseline gap-x-3 px-4 py-1.5">
      <dt className="text-[13px] text-muted-foreground">{tip ? <HelpTip tip={tip}>{label}</HelpTip> : label}</dt>
      <dd className="min-w-0 text-sm" title={title}>
        {children}
      </dd>
    </div>
  );
}

/** A time or count in a fact: condensed, tabular. */
export const FACT_FIGURE = "font-condensed text-[15px] leading-none font-semibold tabular-nums";

/** A 13px line in a card: what a section says about itself, or why it can't act. */
export function NoteLine({
  tone = "muted",
  role,
  children,
  className,
}: {
  tone?: Tone;
  role?: "status" | "alert";
  children: ReactNode;
  className?: string;
}) {
  return (
    <p role={role} className={cn("text-[13px] leading-[1.45]", TONE[tone], className)}>
      {children}
    </p>
  );
}

/** A card's 40px footer row of actions, ruled above. */
export function ActionRow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-h-10 flex-wrap items-center gap-1.5 border-t border-border px-4 py-1.5", className)}>
      {children}
    </div>
  );
}

/** A form card's footer: a paper band, ruled above, the save on the right. */
export function FormFooter({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 border-t border-border bg-background px-4 py-3">
      {aside ? <div className="mr-auto min-w-0 text-[13px] text-muted-foreground">{aside}</div> : null}
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

const ROW =
  "grid gap-1.5 px-4 py-3 data-[invalid=true]:text-foreground @lg:grid-cols-[7.5rem_minmax(0,1fr)] @lg:items-start @lg:gap-x-3 @4xl:grid-cols-[7.5rem_minmax(0,20rem)_minmax(0,1fr)] @4xl:gap-x-5";

/**
 * A ruled form row: a 13px slate label in a 120px column beside the control
 * from `@lg` (over it narrower), and the description under the control, or
 * beside it from `@4xl` where the card is wide.
 */
export function SettingRow({
  label,
  tip,
  htmlFor,
  invalid,
  description,
  descriptionLive,
  children,
}: {
  label: string;
  tip?: ReactNode;
  htmlFor: string;
  invalid?: boolean;
  description?: ReactNode;
  /** Announce description changes (a live count). */
  descriptionLive?: boolean;
  children: ReactNode;
}) {
  return (
    <Field data-invalid={invalid || undefined} className={ROW}>
      <FieldLabel htmlFor={htmlFor} className="text-[13px] font-normal text-muted-foreground @lg:min-h-8 @lg:items-center">
        {tip ? <HelpTip tip={tip}>{label}</HelpTip> : label}
      </FieldLabel>
      <div className="min-w-0">{children}</div>
      {description ? (
        <FieldDescription
          aria-live={descriptionLive ? "polite" : undefined}
          className={cn(
            "mt-0! text-[13px] leading-[1.45] @lg:col-start-2 @4xl:col-start-3 @4xl:row-start-1 @4xl:flex @4xl:min-h-8 @4xl:items-center",
            invalid ? "text-danger-ink" : "text-muted-foreground",
          )}
        >
          <span>{description}</span>
        </FieldDescription>
      ) : null}
    </Field>
  );
}
