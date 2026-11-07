"use client";

import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { LogOutIcon } from "lucide-react";
import { StandaloneShell } from "@/components/standalone-shell";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { useSignOut } from "@/hooks/use-sign-out";

/**
 * The onboarding frame: the navy bar named "Setup", and one 560px column
 * near the top of the paper. The column is the container its cards fold by.
 */
export function OnboardingShell({
  signOut = false,
  children,
}: {
  /** A ghost Sign out in the bar while someone is signed in (the connect page). */
  signOut?: boolean;
  children: React.ReactNode;
}) {
  return (
    <StandaloneShell
      area="Setup"
      homeHref="/"
      className="@container/setup items-center"
      controls={
        <>
          <ThemeToggle />
          {signOut ? <BarSignOut /> : null}
        </>
      }
    >
      <div className="@container flex w-full max-w-[560px] min-w-0 flex-col gap-3.5 pt-2 pb-6 @2xl/setup:pt-9">
        {children}
      </div>
    </StandaloneShell>
  );
}

/** Sign out in the bar's ink; nothing while signed out. */
function BarSignOut() {
  const { user } = useAuth();
  const signOut = useSignOut();
  if (!user) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-8 px-2.5 text-[13px] text-board-muted hover:bg-sidebar-accent hover:text-board-foreground"
      onClick={() => void signOut()}
    >
      <LogOutIcon data-icon="inline-start" aria-hidden="true" />
      Sign out
    </Button>
  );
}
