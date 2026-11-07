"use client";

import type { Preloaded } from "convex/react";
import { api } from "@/convex/_generated/api";
import { SectionErrorBoundary } from "@/app/workspace/_components/section-error-boundary";
import { FathomIntegrationCard } from "@/components/fathom/fathom-integration-card";
import { IntegrationCardSkeleton } from "../settings-skeleton";
import { AiAssistantsCard } from "./ai-assistants-card";
import { ApiKeysCard } from "./api-keys-card";
import { CalendlyConnection } from "./calendly-connection";
import { calendlyConnected, type CalendlyStatus } from "./integration-status";
import { SlackIntegrationCard } from "./slack-integration-card";

/**
 * Calendly and Slack side by side from `@4xl` (each at its own height), then
 * Fathom and AI assistants, API keys full width under them; one column
 * narrower.
 */
export function IntegrationsTab({
  preloadedSlackStatus,
  calendlyStatus,
}: {
  preloadedSlackStatus: Preloaded<typeof api.slack.channels.getInstallationStatus>;
  /** `undefined` while loading; the page reads it once for the card and the band. */
  calendlyStatus: CalendlyStatus | null | undefined;
}) {
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
          calendlyFirst={calendlyStatus === null || (calendlyStatus !== undefined && !calendlyConnected(calendlyStatus))}
        />
      </SectionErrorBoundary>
      <SectionErrorBoundary sectionName="Fathom">
        <FathomIntegrationCard />
      </SectionErrorBoundary>
      <SectionErrorBoundary sectionName="AI assistants">
        <AiAssistantsCard />
      </SectionErrorBoundary>
      <div className="min-w-0 @4xl:col-span-2">
        <SectionErrorBoundary sectionName="API keys">
          <ApiKeysCard />
        </SectionErrorBoundary>
      </div>
    </div>
  );
}
