"use client";

import type { Preloaded } from "convex/react";
import { usePreloadedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePageTitle } from "@/hooks/use-page-title";
import { CalendlyConnection } from "./calendly-connection";
import { EventTypeConfigList } from "./event-type-config-list";

interface SettingsPageClientProps {
  preloadedEventTypeConfigs: Preloaded<
    typeof api.eventTypeConfigs.queries.listEventTypeConfigs
  >;
  preloadedConnectionStatus: Preloaded<
    typeof api.calendly.oauthQueries.getConnectionStatus
  >;
}

export function SettingsPageClient({
  preloadedEventTypeConfigs,
  preloadedConnectionStatus,
}: SettingsPageClientProps) {
  usePageTitle("Settings");

  const eventTypeConfigs = usePreloadedQuery(preloadedEventTypeConfigs);
  const connectionStatus = usePreloadedQuery(preloadedConnectionStatus);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="mt-2 text-muted-foreground">
          Manage your workspace configuration
        </p>
      </div>

      <Tabs defaultValue="calendly" className="w-full">
        <TabsList>
          <TabsTrigger value="calendly">Calendly</TabsTrigger>
          <TabsTrigger value="event-types">Event Types</TabsTrigger>
          {/* Future tabs: */}
          {/* <TabsTrigger value="notifications">Notifications</TabsTrigger> */}
          {/* <TabsTrigger value="billing">Billing</TabsTrigger> */}
        </TabsList>

        <TabsContent value="calendly" className="mt-6">
          <CalendlyConnection connectionStatus={connectionStatus} />
        </TabsContent>

        <TabsContent value="event-types" className="mt-6">
          <EventTypeConfigList configs={eventTypeConfigs} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
