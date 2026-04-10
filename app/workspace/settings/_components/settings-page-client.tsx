"use client";

import { useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useRouter } from "next/navigation";
import { useRole } from "@/components/auth/role-context";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePageTitle } from "@/hooks/use-page-title";
import SettingsLoading from "../loading";
import { CalendlyConnection } from "./calendly-connection";
import { EventTypeConfigList } from "./event-type-config-list";
import { FieldMappingsTab } from "./field-mappings-tab";

export function SettingsPageClient() {
  usePageTitle("Settings");
  const router = useRouter();
  const { isAdmin } = useRole();

  const eventTypeConfigs = useQuery(
    api.eventTypeConfigs.queries.listEventTypeConfigs,
    isAdmin ? {} : "skip",
  );
  const connectionStatus = useQuery(
    api.calendly.oauthQueries.getConnectionStatus,
    isAdmin ? {} : "skip",
  );
  const configsWithStats = useQuery(
    api.eventTypeConfigs.queries.getEventTypeConfigsWithStats,
    isAdmin ? {} : "skip",
  );

  useEffect(() => {
    if (!isAdmin) {
      router.replace("/workspace/closer");
    }
  }, [isAdmin, router]);

  if (
    !isAdmin ||
    eventTypeConfigs === undefined ||
    connectionStatus === undefined ||
    configsWithStats === undefined
  ) {
    return <SettingsLoading />;
  }

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
          <TabsTrigger value="field-mappings">Field Mappings</TabsTrigger>
        </TabsList>

        <TabsContent value="calendly" className="mt-6">
          <CalendlyConnection connectionStatus={connectionStatus} />
        </TabsContent>

        <TabsContent value="event-types" className="mt-6">
          <EventTypeConfigList configs={eventTypeConfigs} />
        </TabsContent>

        <TabsContent value="field-mappings" className="mt-6">
          <FieldMappingsTab configs={configsWithStats} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
