"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { type Preloaded } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useRouter, useSearchParams } from "next/navigation";
import { useRole } from "@/components/auth/role-context";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePageTitle } from "@/hooks/use-page-title";
import SettingsLoading from "../loading";
import { IntegrationsTab } from "./integrations/integrations-tab";
import { BusinessDayCard } from "./business-day-card";
import { ResparkSettingsCard } from "./respark-settings-card";
import { LeadGenRulesCard } from "./lead-gen-rules-card";
import { SectionErrorBoundary } from "@/app/workspace/_components/section-error-boundary";

type SettingsPageClientProps = {
  preloadedSlackStatus: Preloaded<
    typeof api.slack.channels.getInstallationStatus
  >;
};

const TAB_VALUES = ["integrations", "business-day", "lead-gen", "respark"] as const;
type TabValue = (typeof TAB_VALUES)[number];

// Legacy deep link: Calendly merged into Integrations. Event types, programs,
// attribution and schedules redirect server-side in page.tsx.
function tabFromParam(value: string | null): TabValue {
  if (value === "calendly") return "integrations";
  return TAB_VALUES.includes(value as TabValue)
    ? (value as TabValue)
    : "integrations";
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
  const defaultTab = requestedTab === "respark" && !canManageSettings ? "integrations" : requestedTab;
  const [tab, setTab] = useState<string>(defaultTab);

  useEffect(() => {
    if (!isAdmin) {
      router.replace("/workspace/closer");
    }
  }, [isAdmin, router]);

  // /workspace/settings#lead-gen-rules (where the old Lead Gen settings' Rules
  // tab redirects) opens the Lead gen tab and scrolls to the rules.
  useEffect(() => {
    const openFromHash = () => {
      if (window.location.hash !== "#lead-gen-rules") return;
      setTab("lead-gen");
      requestAnimationFrame(() => document.getElementById("lead-gen-rules")?.scrollIntoView({ block: "start" }));
    };
    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    return () => window.removeEventListener("hashchange", openFromHash);
  }, []);

  if (!isAdmin) {
    return <SettingsLoading />;
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="mt-2 text-muted-foreground">
          Manage your workspace configuration. Event types and programs are in{" "}
          <Link href="/workspace/booking" className="font-medium text-primary-ink underline-offset-4 hover:underline">
            Booking setup
          </Link>
          ; people, DM teams, schedules and goals are in{" "}
          <Link href="/workspace/team" className="font-medium text-primary-ink underline-offset-4 hover:underline">
            Team
          </Link>
          .
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <TabsList>
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
          <TabsTrigger value="business-day">Business day</TabsTrigger>
          <TabsTrigger value="lead-gen">Lead gen</TabsTrigger>
          {canManageSettings ? <TabsTrigger value="respark">Respark</TabsTrigger> : null}
        </TabsList>

        <TabsContent value="integrations" className="mt-6">
          <IntegrationsTab preloadedSlackStatus={preloadedSlackStatus} />
        </TabsContent>
        <TabsContent value="business-day" className="mt-6"><BusinessDayCard /></TabsContent>
        <TabsContent value="lead-gen" className="mt-6"><SectionErrorBoundary sectionName="lead gen capture rules"><LeadGenRulesCard /></SectionErrorBoundary></TabsContent>
        {canManageSettings ? (
          <TabsContent value="respark" className="mt-6"><SectionErrorBoundary sectionName="respark settings"><ResparkSettingsCard /></SectionErrorBoundary></TabsContent>
        ) : null}
      </Tabs>
    </div>
  );
}
