import Link from "next/link";
import { MagnusBrand } from "@/components/magnus-brand";
import { cn } from "@/lib/utils";

/**
 * The frame for pages outside the workspace (System admin, onboarding): a
 * 52px navy bar with the mark and wordmark as the sidebar sets them, the
 * area's name, and the page's own controls on the right, over the paper.
 * The bar is navy in both themes; its inner `dark` scopes the dark theme's
 * inks and focus rings to it, as the page band does.
 */
export function StandaloneShell({
  area,
  homeHref = "/",
  controls,
  children,
  className,
}: {
  /** The area's name beside the wordmark: "System admin", "Setup". */
  area?: string;
  homeHref?: string;
  /** Right of the bar: the theme toggle, Sign out. */
  controls?: React.ReactNode;
  children: React.ReactNode;
  /** For `main`. */
  className?: string;
}) {
  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="sticky top-0 z-20 bg-sidebar text-sidebar-foreground">
        <div className="dark flex h-[52px] items-center gap-3 px-4 sm:px-6">
          <Link
            href={homeHref}
            aria-label="Magnus home"
            className="-ml-1 flex min-h-9 items-center rounded-md px-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <MagnusBrand
              label="Magnus"
              size="xs"
              markVariant="lime"
              markClassName="size-6"
              textClassName="font-condensed text-[22px] font-semibold tracking-[0.01em] text-sidebar-foreground"
            />
          </Link>
          {area ? (
            <span className="truncate border-l border-board-line pl-3 text-[14px] text-board-muted">{area}</span>
          ) : null}
          {controls ? <div className="ml-auto flex shrink-0 items-center gap-1">{controls}</div> : null}
        </div>
      </header>
      <main className={cn("page-inset flex flex-1 flex-col", className)}>{children}</main>
    </div>
  );
}
