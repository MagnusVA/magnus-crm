"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { CalendlyConnection } from "./_components/calendly-connection";
import { EventTypeConfigList } from "./_components/event-type-config-list";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

function SettingsSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-96" />
      </div>

      {/* Calendly Connection Skeleton */}
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-32" />
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Event Type Configs Skeleton */}
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-32" />
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} className="h-32 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function SettingsPage() {
  const eventTypeConfigs = useQuery(
    api.eventTypeConfigs.queries.listEventTypeConfigs,
  );
  const connectionStatus = useQuery(
    api.calendly.oauthQueries.getConnectionStatus,
  );

  if (eventTypeConfigs === undefined || connectionStatus === undefined) {
    return <SettingsSkeleton />;
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="mt-2 text-muted-foreground">
          Manage your integrations and configurations
        </p>
      </div>

      {/* Calendly Connection Section */}
      <CalendlyConnection connectionStatus={connectionStatus} />

      {/* Event Type Configurations Section */}
      <div className="flex flex-col gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            Event Type Configurations
          </h2>
          <p className="text-sm text-muted-foreground">
            Customize how your Calendly event types appear in the CRM
          </p>
        </div>
        <EventTypeConfigList configs={eventTypeConfigs} />
      </div>
    </div>
  );
}
