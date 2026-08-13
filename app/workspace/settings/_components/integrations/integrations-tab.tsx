"use client";

import type { Preloaded } from "convex/react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CalendlyConnection } from "./calendly-connection";
import { SlackIntegrationCard } from "./slack-integration-card";

function IntegrationCardSkeleton({ label }: { label: string }) {
  return (
    <Card role="status" aria-label={label}>
      <CardHeader className="gap-2">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-64 max-w-full" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-24 w-full" />
      </CardContent>
    </Card>
  );
}

export function IntegrationsTab({
  preloadedSlackStatus,
}: {
  preloadedSlackStatus: Preloaded<
    typeof api.slack.channels.getInstallationStatus
  >;
}) {
  const connectionStatus = useQuery(
    api.calendly.oauthQueries.getConnectionStatus,
    {},
  );

  return (
    <div className="flex flex-col gap-4">
      {connectionStatus === undefined ? (
        <IntegrationCardSkeleton label="Loading Calendly connection" />
      ) : (
        <CalendlyConnection connectionStatus={connectionStatus} />
      )}
      <SlackIntegrationCard preloadedStatus={preloadedSlackStatus} />
    </div>
  );
}
