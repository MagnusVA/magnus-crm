import type { ReactNode } from "react";
import { AlertCircleIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** A section's failure, said in place of its content. */
export function SectionError({
  what,
  className,
}: {
  what: string;
  className?: string;
}) {
  return (
    <div role="alert" className={cn("flex items-start gap-2 px-4 py-3 text-sm", className)}>
      <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-danger-ink" aria-hidden="true" />
      <p>
        Couldn&apos;t load {what}. Reload the page to try again.
      </p>
    </div>
  );
}

/** A section with nothing in it: one line, and a hint when it helps. */
export function SectionEmpty({
  title,
  children,
  className,
}: {
  title: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-0.5 px-4 py-4 text-sm", className)}>
      <p className="font-medium">{title}</p>
      {children ? <div className="text-muted-foreground">{children}</div> : null}
    </div>
  );
}
