"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePageTitle } from "@/hooks/use-page-title";
import { OperationsHealthBanner } from "./operations-health-banner";
import { PhoneSalesTab } from "./phone-sales-tab";
import { QualificationTab } from "./qualification-tab";
import { SchedulingTab } from "./scheduling-tab";

type OperationsTab = "qualifications" | "scheduling" | "phone-sales";

const OPERATION_TABS = new Set<OperationsTab>([
  "qualifications",
  "scheduling",
  "phone-sales",
]);

function readTab(value: string | null): OperationsTab {
  return value && OPERATION_TABS.has(value as OperationsTab)
    ? (value as OperationsTab)
    : "qualifications";
}

export function OperationsPageClient() {
  usePageTitle("Operations");

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeTab = readTab(searchParams.get("tab"));

  const setTab = (tab: OperationsTab) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", tab);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Operations</h1>
        <p className="text-sm text-muted-foreground">
          Review qualification, scheduling, and phone-sales work queues.
        </p>
      </div>

      <OperationsHealthBanner />

      <Tabs
        value={activeTab}
        onValueChange={(value) => setTab(value as OperationsTab)}
      >
        <TabsList className="grid h-auto w-full grid-cols-1 sm:inline-flex sm:w-fit">
          <TabsTrigger value="qualifications">Qualifications</TabsTrigger>
          <TabsTrigger value="scheduling">Scheduling</TabsTrigger>
          <TabsTrigger value="phone-sales">Phone Sales</TabsTrigger>
        </TabsList>
        <TabsContent value="qualifications" className="mt-6">
          <QualificationTab />
        </TabsContent>
        <TabsContent value="scheduling" className="mt-6">
          <SchedulingTab />
        </TabsContent>
        <TabsContent value="phone-sales" className="mt-6">
          <PhoneSalesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
