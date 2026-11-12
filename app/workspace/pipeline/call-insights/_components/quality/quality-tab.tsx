"use client";

import { useState } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { SectionErrorBoundary } from "@/app/workspace/_components/section-error-boundary";
import { sortCampaigns } from "@/lib/callInsights/quality-display";
import { CampaignsCard } from "./campaigns-card";
import { CasesCard } from "./cases-card";
import { OpusCard } from "./opus-card";
import { ResultsCard } from "./results-card";
import { WaitCard } from "./wait-card";

/**
 * The Quality tab, for owners and admins: quality tests and their calls to
 * grade, the bars they produce, how far Opus can be trusted, and the no-show
 * wait. One admin grades; the admin's saved grades are the truth.
 */
export function QualityTab() {
  const { isAuthenticated } = useConvexAuth();
  const campaigns = useQuery(
    api.callInsights.eval.cases.campaigns,
    isAuthenticated ? {} : "skip",
  );
  const settings = useQuery(
    api.callInsights.queries.settings,
    isAuthenticated ? {} : "skip",
  );
  const [chosen, setChosen] = useState<string | null>(null);

  const sorted = campaigns ? sortCampaigns(campaigns.campaigns) : undefined;
  // The chosen test, or the newest one until a test is chosen.
  const selected =
    sorted && chosen && sorted.some((row) => row.campaign === chosen)
      ? chosen
      : (sorted?.[0]?.campaign ?? null);

  return (
    <div className="flex flex-col gap-3.5 short:gap-3">
      <CampaignsCard
        campaigns={sorted}
        capped={campaigns?.capped ?? false}
        selected={selected}
        onSelect={setChosen}
      />
      {selected ? (
        <>
          <SectionErrorBoundary
            key={`cases:${selected}`}
            sectionName="calls to grade"
          >
            <CasesCard campaign={selected} />
          </SectionErrorBoundary>
          <SectionErrorBoundary
            key={`results:${selected}`}
            sectionName="quality results"
          >
            <ResultsCard campaign={selected} />
          </SectionErrorBoundary>
          <SectionErrorBoundary key={`opus:${selected}`} sectionName="Opus">
            <OpusCard campaign={selected} job={settings?.job ?? null} />
          </SectionErrorBoundary>
        </>
      ) : null}
      <SectionErrorBoundary sectionName="no-show wait">
        <WaitCard currentWait={settings?.settings?.noShowWaitMinutes} />
      </SectionErrorBoundary>
    </div>
  );
}
