"use client";

import { useAction } from "convex/react";
import { usePageTitle } from "@/hooks/use-page-title";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, useSyncExternalStore } from "react";

import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { reportClientError } from "@/lib/observability/report-client-error";

import { OnboardingShell } from "./_components/onboarding-shell";
import {
  CardFooter,
  FactRow,
  NoticeCard,
  StatusWord,
  WaitCard,
  type Tone,
} from "./_components/onboarding-ui";

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

/**
 * The invite token is moved from the URL into sessionStorage on arrival, so
 * it doesn't linger in the address bar, history, or analytics URLs. A
 * reload in the same tab still finds it.
 */
const INVITE_TOKEN_STORAGE_KEY = "onboarding_inviteToken";

function subscribeToNothing() {
  return () => {};
}

function readStoredInviteToken() {
  return sessionStorage.getItem(INVITE_TOKEN_STORAGE_KEY);
}

/** Unknown during server render and hydration. */
function readStoredInviteTokenOnServer() {
  return undefined;
}

// ---------------------------------------------------------------------------
// Page (Suspense boundary for useSearchParams)
// ---------------------------------------------------------------------------

export default function OnboardingPage() {
  usePageTitle("Onboarding");
  return (
    <Suspense
      fallback={
        <OnboardingShell>
          <WaitCard>Checking your invite&hellip;</WaitCard>
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
  const pathname = usePathname();
  const router = useRouter();
  const urlToken = searchParams.get("token");
  const storedToken = useSyncExternalStore(
    subscribeToNothing,
    readStoredInviteToken,
    readStoredInviteTokenOnServer,
  );
  // `undefined` until the client can read sessionStorage.
  const token = urlToken ?? storedToken;
  const validateInvite = useAction(api.onboarding.invite.validateInvite);
  const [validation, setValidation] = useState<ValidationState>({
    status: "loading",
  });
  const state: ValidationState =
    token === null ? { status: "error", error: "no_token" } : validation;

  // Move the token out of the URL, keeping any other params.
  useEffect(() => {
    if (!urlToken) return;
    sessionStorage.setItem(INVITE_TOKEN_STORAGE_KEY, urlToken);
    const remaining = new URLSearchParams(searchParams.toString());
    remaining.delete("token");
    const query = remaining.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [urlToken, searchParams, pathname, router]);

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

          setValidation({ status: "redirecting", companyName: result.companyName });

          const authState = JSON.stringify({
            onboardingOrgId: result.workosOrgId,
          });

          // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- /sign-up is a route handler and needs a full page load
          window.location.assign(
            `/sign-up?organization_id=${encodeURIComponent(result.workosOrgId)}&returnTo=${encodeURIComponent("/onboarding/connect")}&state=${encodeURIComponent(authState)}`,
          );
          return;
        }

        setValidation({
          status: "error",
          error: result.error,
          workosOrgId: result.workosOrgId,
          companyName: result.companyName,
        });
      })
      .catch((error: unknown) => {
        reportClientError(error, { flow: "onboarding_invite_validate" });
        if (!active) return;

        setValidation({ status: "error", error: "invalid_signature" });
      });

    return () => {
      active = false;
    };
  }, [token, validateInvite]);

  return (
    <OnboardingShell>
      {state.status === "loading" ? (
        <WaitCard>Checking your invite&hellip;</WaitCard>
      ) : state.status === "redirecting" ? (
        <WaitCard>Opening sign-up for {state.companyName}&hellip;</WaitCard>
      ) : (
        <InviteProblem
          error={state.error}
          workosOrgId={state.workosOrgId}
          companyName={state.companyName}
        />
      )}
    </OnboardingShell>
  );
}

// ---------------------------------------------------------------------------
// The invite can't be used
// ---------------------------------------------------------------------------

const ASK_FOR_NEW_LINK = "Ask the person who invited you for a new link.";

const PROBLEMS: Record<
  InviteError,
  { title: string; word: string; tone: Tone; line: string }
> = {
  no_token: { title: "This link has no invite", word: "No invite", tone: "danger", line: ASK_FOR_NEW_LINK },
  invalid_signature: {
    title: "This invite can’t be checked",
    word: "Invalid",
    tone: "danger",
    line: ASK_FOR_NEW_LINK,
  },
  not_found: { title: "This invite isn’t recognized", word: "Not found", tone: "danger", line: ASK_FOR_NEW_LINK },
  already_redeemed: {
    title: "This invite was already used",
    word: "Already used",
    tone: "muted",
    line: "Your account is set up. Sign in to carry on.",
  },
  expired: { title: "This invite has expired", word: "Expired", tone: "danger", line: ASK_FOR_NEW_LINK },
};

function InviteProblem({
  error,
  workosOrgId,
  companyName,
}: {
  error: InviteError;
  workosOrgId?: string;
  companyName?: string;
}) {
  const problem = PROBLEMS[error];

  const signInHref =
    workosOrgId != null
      ? `/sign-in?organization_id=${encodeURIComponent(workosOrgId)}&returnTo=${encodeURIComponent("/onboarding/connect")}`
      : "/sign-in";

  return (
    <NoticeCard
      title={problem.title}
      status={<StatusWord tone={problem.tone}>{problem.word}</StatusWord>}
      line={problem.line}
    >
      {companyName ? <FactRow label="Company">{companyName}</FactRow> : null}
      <CardFooter>
        {error === "already_redeemed" ? (
          <Button asChild className="font-semibold">
            <a href={signInHref}>Sign in to continue</a>
          </Button>
        ) : (
          <>
            <Button asChild variant="ghost">
              <Link href="/">Home</Link>
            </Button>
            <Button asChild variant="outline">
              <a href="/sign-in">Sign in</a>
            </Button>
          </>
        )}
      </CardFooter>
    </NoticeCard>
  );
}
