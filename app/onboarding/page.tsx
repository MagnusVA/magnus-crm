"use client";

import { useAction } from "convex/react";
import {
  AlertCircleIcon,
  ArrowRightIcon,
  ClockIcon,
  KeyRoundIcon,
  Link2OffIcon,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";

import { OnboardingShell, PulsingDots } from "./_components/onboarding-shell";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ValidationState =
  | { status: "loading" }
  | { status: "redirecting"; companyName: string }
  | {
      status: "error";
      error: InviteError;
      workosOrgId?: string;
      companyName?: string;
    };

type InviteError =
  | "no_token"
  | "invalid_signature"
  | "not_found"
  | "already_redeemed"
  | "expired";

// ---------------------------------------------------------------------------
// Page (Suspense boundary for useSearchParams)
// ---------------------------------------------------------------------------

export default function OnboardingPage() {
  return (
    <Suspense
      fallback={
        <OnboardingShell>
          <LoadingCard label="Preparing onboarding" />
        </OnboardingShell>
      }
    >
      <OnboardingPageContent />
    </Suspense>
  );
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

function OnboardingPageContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const validateInvite = useAction(api.onboarding.invite.validateInvite);
  // Derive initial state from token presence — avoids synchronous setState in effect
  const [state, setState] = useState<ValidationState>(() =>
    token ? { status: "loading" } : { status: "error", error: "no_token" },
  );

  useEffect(() => {
    if (!token) return;

    let active = true;

    void validateInvite({ token })
      .then((result) => {
        if (!active) return;

        if (result.valid) {
          sessionStorage.setItem("onboarding_orgId", result.workosOrgId);
          sessionStorage.setItem("onboarding_companyName", result.companyName);
          sessionStorage.setItem("onboarding_tenantId", result.tenantId);

          setState({ status: "redirecting", companyName: result.companyName });

          const authState = JSON.stringify({
            onboardingOrgId: result.workosOrgId,
          });

          window.location.assign(
            `/sign-up?organization_id=${encodeURIComponent(result.workosOrgId)}&returnTo=${encodeURIComponent("/onboarding/connect")}&state=${encodeURIComponent(authState)}`,
          );
          return;
        }

        setState({
          status: "error",
          error: result.error,
          workosOrgId: result.workosOrgId,
          companyName: result.companyName,
        });
      })
      .catch(() => {
        if (!active) return;

        setState({ status: "error", error: "invalid_signature" });
      });

    return () => {
      active = false;
    };
  }, [token, validateInvite]);

  const isLoading = state.status === "loading" || state.status === "redirecting";

  return (
    <OnboardingShell>
      {isLoading ? (
        <LoadingCard
          label={
            state.status === "loading"
              ? "Validating your invite"
              : `Preparing ${state.companyName}`
          }
        />
      ) : (
        <ErrorCard
          error={state.error}
          workosOrgId={state.workosOrgId}
          companyName={state.companyName}
        />
      )}
    </OnboardingShell>
  );
}

// ---------------------------------------------------------------------------
// Loading Card
// ---------------------------------------------------------------------------

function LoadingCard({ label }: { label: string }) {
  return (
    <div
      className="w-full max-w-sm motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500"
      role="status"
    >
      <div className="flex flex-col gap-6 rounded-lg border border-border bg-card p-8 text-center shadow-sm">
        <PulsingDots />
        <div className="flex flex-col gap-2">
          <h1 className="text-lg font-semibold tracking-tight text-card-foreground">
            {label}
          </h1>
          <p className="text-sm text-muted-foreground">
            Checking the invite token and preparing account creation&hellip;
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error Card
// ---------------------------------------------------------------------------

function ErrorCard({
  error,
  workosOrgId,
  companyName,
}: {
  error: InviteError;
  workosOrgId?: string;
  companyName?: string;
}) {
  const { icon: Icon, title, detail, description } = ERROR_MAP[error];

  const signInHref =
    workosOrgId != null
      ? `/sign-in?organization_id=${encodeURIComponent(workosOrgId)}&returnTo=${encodeURIComponent("/onboarding/connect")}`
      : "/sign-in";

  return (
    <div className="w-full max-w-sm motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        {/* Accent top border */}
        <div className="h-0.5 bg-destructive" />

        <div className="flex flex-col gap-5 p-8">
          {/* Header */}
          <div className="flex items-start gap-4">
            <div
              className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-destructive/10"
              aria-hidden="true"
            >
              <Icon className="size-4 text-destructive" />
            </div>
            <div className="min-w-0">
              <h1 className="text-base font-semibold text-card-foreground">
                {title}
              </h1>
              <p className="mt-0.5 text-xs uppercase tracking-[0.15em] text-muted-foreground">
                {detail}
              </p>
            </div>
          </div>

          {/* Description */}
          <p className="text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>

          {/* Organization context */}
          {companyName ? (
            <div className="rounded-md border border-border bg-muted/30 px-4 py-3">
              <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                Organization
              </p>
              <p className="mt-1 text-sm font-medium text-card-foreground">
                {companyName}
              </p>
            </div>
          ) : null}

          {/* Actions */}
          <div className="flex flex-col gap-2.5 pt-1">
            {error === "already_redeemed" ? (
              <Button asChild size="lg" className="w-full">
                <Link href={signInHref}>
                  Sign In to Continue
                  <ArrowRightIcon data-icon="inline-end" aria-hidden="true" />
                </Link>
              </Button>
            ) : (
              <Button asChild size="lg" className="w-full">
                <Link href="/">Return Home</Link>
              </Button>
            )}
            <Button asChild variant="outline" className="w-full">
              <Link href="/sign-in">Sign In</Link>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error config map
// ---------------------------------------------------------------------------

const ERROR_MAP: Record<
  InviteError,
  { icon: LucideIcon; title: string; detail: string; description: string }
> = {
  no_token: {
    icon: Link2OffIcon,
    title: "No Invite Token",
    detail: "Missing parameter",
    description:
      "No invite token was found in the URL. Use the onboarding link sent by your administrator.",
  },
  invalid_signature: {
    icon: KeyRoundIcon,
    title: "Invalid Invite",
    detail: "Signature check failed",
    description:
      "The invite signature could not be verified. Contact your administrator for a new onboarding link.",
  },
  not_found: {
    icon: AlertCircleIcon,
    title: "Invite Not Recognized",
    detail: "No matching record",
    description:
      "This invite is not associated with any active tenant. Ask your administrator to generate a new invite.",
  },
  already_redeemed: {
    icon: KeyRoundIcon,
    title: "Invite Already Used",
    detail: "Previously redeemed",
    description:
      "Your account setup was already completed. Sign in to continue into onboarding.",
  },
  expired: {
    icon: ClockIcon,
    title: "Invite Expired",
    detail: "Link no longer active",
    description:
      "The invite window has closed. Ask your administrator to regenerate a fresh onboarding link.",
  },
};
