"use client";

import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import {
  ArrowRightIcon,
  CalendarIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  ExternalLinkIcon,
  RadioIcon,
  Settings2Icon,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";

import { OnboardingShell, PulsingDots } from "../_components/onboarding-shell";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RedeemState =
  | { status: "loading" }
  | {
      status: "ready";
      companyName: string;
      alreadyRedeemed: boolean;
      tenantId: string;
    }
  | { status: "error"; message: string };

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ConnectCalendlyPage() {
  return (
    <Suspense
      fallback={
        <OnboardingShell>
          <LoadingCard />
        </OnboardingShell>
      }
    >
      <ConnectCalendlyPageContent />
    </Suspense>
  );
}

function ConnectCalendlyPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isAuthenticated, isLoading: convexLoading } = useConvexAuth();
  const { user, organizationId } = useAuth();
  const tenant = useQuery(api.tenants.getCurrentTenant, isAuthenticated ? {} : "skip");
  const redeemInvite = useMutation(
    api.onboarding.complete.redeemInviteAndCreateUser,
  );
  const [state, setState] = useState<RedeemState>({ status: "loading" });
  const orgId = organizationId ?? undefined;

  const immediateErrorMessage = convexLoading
    ? null
    : !isAuthenticated || !user
      ? "You need to sign in before completing onboarding."
      : !orgId
        ? "No onboarding organization was found in your session. Restart onboarding from your invite link."
        : null;

  useEffect(() => {
    if (tenant?.status === "active") {
      router.replace("/workspace");
    }
  }, [router, tenant?.status]);

  useEffect(() => {
    let active = true;

    if (convexLoading || immediateErrorMessage || !orgId) {
      return;
    }

    void redeemInvite({ workosOrgId: orgId })
      .then((result) => {
        if (!active) return;

        sessionStorage.removeItem("onboarding_orgId");
        sessionStorage.removeItem("onboarding_companyName");

        setState({
          status: "ready",
          companyName: result.companyName,
          alreadyRedeemed: result.alreadyRedeemed,
          tenantId: result.tenantId,
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
  }, [convexLoading, immediateErrorMessage, orgId, redeemInvite]);

  if (immediateErrorMessage) {
    return (
      <OnboardingShell>
        <ErrorCard message={immediateErrorMessage} />
      </OnboardingShell>
    );
  }

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
          tenantId={state.tenantId}
          calendlyStatus={searchParams.get("calendly")}
          calendlyError={searchParams.get("error")}
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
      <div className="flex flex-col gap-6 rounded-lg border border-border bg-card p-8 text-center shadow-sm">
        <PulsingDots />
        <div className="flex flex-col gap-2">
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
        <div className="flex flex-col gap-5 p-8">
          <div className="flex flex-col gap-2">
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
    icon: CalendarIcon,
    label: "Scheduled events & attendee information",
  },
  {
    icon: Settings2Icon,
    label: "Event type configurations & availability rules",
  },
  {
    icon: RadioIcon,
    label: "Real-time webhooks for live data synchronization",
  },
] as const;

function ConnectCard({
  companyName,
  alreadyRedeemed,
  tenantId,
  calendlyStatus,
  calendlyError,
}: {
  companyName: string;
  alreadyRedeemed: boolean;
  tenantId: string;
  calendlyStatus: string | null;
  calendlyError: string | null;
}) {
  const initial = companyName.charAt(0).toUpperCase() || "C";
  const calendlyConnected = calendlyStatus === "connected";
  const errorCode = calendlyError ?? "";
  const errorMessage = CALENDLY_ERROR_MESSAGES[errorCode] ?? null;
  const connectHref = `/api/calendly/start?tenantId=${encodeURIComponent(tenantId)}`;
  const needsUpgrade = UPGRADE_REQUIRED_ERRORS.has(errorCode);
  const isRetryable = RETRYABLE_ERRORS.has(errorCode);

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
        <div className="flex flex-col gap-6 px-8 py-8">
          {calendlyConnected ? (
            <div className="flex items-start gap-3 rounded-md border border-primary/20 bg-primary/10 p-3.5">
              <CheckCircle2Icon
                className="mt-0.5 size-4 shrink-0 text-primary"
                aria-hidden="true"
              />
              <div className="min-w-0">
                <p className="text-sm font-medium text-card-foreground">
                  Calendly Connected
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Workspace activation is complete. Continue into the app.
                </p>
              </div>
            </div>
          ) : null}

          {errorMessage ? (
            <div
              className="flex flex-col gap-3 rounded-md border border-destructive/20 bg-destructive/5 p-3.5"
              role="alert"
            >
              <div className="flex items-start gap-3">
                <CircleAlertIcon
                  className="mt-0.5 size-4 shrink-0 text-destructive"
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-card-foreground">
                    {needsUpgrade
                      ? "Calendly Plan Upgrade Required"
                      : "Calendly Connection Failed"}
                  </p>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {errorMessage}
                  </p>
                </div>
              </div>

              {/* Actionable CTAs based on error type */}
              {needsUpgrade ? (
                <div className="flex items-center gap-2 pl-7">
                  <Button asChild size="sm" variant="outline" className="text-xs">
                    <a
                      href="https://calendly.com/pricing"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      View Calendly Plans
                      <ExternalLinkIcon
                        className="ml-1.5 size-3"
                        aria-hidden="true"
                      />
                    </a>
                  </Button>
                </div>
              ) : isRetryable ? (
                <div className="flex items-center gap-2 pl-7">
                  <Button asChild size="sm" variant="outline" className="text-xs">
                    <Link href={connectHref}>Retry Connection</Link>
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Already-redeemed notice */}
          {alreadyRedeemed ? (
            <div className="flex items-start gap-3 rounded-md border border-border bg-muted/30 p-3.5">
              <CheckCircle2Icon
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
          <div className="flex flex-col gap-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
              Calendly Access Required
            </p>
            <ul className="flex flex-col gap-2" role="list">
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
          {calendlyConnected ? (
            <Button asChild size="lg" className="w-full">
              <Link href="/">
                Enter Workspace
                <ArrowRightIcon data-icon="inline-end" aria-hidden="true" />
              </Link>
            </Button>
          ) : (
            <Button asChild size="lg" className="w-full">
              <Link href={connectHref}>
                Connect Calendly
                <ArrowRightIcon data-icon="inline-end" aria-hidden="true" />
              </Link>
            </Button>
          )}

          <p className="text-center text-xs text-muted-foreground">
            Calendly connection is required to activate the workspace.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Error codes are propagated from the Calendly callback route
 * (`app/callback/calendly/route.ts`). Codes that surface specific next-steps
 * (upgrade or retry) are classified below the map.
 */
const CALENDLY_ERROR_MESSAGES: Record<string, string> = {
  calendly_denied:
    "Calendly authorization was cancelled before access was granted.",
  calendly_free_plan_unsupported:
    "This Calendly account is on a free plan. Organization-scoped webhooks require a Professional plan or higher.",
  exchange_failed:
    "The Calendly authorization code could not be exchanged or webhook setup failed.",
  missing_context:
    "The onboarding session expired before Calendly finished connecting. Start the connection again.",
  not_authenticated:
    "Your session expired before Calendly finished connecting. Sign in again and retry.",
  oauth_start_failed:
    "The Calendly authorization flow could not be started for this tenant.",
  webhook_creation_failed:
    "We connected to Calendly but couldn\u2019t set up the real-time webhook. This is usually a transient issue\u2009\u2014\u2009try connecting again.",
};

/** Errors that need a Calendly plan upgrade — retry won't help. */
const UPGRADE_REQUIRED_ERRORS = new Set(["calendly_free_plan_unsupported"]);

/** Transient failures where retrying is likely to succeed. */
const RETRYABLE_ERRORS = new Set([
  "exchange_failed",
  "missing_context",
  "webhook_creation_failed",
]);
