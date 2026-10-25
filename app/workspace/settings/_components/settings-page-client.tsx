"use client";

import { Suspense, useEffect } from "react";
import { type Preloaded } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useRouter, useSearchParams } from "next/navigation";
import { useRole } from "@/components/auth/role-context";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePageTitle } from "@/hooks/use-page-title";
import SettingsLoading from "../loading";
import { EventTypesTab } from "./event-types-tab";
import { IntegrationsTab } from "./integrations/integrations-tab";
import { BusinessDayCard } from "./business-day-card";
import { ProgramsTab } from "./programs-tab";
import { ResparkSettingsCard } from "./respark-settings-card";

type SettingsPageClientProps = {
  preloadedSlackStatus: Preloaded<
    typeof api.slack.channels.getInstallationStatus
  >;
};

const TAB_VALUES = ["event-types", "programs", "integrations", "business-day", "respark"] as const;
type TabValue = (typeof TAB_VALUES)[number];

// Legacy deep links: Calendly merged into Integrations, Field Mappings into
// Event Types. Attribution/Schedules redirect server-side in page.tsx.
function tabFromParam(value: string | null): TabValue {
  if (value === "calendly") return "integrations";
  if (value === "field-mappings") return "event-types";
  return TAB_VALUES.includes(value as TabValue)
    ? (value as TabValue)
    : "event-types";
}

export function SettingsPageClient({
  preloadedSlackStatus,
}: SettingsPageClientProps) {
  return (
    <Suspense fallback={<SettingsLoading />}>
      <SettingsContent preloadedSlackStatus={preloadedSlackStatus} />
    </Suspense>
  );
}

function SettingsContent({ preloadedSlackStatus }: SettingsPageClientProps) {
  usePageTitle("Settings");
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isAdmin, hasPermission } = useRole();
  const canManageSettings = hasPermission("settings:manage");
  const requestedTab = tabFromParam(searchParams.get("tab"));
  const defaultTab = requestedTab === "respark" && !canManageSettings ? "event-types" : requestedTab;

  useEffect(() => {
    if (!isAdmin) {
      router.replace("/workspace/closer");
    }
  }, [isAdmin, router]);

  if (!isAdmin) {
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

      <Tabs defaultValue={defaultTab} className="w-full">
        <TabsList>
          <TabsTrigger value="event-types">Event Types</TabsTrigger>
          <TabsTrigger value="programs">Programs</TabsTrigger>
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
          <TabsTrigger value="business-day">Business day</TabsTrigger>
          {canManageSettings ? <TabsTrigger value="respark">Respark</TabsTrigger> : null}
        </TabsList>

        <TabsContent value="event-types" className="mt-6">
          <EventTypesTab />
        </TabsContent>

        <TabsContent value="programs" className="mt-6">
          <ProgramsTab />
        </TabsContent>

        <TabsContent value="integrations" className="mt-6">
          <IntegrationsTab preloadedSlackStatus={preloadedSlackStatus} />
        </TabsContent>
        <TabsContent value="business-day" className="mt-6"><BusinessDayCard /></TabsContent>
        {canManageSettings ? (
          <TabsContent value="respark" className="mt-6"><ResparkSettingsCard /></TabsContent>
        ) : null}
      </Tabs>
    </div>
  );
}
