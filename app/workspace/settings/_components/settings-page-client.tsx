"use client";

import { Suspense, useEffect, useState } from "react";
import { type Preloaded, usePreloadedQuery, useQuery } from "convex/react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { useRole } from "@/components/auth/role-context";
import { SectionErrorBoundary } from "@/app/workspace/_components/section-error-boundary";
import { usePageTitle } from "@/hooks/use-page-title";
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";
import { BusinessDayCard } from "./business-day-card";
import { IntegrationsTab } from "./integrations/integrations-tab";
import { calendlyState, slackState } from "./integrations/integration-status";
import { LeadGenRulesCard } from "./lead-gen-rules-card";
import { ResparkSettingsCard } from "./respark-settings-card";
import { SETTINGS_TABS, SettingsBandFrame, TAB_CLASS, type SettingsTab } from "./settings-band-frame";
import { SettingsPageSkeleton } from "./settings-skeleton";
import { SETTINGS_ROOT } from "./settings-ui";

type SettingsPageClientProps = {
  preloadedSlackStatus: Preloaded<typeof api.slack.channels.getInstallationStatus>;
};

const LEAD_GEN_RULES_HASH = "#lead-gen-rules";

// Legacy deep link: Calendly merged into Integrations. Event types, programs,
// attribution and schedules redirect server-side in page.tsx.
function tabFromParam(value: string | null): SettingsTab {
  if (value === "calendly") return "integrations";
  return SETTINGS_TABS.some((tab) => tab.value === value) ? (value as SettingsTab) : "integrations";
}

/** Writes `?tab=` in place (no navigation), so a tab is linkable. */
function writeTabToUrl(tab: SettingsTab) {
  const url = new URL(window.location.href);
  url.searchParams.set("tab", tab);
  // The lead gen rules anchor only belongs to its tab.
  if (tab !== "lead-gen" && url.hash === LEAD_GEN_RULES_HASH) url.hash = "";
  window.history.replaceState(window.history.state, "", url);
}

export function SettingsPageClient({ preloadedSlackStatus }: SettingsPageClientProps) {
  return (
    <Suspense fallback={<SettingsPageSkeleton />}>
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
  const tabParam = searchParams.get("tab");
  const [tab, setTab] = useState<SettingsTab>(() => tabFromParam(tabParam));
  // A link to another ?tab= while the page is open moves the tab too.
  const [seenParam, setSeenParam] = useState(tabParam);
  if (tabParam !== seenParam) {
    setSeenParam(tabParam);
    setTab(tabFromParam(tabParam));
  }
  const shownTab: SettingsTab = tab === "respark" && !canManageSettings ? "integrations" : tab;

  // Read once here for the Calendly card and the band's Integrations count.
  const calendlyStatus = useQuery(api.calendly.oauthQueries.getConnectionStatus, isAdmin ? {} : "skip");
  const slackStatus = usePreloadedQuery(preloadedSlackStatus);
  const now = useNow();
  const owed = [calendlyStatus ? calendlyState(calendlyStatus, now) : null, slackState(slackStatus)].filter(
    (state) => state !== null && state.tone !== "ok",
  );
  const owedTone = owed.some((state) => state?.tone === "danger") ? "danger" : "warning";

  useEffect(() => {
    if (!isAdmin) {
      router.replace("/workspace/closer");
    }
  }, [isAdmin, router]);

  // /workspace/settings#lead-gen-rules (where the old Lead Gen settings' Rules
  // tab redirects) opens the Lead gen tab and scrolls to the rules.
  useEffect(() => {
    const openFromHash = () => {
      if (window.location.hash !== LEAD_GEN_RULES_HASH) return;
      setTab("lead-gen");
      writeTabToUrl("lead-gen");
      requestAnimationFrame(() => document.getElementById("lead-gen-rules")?.scrollIntoView({ block: "start" }));
    };
    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    return () => window.removeEventListener("hashchange", openFromHash);
  }, []);

  if (!isAdmin) {
    return <SettingsPageSkeleton />;
  }

  const tabs = SETTINGS_TABS.filter((candidate) => candidate.value !== "respark" || canManageSettings);

  const selectTab = (next: SettingsTab) => {
    setTab(next);
    writeTabToUrl(next);
  };

  return (
    <div className={SETTINGS_ROOT}>
      <SettingsBandFrame
        tabs={tabs.map((candidate) => (
          <a
            key={candidate.value}
            href={`?tab=${candidate.value}`}
            aria-current={candidate.value === shownTab ? "page" : undefined}
            className={TAB_CLASS}
            onClick={(event) => {
              // Let a modified click open the tab in a new window.
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
              event.preventDefault();
              selectTab(candidate.value);
            }}
          >
            {candidate.label}
            {candidate.value === "integrations" && owed.length > 0 ? (
              <span
                className={cn(
                  "rounded-[4px] bg-board-foreground/8 px-[5px] py-[3px] font-condensed text-[12px] leading-none tracking-[0.02em] tabular-nums",
                  owedTone === "danger" ? "text-board-danger" : "text-warning",
                )}
              >
                {owed.length}
                <span className="sr-only"> {owed.length === 1 ? "integration needs" : "integrations need"} attention</span>
              </span>
            ) : null}
          </a>
        ))}
      />

      {shownTab === "integrations" ? (
        <IntegrationsTab preloadedSlackStatus={preloadedSlackStatus} calendlyStatus={calendlyStatus} />
      ) : null}
      {shownTab === "business-day" ? (
        <SectionErrorBoundary sectionName="business day">
          <BusinessDayCard />
        </SectionErrorBoundary>
      ) : null}
      {shownTab === "lead-gen" ? (
        <SectionErrorBoundary sectionName="lead gen capture rules">
          <LeadGenRulesCard />
        </SectionErrorBoundary>
      ) : null}
      {shownTab === "respark" ? (
        <SectionErrorBoundary sectionName="respark settings">
          <ResparkSettingsCard />
        </SectionErrorBoundary>
      ) : null}
    </div>
  );
}
