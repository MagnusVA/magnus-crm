import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import {
  CardFooter,
  NoticeCard,
  StatusWord,
  type Tone,
} from "@/app/onboarding/_components/onboarding-ui";
import { PublicShell } from "@/components/public-shell";
import { Button } from "@/components/ui/button";
import {
  parseSignInFailureReason,
  type SignInFailureReason,
} from "@/lib/sign-in-failure";

export const metadata: Metadata = {
  title: "Sign-in problem",
  robots: { index: false },
};

const PROBLEMS: Record<
  SignInFailureReason,
  { title: string; word: string; tone: Tone; line: string }
> = {
  expired: {
    title: "This sign-in attempt is no longer valid",
    word: "Not valid",
    tone: "danger",
    line: "Sign-in has to finish within 10 minutes, in the same browser it started in. Start again to continue.",
  },
  used: {
    title: "This sign-in link no longer works",
    word: "Used or expired",
    tone: "muted",
    line: "A sign-in link works once and for a short time, so refreshing or reopening it can’t sign you in. Start again to continue.",
  },
  incomplete: {
    title: "Sign-in didn’t finish",
    word: "Incomplete",
    tone: "danger",
    line: "The sign-in page sent you back before it finished. Start again to continue.",
  },
  failed: {
    title: "We couldn’t sign you in",
    word: "Error",
    tone: "danger",
    line: "Something went wrong on our side, and it has been reported. Start again to continue.",
  },
};

/**
 * Where the sign-in callback sends a failure (`app/callback/route.ts`). The
 * callback URL can't be retried: its code and verifier cookie work once. So
 * this page says what happened and offers a fresh flow. It never redirects on
 * its own, which keeps a broken setup from looping. The copy comes from the
 * allowlisted `reason` alone; nothing from the URL is rendered.
 */
export default function SignInErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string | string[] }>;
}) {
  return (
    <PublicShell signIn={false}>
      <Suspense fallback={null}>
        <SignInProblemFromUrl searchParams={searchParams} />
      </Suspense>
    </PublicShell>
  );
}

async function SignInProblemFromUrl({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string | string[] }>;
}) {
  const { reason } = await searchParams;
  return <SignInProblem reason={parseSignInFailureReason(reason)} />;
}

function SignInProblem({ reason }: { reason: SignInFailureReason }) {
  const problem = PROBLEMS[reason];
  return (
    <NoticeCard
      title={problem.title}
      status={<StatusWord tone={problem.tone}>{problem.word}</StatusWord>}
      line={problem.line}
    >
      <CardFooter
        aside={
          <>
            Still stuck?{" "}
            <Link
              href="/support"
              className="rounded-sm underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              Contact support
            </Link>
          </>
        }
      >
        {/* A plain link: /sign-in is a route handler that leaves the site. */}
        <Button asChild className="font-semibold">
          <a href="/sign-in">Sign in again</a>
        </Button>
      </CardFooter>
    </NoticeCard>
  );
}
