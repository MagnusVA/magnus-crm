"use client";

import Link from "next/link";
import { useConvexAuth, useQuery } from "convex/react";
import { ChevronRightIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { useRole } from "@/components/auth/role-context";
import { Button } from "@/components/ui/button";
import { CARD, CardHead } from "@/app/workspace/team/_components/team-ui";
import { IntegrationCardSkeleton } from "@/app/workspace/settings/_components/settings-skeleton";
import {
  NoteLine,
  StatusWord,
} from "@/app/workspace/settings/_components/settings-ui";

const CALL_INSIGHTS_HREF = "/workspace/pipeline/call-insights";

/**
 * Call insights on the Integrations tab: one status word and the way to its
 * own page, where it is switched on and set up. Owners and admins only.
 */
export function CallInsightsIntegrationCard() {
  const { role } = useRole();
  return role === "tenant_admin" || role === "tenant_master" ? (
    <CallInsightsSummary />
  ) : null;
}

function CallInsightsSummary() {
  const { isAuthenticated } = useConvexAuth();
  const view = useQuery(
    api.callInsights.queries.settings,
    isAuthenticated ? {} : "skip",
  );

  if (view === undefined)
    return (
      <IntegrationCardSkeleton label="Loading Call insights" groups={[1]} />
    );
  if (view === null) return null;

  const on = view.enabled && view.settings !== null;
  const status = !on
    ? "Off"
    : view.settings?.mode === "on"
      ? "On for closers too"
      : "On for owners and admins";

  return (
    <section aria-label="Call insights" className={CARD}>
      <CardHead title="Call insights">
        <StatusWord tone={on ? "ok" : "muted"}>{status}</StatusWord>
      </CardHead>
      <div className="border-b border-border px-4 py-2.5">
        <NoteLine>
          Reads each matched Fathom recording for what the prospect said and
          suggests the call&apos;s result.
        </NoteLine>
      </div>
      <div className="flex min-h-10 flex-wrap items-center gap-1.5 px-4 py-1.5">
        <Button asChild variant="outline" size="sm">
          <Link
            href={
              on ? CALL_INSIGHTS_HREF : `${CALL_INSIGHTS_HREF}?tab=settings`
            }
          >
            Open Call insights
            <ChevronRightIcon data-icon="inline-end" aria-hidden="true" />
          </Link>
        </Button>
      </div>
    </section>
  );
}
