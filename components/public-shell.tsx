import Link from "next/link";
import { StandaloneShell } from "@/components/standalone-shell";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";

/** A ghost button in the navy bar's inks, as System admin's Sign out. */
const BAR_BUTTON =
  "h-9 px-2.5 text-[13px] text-board-muted hover:bg-board-foreground/10 hover:text-board-foreground dark:hover:bg-board-foreground/10";

const FOOTER_LINKS = [
  { href: "/privacy", label: "Privacy" },
  { href: "/support", label: "Support" },
] as const;

/**
 * The frame for the public pages (landing, privacy, support): the navy
 * `StandaloneShell` bar with the theme toggle and a ghost Sign in, one 720px
 * column near the top of the paper, and a 13px footer line of links at the
 * foot. The column is the container its cards fold by.
 */
export function PublicShell({
  signIn = true,
  current,
  children,
}: {
  /** A ghost Sign in in the bar. The landing page sets its own, so it passes false. */
  signIn?: boolean;
  /** The page's own footer link, left out of the footer. */
  current?: (typeof FOOTER_LINKS)[number]["href"];
  children: React.ReactNode;
}) {
  return (
    <StandaloneShell
      homeHref="/"
      className="@container/public items-center"
      controls={
        <>
          <ThemeToggle />
          {signIn ? (
            <Button asChild variant="ghost" className={BAR_BUTTON}>
              <a href="/sign-in">Sign in</a>
            </Button>
          ) : null}
        </>
      }
    >
      <div className="@container flex w-full max-w-[720px] min-w-0 flex-1 flex-col gap-3.5 pt-2 pb-2 short:gap-3 @2xl/public:pt-9">
        {children}
        <footer className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 pt-6 text-[13px] text-muted-foreground">
          <span>Magnus CRM</span>
          {FOOTER_LINKS.filter((link) => link.href !== current).map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="inline-flex min-h-6 items-center rounded-sm underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {link.label}
            </Link>
          ))}
        </footer>
      </div>
    </StandaloneShell>
  );
}
