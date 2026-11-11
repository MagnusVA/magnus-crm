import type { Metadata } from "next";

import { NoticeCard, StatusWord } from "@/app/onboarding/_components/onboarding-ui";
import { PublicShell } from "@/components/public-shell";
import { UnavailableRetry } from "./_components/unavailable-retry";

export const metadata: Metadata = {
  title: "Temporarily unavailable",
  robots: { index: false },
};

/**
 * Where the workspace gate (`getWorkspaceAccess` in `lib/auth.ts`) sends a
 * page load when Convex can't answer it, as when Convex disables the
 * deployment at the spending limit. It replaces the error screen with a page
 * that goes back to the workspace on its own. It makes no Convex call, so it
 * renders while Convex is down.
 */
export default function UnavailablePage() {
  return (
    <PublicShell signIn={false}>
      <NoticeCard
        title="Magnus is temporarily unavailable"
        status={<StatusWord tone="warning">Unavailable</StatusWord>}
        line="We can’t load your workspace right now. Nothing you saved is lost."
      >
        <UnavailableRetry />
      </NoticeCard>
    </PublicShell>
  );
}
