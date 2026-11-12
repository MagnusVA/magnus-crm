"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { DetailCard } from "@/app/workspace/closer/meetings/_components/detail-card";
import {
  COLUMN_HEAD,
  FIGURE_15,
  ReportNote,
  RowsSkeleton,
} from "@/app/workspace/reports/_components/report-ui";
import { getErrorMessage } from "@/lib/errors";
import {
  TEST_SPLITS,
  campaignProgress,
  splitWords,
} from "@/lib/callInsights/quality-display";
import { cn } from "@/lib/utils";

export type CampaignRow = FunctionReturnType<
  typeof api.callInsights.eval.cases.campaigns
>["campaigns"][number];

const ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 px-4 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,17rem)_minmax(0,15rem)] @3xl:items-center";

/**
 * Section 1, "Quality tests": what a test is, a way to start one, and every
 * test with its calls per split and how far grading has got. Choosing a test
 * scopes the cards below it.
 */
export function CampaignsCard({
  campaigns,
  capped,
  selected,
  onSelect,
}: {
  campaigns: CampaignRow[] | undefined;
  capped: boolean;
  selected: string | null;
  onSelect: (campaign: string) => void;
}) {
  const createCampaign = useMutation(
    api.callInsights.eval.cases.createCampaign,
  );
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name the quality test.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const created = await createCampaign({ name: trimmed });
      const total = created.dev + created.calib + created.holdout;
      setName("");
      if (total === 0) {
        toast.info(
          "No call could be used yet. A call needs a saved reading and a transcript kept 14 more days.",
        );
      } else {
        toast.success(
          `Quality test started with ${total} ${total === 1 ? "call" : "calls"}.`,
        );
        onSelect(created.campaign);
      }
    } catch (cause) {
      setError(getErrorMessage(cause, "Couldn't start the quality test."));
    } finally {
      setCreating(false);
    }
  };

  return (
    <DetailCard title="Quality tests">
      <p className="border-b px-4 py-3 text-sm leading-relaxed">
        A quality test takes up to 60 read calls. You read each one and mark
        what the reading got right. The results decide which parts of Call
        insights are safe to switch on.
      </p>
      <form
        className="flex flex-wrap items-start gap-2 border-b px-4 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1 @lg:max-w-80">
          <label
            htmlFor="quality-test-name"
            className="text-[13px] text-muted-foreground"
          >
            Name
          </label>
          <Input
            id="quality-test-name"
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
            placeholder="November quality"
            aria-invalid={error ? true : undefined}
            className="h-8"
          />
        </div>
        <Button
          type="submit"
          className="mt-[22px] font-semibold"
          disabled={creating}
        >
          {creating ? <Spinner data-icon="inline-start" /> : null}
          Start a quality test
        </Button>
        {error ? (
          <p role="alert" className="basis-full text-[13px] text-danger-ink">
            {error}
          </p>
        ) : null}
      </form>
      {capped ? (
        <ReportNote lead="Partial.">
          Counts stop at 1,000 quality calls, so some tests may show fewer.
        </ReportNote>
      ) : null}
      <div className="@container">
        {campaigns === undefined ? (
          <RowsSkeleton
            rows={2}
            rowHeight="h-14"
            label="Loading quality tests"
          />
        ) : campaigns.length === 0 ? (
          <SectionEmpty title="No quality tests yet.">
            Start one to grade read calls.
          </SectionEmpty>
        ) : (
          <>
            <div
              aria-hidden="true"
              className={cn(ROW_GRID, "hidden border-b @3xl:grid")}
            >
              <span className={cn(COLUMN_HEAD, "px-0")}>Test</span>
              <span className={cn(COLUMN_HEAD, "px-0")}>Calls</span>
              <span className={cn(COLUMN_HEAD, "px-0")}>Progress</span>
            </div>
            <ul aria-label="Quality tests">
              {campaigns.map((row) => {
                const progress = campaignProgress(row.statuses);
                const isSelected = row.campaign === selected;
                return (
                  <li
                    key={row.campaign}
                    className={cn(
                      ROW_GRID,
                      "relative min-h-14 border-b py-2.5 last:border-b-0 hover:bg-muted/60",
                      isSelected && "bg-muted/60",
                    )}
                  >
                    <div className="min-w-0">
                      <button
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => onSelect(row.campaign)}
                        className={cn(
                          "block max-w-full truncate text-left text-foreground outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset",
                          isSelected ? "font-semibold" : "font-medium",
                        )}
                      >
                        {row.campaign}
                      </button>
                      {isSelected ? (
                        <p className="text-[13px] text-muted-foreground">
                          Shown below
                        </p>
                      ) : null}
                    </div>
                    <p className="order-last col-span-2 text-[13px] text-muted-foreground @3xl:order-none @3xl:col-span-1">
                      {TEST_SPLITS.map((split, index) => (
                        <span key={split}>
                          {index ? " · " : null}
                          {splitWords(split)}{" "}
                          <span
                            className={cn(FIGURE_15, "text-sm text-foreground")}
                          >
                            {row.counts[split] ?? 0}
                          </span>
                        </span>
                      ))}
                    </p>
                    <p className="text-right text-[13px] text-muted-foreground @3xl:text-left">
                      <span
                        className={cn(FIGURE_15, "text-sm text-foreground")}
                      >
                        {progress.toRead}
                      </span>{" "}
                      to read ·{" "}
                      <span
                        className={cn(FIGURE_15, "text-sm text-foreground")}
                      >
                        {progress.listDone}
                      </span>{" "}
                      list done ·{" "}
                      <span
                        className={cn(FIGURE_15, "text-sm text-foreground")}
                      >
                        {progress.graded}
                      </span>{" "}
                      graded
                    </p>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </DetailCard>
  );
}
