import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * A ruled white card with a 44px title row, the meeting page's one card
 * shape. Built on the shadcn Card so tokens and dark mode carry through.
 */
export function DetailCard({
  title,
  badge,
  meta,
  titleId,
  className,
  children,
  ...props
}: {
  title: React.ReactNode;
  /** Sits right after the title, such as the deal's stage chip. */
  badge?: React.ReactNode;
  meta?: React.ReactNode;
  titleId?: string;
  className?: string;
  children: React.ReactNode;
} & Omit<React.ComponentProps<"div">, "title">) {
  return (
    <Card className={cn("gap-0 py-0", className)} {...props}>
      <div className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-2">
        <h2 id={titleId} className="text-[0.9375rem] font-semibold">
          {title}
        </h2>
        {badge}
        {meta ? (
          <div className="ml-auto flex min-w-0 items-center gap-2 text-[0.8125rem] text-muted-foreground">
            {meta}
          </div>
        ) : null}
      </div>
      {children}
    </Card>
  );
}

/** The ruled footer row of a DetailCard: a fact on the left, a link on the right. */
export function DetailCardFooter({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex min-h-10 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t px-4 py-2 font-medium text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Underlined text link, the cards' secondary action. */
export const detailLinkClass =
  "inline-flex min-h-6 items-center rounded-sm font-semibold text-foreground underline underline-offset-[3px] decoration-foreground/40 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
