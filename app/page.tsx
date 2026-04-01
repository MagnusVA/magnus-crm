"use client";

import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useConvexAuth } from "convex/react";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { SYSTEM_ADMIN_ORG_ID } from "@/lib/system-admin-org";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOT_GRID =
  "radial-gradient(circle, oklch(1 0 0 / 0.03) 1px, transparent 1px)";

const STEPS = [
  "Admin provisions a tenant org and invite",
  "Tenant master redeems invite and signs up",
  "Calendly connection completes workspace setup",
] as const;

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Home() {
  const router = useRouter();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { user, organizationId } = useAuth();

  useEffect(() => {
    if (isLoading || !isAuthenticated || !user) return;

    if (organizationId === SYSTEM_ADMIN_ORG_ID) {
      router.replace("/admin");
      return;
    }

    router.replace("/onboarding/connect");
  }, [isAuthenticated, isLoading, organizationId, router, user]);

  // Authenticated users are being redirected — show a loading pill
  if (isLoading || (isAuthenticated && user)) {
    return (
      <div
        className="flex min-h-screen items-center justify-center bg-background"
        role="status"
      >
        <div className="flex items-center gap-3 rounded-full border border-border bg-card px-5 py-3 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Routing your workspace&hellip;
        </div>
      </div>
    );
  }

  // Unauthenticated landing
  return (
    <div
      className="flex min-h-screen flex-col bg-background"
      style={{ backgroundImage: DOT_GRID, backgroundSize: "24px 24px" }}
    >
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-5">
        <span className="text-xs font-semibold uppercase tracking-[0.3em] text-muted-foreground">
          Magnus CRM
        </span>
        <div className="flex gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/sign-in">Sign In</Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/sign-up">Create Account</Link>
          </Button>
        </div>
      </header>

      {/* Hero */}
      <main className="flex flex-1 flex-col items-center justify-center px-4 py-16">
        <div className="w-full max-w-lg space-y-10 text-center motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3 motion-safe:duration-600">
          <div className="space-y-4">
            <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl text-balance">
              Onboard Operators Fast. Keep&nbsp;Tenant Setup Under&nbsp;Control.
            </h1>
            <p className="mx-auto max-w-md text-sm leading-relaxed text-muted-foreground text-pretty">
              WorkOS handles identity, Convex handles tenant state, and Calendly
              onboarding is staged so each account starts with a clean audit
              trail.
            </p>
          </div>

          {/* Steps */}
          <ol className="space-y-2 text-left" role="list">
            {STEPS.map((step, idx) => (
              <li
                key={step}
                className="flex items-center gap-3 rounded-md border border-border bg-card px-4 py-3 text-sm text-card-foreground motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-400"
                style={{ animationDelay: `${300 + idx * 100}ms` }}
              >
                <span
                  className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold tabular-nums text-primary"
                  aria-hidden="true"
                >
                  {idx + 1}
                </span>
                <span className="min-w-0">{step}</span>
              </li>
            ))}
          </ol>

          {/* CTA */}
          <div className="flex flex-col items-center gap-3">
            <Button asChild size="lg" className="gap-2">
              <Link href="/admin">
                Open Admin Console
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
            </Button>
            <p className="text-xs text-muted-foreground">
              System admins manage tenants. Tenant users are routed into
              onboarding.
            </p>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="px-6 pb-5">
        <p className="text-[11px] text-muted-foreground/60">
          Magnus CRM &middot; Tenant onboarding control plane
        </p>
      </footer>
    </div>
  );
}
