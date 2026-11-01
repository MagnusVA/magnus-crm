import Link from "next/link";
import { ChevronLeftIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A page's header as a navy band, the board strips' sibling: the display
 * title, a 13px line saying what the page does, and an optional way back.
 * An optional primary action sits right of the title, and `children` (a
 * search field, tabs) under it. The band is dark in both themes; `dark` scopes the dark theme's inks and
 * focus rings to it (DESIGN.md, The Board Is Dark Rule).
 */
export function PageBand({
  title,
  titleId,
  description,
  back,
  actions,
  children,
  className,
}: {
  title: React.ReactNode;
  /** The h1's id, for a region labelled by it. */
  titleId?: string;
  description?: React.ReactNode;
  back?: { href: string; label: string };
  /** The page's primary action, right of the title (a lime button). */
  actions?: React.ReactNode;
  /** What the band holds under the title: Leads & Customers puts its search and tabs here. */
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "overflow-hidden rounded-xl bg-board text-board-foreground dark:ring-1 dark:ring-board-foreground/10",
        className,
      )}
    >
      <div
        className={cn(
          "dark flex flex-col gap-3 px-4 pt-3.5 @lg:px-[18px] @lg:pt-4",
          children ? null : "pb-3.5 @lg:pb-4",
        )}
      >
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-3">
        <div className="min-w-0 flex-1">
          {back ? (
            <Link
              href={back.href}
              className="-ml-1 mb-1.5 inline-flex min-h-6 items-center gap-1 rounded-sm pr-1.5 text-[13px] font-medium text-board-muted outline-none hover:text-board-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronLeftIcon className="size-4" aria-hidden="true" />
              {back.label}
            </Link>
          ) : null}
          <h1 id={titleId} className="text-[26px] leading-[1.1] font-semibold tracking-[-0.01em] text-balance">
            {title}
          </h1>
          {description ? (
            <p className="mt-1 text-[13px] text-board-muted">{description}</p>
          ) : null}
        </div>
        {actions}
        </div>
        {children}
      </div>
    </header>
  );
}
