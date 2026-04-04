"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { redirect } from "next/navigation";
import { usePageTitle } from "@/hooks/use-page-title";
import { CalendlyConnection } from "./_components/calendly-connection";
import { EventTypeConfigList } from "./_components/event-type-config-list";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

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
  usePageTitle("Settings");
  const currentUser = useQuery(api.users.queries.getCurrentUser);
  const isAdmin =
    currentUser?.role === "tenant_master" || currentUser?.role === "tenant_admin";
  const eventTypeConfigs = useQuery(
    api.eventTypeConfigs.queries.listEventTypeConfigs,
    isAdmin ? {} : "skip",
  );
  const connectionStatus = useQuery(
    api.calendly.oauthQueries.getConnectionStatus,
    isAdmin ? {} : "skip",
  );

  if (currentUser === undefined) {
    return <SettingsSkeleton />;
  }

  if (currentUser === null) {
    return null;
  }

  if (currentUser.role === "closer") {
    redirect("/workspace/closer");
  }

  if (eventTypeConfigs === undefined || connectionStatus === undefined) {
    return <SettingsSkeleton />;
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
