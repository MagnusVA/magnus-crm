"use client";

import { type Preloaded, usePreloadedQuery, useQuery } from "convex/react";
import Link from "next/link";
import { ChevronRightIcon } from "lucide-react";
import { useRole } from "@/components/auth/role-context";
import { Button } from "@/components/ui/button";
import { CARD } from "@/app/workspace/team/_components/team-ui";
import { api } from "@/convex/_generated/api";
import { SectionErrorBoundary } from "@/app/workspace/_components/section-error-boundary";
import { CallInsightsIntegrationCard } from "@/components/call-insights/integration-card";
import { FathomIntegrationCard } from "@/components/fathom/fathom-integration-card";
import { WhopIntegrationCard } from "@/components/whop/whop-integration-card";
import { ActionRow } from "../settings-ui";
import { IntegrationCardSkeleton } from "../settings-skeleton";
import { AiAssistantsCard } from "./ai-assistants-card";
import { ApiKeysCard } from "./api-keys-card";
import { CalendlyConnection } from "./calendly-connection";
import { calendlyConnected, slackState, type CalendlyStatus } from "./integration-status";
import { SlackIntegrationCard } from "./slack-integration-card";

/**
 * Calendly and Slack side by side from `@4xl` (each at its own height), then
 * Fathom and AI assistants, Whop, Call insights and API keys full width under
 * them; one column narrower.
 */
export function IntegrationsTab({
  preloadedSlackStatus,
  calendlyStatus,
}: {
  preloadedSlackStatus: Preloaded<typeof api.slack.channels.getInstallationStatus>;
  /** `undefined` while loading; the page reads it once for the card and the band. */
  calendlyStatus: CalendlyStatus | null | undefined;
}) {
  const slackStatus = usePreloadedQuery(preloadedSlackStatus);
  const { hasPermission } = useRole();
  const calendlyFirst =
    calendlyStatus === null || (calendlyStatus !== undefined && !calendlyConnected(calendlyStatus));
  const quiet = calendlyFirst || !slackState(slackStatus).connected;
  return (
    <div className="grid gap-3.5 @4xl:grid-cols-2 @4xl:items-start">
      <SectionErrorBoundary sectionName="Calendly connection">
        {calendlyStatus === undefined ? (
          <IntegrationCardSkeleton label="Loading Calendly connection" />
        ) : (
          <CalendlyConnection connectionStatus={calendlyStatus} />
        )}
      </SectionErrorBoundary>
      <SectionErrorBoundary sectionName="Slack integration">
        {/* One lime action at a time: Calendly first, then Slack. */}
        <SlackIntegrationCard
          preloadedStatus={preloadedSlackStatus}
          calendlyFirst={calendlyFirst}
        />
      </SectionErrorBoundary>
      <SectionErrorBoundary sectionName="Fathom">
        {/* Fathom's Connect is lime only once Calendly and Slack are connected. */}
        <FathomIntegrationCard quiet={quiet} />
      </SectionErrorBoundary>
      <SectionErrorBoundary sectionName="AI assistants">
        <AiAssistantsCard />
      </SectionErrorBoundary>
      <div className="min-w-0 @4xl:col-span-2">
        <SectionErrorBoundary sectionName="Whop">
          <SectionErrorBoundary sectionName="Fathom connection status" fallback={<WhopIntegrationCard quiet />}>
            <WhopWithFathomStatus quiet={quiet} />
          </SectionErrorBoundary>
        </SectionErrorBoundary>
      </div>
      <div className="min-w-0 @4xl:col-span-2">
        <SectionErrorBoundary sectionName="Call insights">
          <CallInsightsIntegrationCard />
        </SectionErrorBoundary>
      </div>
      {hasPermission("result-automation:view") ? (
        <div className={`${CARD} min-w-0 @4xl:col-span-2`}>
          <ActionRow className="border-t-0">
            <Button asChild variant="outline" size="sm">
              <Link href="/workspace/settings/automatic-results">Automatic results
                <ChevronRightIcon data-icon="inline-end" aria-hidden="true" />
              </Link>
            </Button>
          </ActionRow>
        </div>
      ) : null}
      <div className="min-w-0 @4xl:col-span-2">
        <SectionErrorBoundary sectionName="API keys">
          <ApiKeysCard />
        </SectionErrorBoundary>
      </div>
    </div>
  );
}

/** Fathom determines which Connect button is highlighted. */
function WhopWithFathomStatus({ quiet }: { quiet: boolean }) {
  const fathom = useQuery(api.fathom.connection.settings, quiet ? "skip" : {});
  return <WhopIntegrationCard quiet={quiet || fathom?.connection?.status !== "connected"} />;
}
