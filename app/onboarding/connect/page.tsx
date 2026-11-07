"use client";

import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { usePageTitle } from "@/hooks/use-page-title";
import { useAuthPostHogIdentify } from "@/hooks/use-posthog-identify";
import { useSignOut } from "@/hooks/use-sign-out";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { CheckIcon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { PageBand } from "@/app/workspace/_components/page-band";
import { CARD, LABEL } from "@/app/workspace/team/_components/team-ui";
import { SYSTEM_ADMIN_ORG_ID } from "@/lib/system-admin-org";
import { cn } from "@/lib/utils";

import { OnboardingShell } from "../_components/onboarding-shell";
import {
  CardFooter,
  NoticeCard,
  StatusWord,
  WaitCard,
  type Tone,
} from "../_components/onboarding-ui";
import { getErrorMessage } from "@/lib/errors";

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
  usePageTitle("Connect Calendly");
  return (
    <Suspense
      fallback={
        <OnboardingShell signOut>
          <WaitCard>Setting up your account&hellip;</WaitCard>
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
  const { user, organizationId, loading: authLoading } = useAuth();
  useAuthPostHogIdentify();
  const orgId = organizationId ?? undefined;
  const isSystemAdmin = orgId === SYSTEM_ADMIN_ORG_ID;
  const tenant = useQuery(
    api.tenants.getCurrentTenant,
    isAuthenticated && !authLoading && !isSystemAdmin ? {} : "skip",
  );
  const redeemInvite = useMutation(
    api.onboarding.complete.redeemInviteAndCreateUser,
  );
  const [state, setState] = useState<RedeemState>({ status: "loading" });

  const immediateErrorMessage = convexLoading || authLoading
    ? null
    : !isAuthenticated || !user
      ? "Sign in to finish setting up your account."
      : !orgId
        ? "Your session isn’t linked to a company. Open your invite link again."
        : null;

  useEffect(() => {
    if (authLoading || convexLoading || !isAuthenticated || !user) {
      return;
    }

    if (isSystemAdmin) {
      router.replace("/admin");
      return;
    }

    if (tenant?.status === "active") {
      router.replace("/workspace");
    }
  }, [
    authLoading,
    convexLoading,
    isAuthenticated,
    isSystemAdmin,
    router,
    tenant?.status,
    user,
  ]);

  useEffect(() => {
    let active = true;

    if (authLoading || convexLoading || isSystemAdmin || immediateErrorMessage || !orgId) {
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
            getErrorMessage(error, "Your account couldn’t be set up for this company."),
        });
      });

    return () => {
      active = false;
    };
  }, [
    authLoading,
    convexLoading,
    immediateErrorMessage,
    isSystemAdmin,
    orgId,
    redeemInvite,
  ]);

  // A blocked setup offers Sign out in its own footer, so the bar doesn't repeat it.
  if (immediateErrorMessage) {
    return (
      <OnboardingShell>
        <SetupBlocked message={immediateErrorMessage} />
      </OnboardingShell>
    );
  }

  if (state.status === "error") {
    return (
      <OnboardingShell>
        <SetupBlocked message={state.message} />
      </OnboardingShell>
    );
  }

  return (
    <OnboardingShell signOut>
      {state.status === "loading" ? (
        <WaitCard>Setting up your account&hellip;</WaitCard>
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
// Blocked
// ---------------------------------------------------------------------------

function SetupBlocked({ message }: { message: string }) {
  const { user } = useAuth();
  const signOut = useSignOut();

  return (
    <NoticeCard title="Setup can’t continue" line={message}>
      <CardFooter>
        <Button asChild variant="ghost">
          <Link href="/">Home</Link>
        </Button>
        {user ? (
          <Button type="button" variant="outline" onClick={() => void signOut()}>
            Sign out
          </Button>
        ) : (
          <Button asChild className="font-semibold">
            <Link href="/sign-in">Sign in</Link>
          </Button>
        )}
      </CardFooter>
    </NoticeCard>
  );
}

// ---------------------------------------------------------------------------
// Connect Calendly
// ---------------------------------------------------------------------------

const CALENDLY_READS = [
  "Scheduled events and who booked them",
  "Event types and availability",
  "Live updates through webhooks",
] as const;

type Step = {
  name: string;
  detail: string;
  done: boolean;
  word?: { text: string; tone: Tone };
};

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
  const calendlyConnected = calendlyStatus === "connected";
  const errorCode = calendlyError ?? "";
  const errorMessage = calendlyConnected ? null : (CALENDLY_ERROR_MESSAGES[errorCode] ?? null);
  const connectHref = `/api/calendly/start?tenantId=${encodeURIComponent(tenantId)}`;
  const needsUpgrade = errorMessage !== null && UPGRADE_REQUIRED_ERRORS.has(errorCode);
  const isRetryable = errorMessage !== null && RETRYABLE_ERRORS.has(errorCode);

  const steps: Step[] = [
    {
      name: "Account",
      detail: alreadyRedeemed ? "Set up earlier" : "Created",
      done: true,
      word: { text: "Done", tone: "muted" },
    },
    {
      name: "Calendly",
      detail: calendlyConnected ? "Bookings now come in live" : "Connect the company’s Calendly account",
      done: calendlyConnected,
      word: calendlyConnected
        ? { text: "Connected", tone: "ink" }
        : needsUpgrade
          ? { text: "Plan needed", tone: "warning" }
          : errorMessage
            ? { text: "Failed", tone: "danger" }
            : { text: "Next", tone: "ink" },
    },
    {
      name: "Workspace",
      detail: calendlyConnected ? "Ready to open" : "Opens once Calendly is connected",
      done: false,
      word: calendlyConnected ? { text: "Ready", tone: "ink" } : undefined,
    },
  ];

  return (
    <>
      <PageBand
        title={`Welcome, ${companyName}`}
        description={
          calendlyConnected
            ? "Calendly is connected. Open the workspace to start."
            : "Connect Calendly to bring in your calls and your team."
        }
      />

      <section aria-label="Setup" className={CARD}>
        <ol aria-label="Setup steps" className="divide-y divide-border">
          {steps.map((step, index) => (
            <StepRow key={step.name} number={index + 1} step={step} />
          ))}
        </ol>

        {errorMessage ? (
          <p
            role="alert"
            className={cn(
              "border-t border-border px-4 py-2.5 text-[13px] leading-[1.45] text-pretty",
              needsUpgrade ? "text-warning-ink" : "text-danger-ink",
            )}
          >
            {errorMessage}
          </p>
        ) : null}

        <section aria-labelledby="calendly-reads" className="border-t border-border pt-2.5 pb-2">
          <h2 id="calendly-reads" className={cn(LABEL, "px-4 pb-1")}>
            What Magnus reads from Calendly
          </h2>
          <ul>
            {CALENDLY_READS.map((read) => (
              <li key={read} className="flex min-h-8 items-center px-4 text-sm">
                {read}
              </li>
            ))}
          </ul>
        </section>

        <CardFooter aside={calendlyConnected ? null : "Needed to start the workspace."}>
          {needsUpgrade ? (
            <Button asChild variant="outline">
              <a href="https://calendly.com/pricing" target="_blank" rel="noopener noreferrer">
                See Calendly plans <span aria-hidden="true">↗</span>
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </Button>
          ) : null}
          {calendlyConnected ? (
            <Button asChild className="font-semibold">
              <Link href="/">Open workspace</Link>
            </Button>
          ) : (
            <Button asChild className="font-semibold">
              <Link href={connectHref}>{isRetryable ? "Try again" : "Connect Calendly"}</Link>
            </Button>
          )}
        </CardFooter>
      </section>
    </>
  );
}

/**
 * One setup step on a 44px row: the number (a check once done) in slate, the
 * step, its detail in 13px slate and one status word. Below `@md` of the
 * column the detail folds under the step.
 */
function StepRow({ number, step }: { number: number; step: Step }) {
  return (
    <li className="grid min-h-11 grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2 @md:grid-cols-[1.25rem_5.5rem_minmax(0,1fr)_auto]">
      <span aria-hidden="true" className="col-start-1 row-start-1 flex justify-center text-muted-foreground">
        {step.done ? (
          <CheckIcon className="size-4" strokeWidth={2.5} />
        ) : (
          <span className="font-condensed text-[15px] leading-none font-semibold tabular-nums">{number}</span>
        )}
      </span>
      <span className="col-start-2 row-start-1 text-sm font-medium">{step.name}</span>
      <span className="col-start-2 col-end-4 row-start-2 text-[13px] text-muted-foreground @md:col-start-3 @md:col-end-4 @md:row-start-1">
        {step.detail}
      </span>
      {step.word ? (
        <StatusWord tone={step.word.tone} className="col-start-3 row-start-1 justify-self-end @md:col-start-4">
          {step.word.text}
        </StatusWord>
      ) : null}
    </li>
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
  stale_session:
    "Your Calendly connection session expired or was started in another tab. Please try again.",
  webhook_creation_failed:
    "We connected to Calendly but couldn\u2019t set up the real-time webhook. This is usually a transient issue\u2009\u2014\u2009try connecting again.",
};

/** Errors that need a Calendly plan upgrade — retry won't help. */
const UPGRADE_REQUIRED_ERRORS = new Set(["calendly_free_plan_unsupported"]);

/** Transient failures where retrying is likely to succeed. */
const RETRYABLE_ERRORS = new Set([
  "exchange_failed",
  "missing_context",
  "stale_session",
  "webhook_creation_failed",
]);
