"use client";

import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useConvexAuth, useMutation } from "convex/react";
import {
  ArrowRight,
  Calendar,
  CheckCircle2,
  Radio,
  Settings2,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";

import { OnboardingShell, PulsingDots } from "../_components/onboarding-shell";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RedeemState =
  | { status: "loading" }
  | { status: "ready"; companyName: string; alreadyRedeemed: boolean }
  | { status: "error"; message: string };

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ConnectCalendlyPage() {
  const { isAuthenticated, isLoading: convexLoading } = useConvexAuth();
  const { user, organizationId } = useAuth();
  const redeemInvite = useMutation(
    api.onboarding.complete.redeemInviteAndCreateUser,
  );
  const [state, setState] = useState<RedeemState>({ status: "loading" });

  useEffect(() => {
    let active = true;

    if (convexLoading) return;

    if (!isAuthenticated || !user) {
      setState({
        status: "error",
        message: "You need to sign in before completing onboarding.",
      });
      return;
    }

    const orgId =
      organizationId ??
      sessionStorage.getItem("onboarding_orgId") ??
      undefined;

    if (!orgId) {
      setState({
        status: "error",
        message:
          "No onboarding organization was found in your session. Restart onboarding from your invite link.",
      });
      return;
    }

    void redeemInvite({ workosOrgId: orgId })
      .then((result) => {
        if (!active) return;

        sessionStorage.removeItem("onboarding_orgId");
        sessionStorage.removeItem("onboarding_companyName");
        sessionStorage.removeItem("onboarding_tenantId");

        setState({
          status: "ready",
          companyName: result.companyName,
          alreadyRedeemed: result.alreadyRedeemed,
        });
      })
      .catch((error: unknown) => {
        if (!active) return;

        setState({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Unable to finish onboarding for this organization.",
        });
      });

    return () => {
      active = false;
    };
  }, [convexLoading, isAuthenticated, organizationId, redeemInvite, user]);

  return (
    <OnboardingShell>
      {state.status === "loading" ? (
        <LoadingCard />
      ) : state.status === "error" ? (
        <ErrorCard message={state.message} />
      ) : (
        <ConnectCard
          companyName={state.companyName}
          alreadyRedeemed={state.alreadyRedeemed}
        />
      )}
    </OnboardingShell>
  );
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function LoadingCard() {
  return (
    <div
      className="w-full max-w-sm motion-safe:animate-in motion-safe:fade-in motion-safe:duration-500"
      role="status"
    >
      <div className="space-y-6 rounded-lg border border-border bg-card p-8 text-center shadow-sm">
        <PulsingDots />
        <div className="space-y-2">
          <h1 className="text-lg font-semibold tracking-tight text-card-foreground">
            Finishing Account Setup
          </h1>
          <p className="text-sm text-muted-foreground">
            Redeeming your invite and linking your account&hellip;
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

function ErrorCard({ message }: { message: string }) {
  return (
    <div className="w-full max-w-sm motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        <div className="h-0.5 bg-destructive" />
        <div className="space-y-5 p-8">
          <div className="space-y-2">
            <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-destructive">
              Onboarding Blocked
            </p>
            <h1 className="text-base font-semibold text-card-foreground">
              Unable to Complete Setup
            </h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {message}
            </p>
          </div>
          <div className="flex flex-col gap-2.5 pt-1">
            <Button asChild size="lg" className="w-full">
              <Link href="/sign-in">Sign In</Link>
            </Button>
            <Button asChild variant="outline" className="w-full">
              <Link href="/">Return Home</Link>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connect Calendly
// ---------------------------------------------------------------------------

const PERMISSIONS = [
  {
    icon: Calendar,
    label: "Scheduled events & attendee information",
  },
  {
    icon: Settings2,
    label: "Event type configurations & availability rules",
  },
  {
    icon: Radio,
    label: "Real-time webhooks for live data synchronization",
  },
] as const;

function ConnectCard({
  companyName,
  alreadyRedeemed,
}: {
  companyName: string;
  alreadyRedeemed: boolean;
}) {
  const initial = companyName.charAt(0).toUpperCase() || "C";

  return (
    <div className="w-full max-w-md motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3 motion-safe:duration-600">
      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        {/* Accent top border */}
        <div className="h-0.5 bg-primary" />

        {/* Header */}
        <div className="border-b border-border px-8 pb-8 pt-10 text-center">
          <div
            className="mx-auto flex size-16 items-center justify-center rounded-full border-2 border-primary/25 bg-primary/10 text-2xl font-semibold text-primary"
            aria-hidden="true"
          >
            {initial}
          </div>
          <h1 className="mt-5 text-xl font-semibold tracking-tight text-card-foreground text-pretty">
            Welcome to {companyName}
          </h1>
          <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-muted-foreground text-pretty">
            Your account is ready. Connect Calendly to start ingesting meeting
            activity and team data.
          </p>
        </div>

        {/* Body */}
        <div className="space-y-6 px-8 py-8">
          {/* Already-redeemed notice */}
          {alreadyRedeemed ? (
            <div className="flex items-start gap-3 rounded-md border border-border bg-muted/30 p-3.5">
              <CheckCircle2
                className="mt-0.5 size-4 shrink-0 text-primary"
                aria-hidden="true"
              />
              <div className="min-w-0">
                <p className="text-sm font-medium text-card-foreground">
                  Already Linked
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  This organization was previously redeemed. Continue from here.
                </p>
              </div>
            </div>
          ) : null}

          {/* Permissions */}
          <div className="space-y-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
              Calendly Access Required
            </p>
            <ul className="space-y-2" role="list">
              {PERMISSIONS.map(({ icon: Icon, label }, idx) => (
                <li
                  key={label}
                  className="flex items-center gap-3 rounded-md border border-border bg-muted/20 px-4 py-3 text-sm text-card-foreground motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-400"
                  style={{ animationDelay: `${200 + idx * 80}ms` }}
                >
                  <Icon
                    className="size-4 shrink-0 text-primary"
                    aria-hidden="true"
                  />
                  <span className="min-w-0">{label}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* CTA */}
          <Button
            size="lg"
            className="w-full gap-2"
            onClick={() => {
              // Phase 4 will wire this to the Calendly OAuth authorize URL.
              console.info("Calendly OAuth flow will be wired in Phase 4.");
            }}
          >
            Connect Calendly
            <ArrowRight className="size-4" aria-hidden="true" />
          </Button>

          <p className="text-center text-xs text-muted-foreground">
            Calendly connection is required to activate the workspace.
          </p>
        </div>
      </div>
    </div>
  );
}
