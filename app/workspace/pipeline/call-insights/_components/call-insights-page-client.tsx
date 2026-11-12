"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useConvexAuth, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { SectionErrorBoundary } from "@/app/workspace/_components/section-error-boundary";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { TAB_CLASS } from "@/app/workspace/settings/_components/settings-band-frame";
import { CARD } from "@/app/workspace/team/_components/team-ui";
import { useBreadcrumbTrail } from "@/hooks/use-breadcrumbs";
import { usePageTitle } from "@/hooks/use-page-title";
import {
  CALL_INSIGHTS_HREF,
  CALL_INSIGHTS_TABS,
  CallInsightsBand,
  tabFromParam,
  type CallInsightsTab,
} from "./call-insights-band";
import { CardSkeleton, PAGE_ROOT } from "./call-insights-skeleton";
import { CallsTab } from "./calls-tab";
import { QualityTab } from "./quality/quality-tab";
import { ReportsTab } from "./reports-tab";
import { SettingsTab } from "./settings-tab";
import { SuggestionsTab } from "./suggestions-tab";

export type CallInsightsSettingsView = NonNullable<
  FunctionReturnType<typeof api.callInsights.queries.settings>
>;

/** Writes `?tab=` in place (no navigation), so a tab is linkable. */
function writeTabToUrl(tab: CallInsightsTab) {
  const url = new URL(window.location.href);
  url.searchParams.set("tab", tab);
  window.history.replaceState(window.history.state, "", url);
}

/**
 * The Call insights page: Calls, Suggestions, Reports, Quality and Settings
 * as tabs kept in `?tab=`. While the feature is off every tab but Settings
 * says so and points there.
 */
export function CallInsightsPageClient() {
  usePageTitle("Call insights");
  useBreadcrumbTrail([
    { label: "Pipeline", href: "/workspace/pipeline" },
    { label: "Call insights", href: CALL_INSIGHTS_HREF },
  ]);
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const [tab, setTab] = useState<CallInsightsTab>(() => tabFromParam(tabParam));
  // A link to another ?tab= while the page is open moves the tab too.
  const [seenParam, setSeenParam] = useState(tabParam);
  if (tabParam !== seenParam) {
    setSeenParam(tabParam);
    setTab(tabFromParam(tabParam));
  }
  // Right after a navigation the Convex client can run a query before it has
  // the session's token; wait for it rather than fail with auth.not_authenticated.
  const { isAuthenticated } = useConvexAuth();
  const settings = useQuery(
    api.callInsights.queries.settings,
    isAuthenticated ? {} : "skip",
  );

  // On a phone the tab row scrolls sideways: keep the open tab in view.
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    navRef.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab]);

  const selectTab = (next: CallInsightsTab) => {
    setTab(next);
    writeTabToUrl(next);
  };

  return (
    <div className={PAGE_ROOT}>
      <CallInsightsBand
        navRef={navRef}
        tabs={CALL_INSIGHTS_TABS.map((candidate) => (
          <a
            key={candidate.value}
            href={`?tab=${candidate.value}`}
            aria-current={candidate.value === tab ? "page" : undefined}
            className={TAB_CLASS}
            onClick={(event) => {
              // Let a modified click open the tab in a new window.
              if (
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey ||
                event.button !== 0
              )
                return;
              event.preventDefault();
              selectTab(candidate.value);
            }}
          >
            {candidate.label}
          </a>
        ))}
      />

      {settings === undefined ? (
        <CardSkeleton label="Loading Call insights" />
      ) : settings === null ? (
        <section className={CARD}>
          <SectionEmpty title="Only owners and admins can open Call insights." />
        </section>
      ) : tab !== "settings" && !settings.enabled ? (
        <section aria-label="Call insights is off" className={CARD}>
          <SectionEmpty title="Call insights is off. Turn it on in Settings.">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => selectTab("settings")}
            >
              Open Settings
            </Button>
          </SectionEmpty>
        </section>
      ) : (
        <SectionErrorBoundary key={tab} sectionName={`Call insights ${tab}`}>
          {tab === "calls" ? <CallsTab /> : null}
          {tab === "suggestions" ? (
            <SuggestionsTab
              suggestions={settings.settings?.suggestions ?? "off"}
            />
          ) : null}
          {tab === "reports" ? <ReportsTab /> : null}
          {tab === "quality" ? <QualityTab /> : null}
          {tab === "settings" ? (
            <SettingsTab
              view={settings}
              onOpenQuality={() => selectTab("quality")}
            />
          ) : null}
        </SectionErrorBoundary>
      )}
    </div>
  );
}
