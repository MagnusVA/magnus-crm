"use client";

import { useId, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { CARD, CardHead } from "@/app/workspace/team/_components/team-ui";
import { NoteLine } from "@/app/workspace/settings/_components/settings-ui";
import { cn } from "@/lib/utils";
import { AUTOMATION_KINDS, countWords, type AutomationKind, type KindDefinition } from "./automation-kinds";
import { INLINE_FIGURE, SEGMENT, SEGMENT_GROUP } from "./automation-ui";
import { GradingCase, UnsureGradingCase, type GradeSample } from "./grading-case";

const SAMPLES: ReadonlyArray<{ value: GradeSample; label: string }> = [
  { value: "writes", label: "Would have written" },
  { value: "abstentions", label: "Left for a person" },
];

/**
 * The grading queue: a tab per kind, the two samples, and one case at a time,
 * oldest first and one per person. Owners can open unsure grades for
 * their second look.
 */
export function GradingCard({
  kinds = AUTOMATION_KINDS,
  canResolveUnsure,
}: {
  kinds?: readonly KindDefinition[];
  canResolveUnsure: boolean;
}) {
  const id = useId();
  const [kind, setKind] = useState<AutomationKind>(kinds[0].kind);
  const [sample, setSample] = useState<GradeSample>("writes");
  const definition = kinds.find((row) => row.kind === kind) ?? kinds[0];
  const queue = useQuery(api.automation.grading.listToGrade, { kind, sample });
  const unsure = useQuery(api.automation.grading.listUnsure, canResolveUnsure ? { kind } : "skip");
  const next = queue?.cases[0];

  return (
    <section aria-labelledby={`${id}-title`} className={cn(CARD, "@container/grading")}>
      <CardHead
        title={<span id={`${id}-title`}>Grading</span>}
        meta={
          queue ? (
            <>
              <span className={INLINE_FIGURE}>{countWords(queue.cases.length, queue.capped)}</span> waiting · oldest first
            </>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-2 border-b border-border px-4 py-2.5 @2xl/grading:flex-row @2xl/grading:items-center @2xl/grading:justify-between">
        <ToggleGroup
          type="single"
          value={kind}
          aria-label="Kind of result"
          className={cn(SEGMENT_GROUP, "flex-wrap")}
          onValueChange={(value) => {
            if (value) setKind(value as AutomationKind);
          }}
        >
          {kinds.map((row) => (
            <ToggleGroupItem key={row.kind} value={row.kind} className={SEGMENT}>
              {row.shortName}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <ToggleGroup
          type="single"
          value={sample}
          aria-label="Sample"
          className={cn(SEGMENT_GROUP, "flex-wrap")}
          onValueChange={(value) => {
            if (value) setSample(value as GradeSample);
          }}
        >
          {SAMPLES.map((row) => (
            <ToggleGroupItem key={row.value} value={row.value} className={SEGMENT}>
              {row.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <NoteLine className="border-b border-border px-4 py-2">
        {sample === "writes"
          ? "Cases the rule would have written by itself. Only these count toward the clean record."
          : "Cases the rule left for a person, graded apart to see what it misses."}
      </NoteLine>

      {queue === undefined ? (
        <p role="status" className="px-4 py-3 text-[13px] text-muted-foreground">Loading the queue…</p>
      ) : next ? (
        <GradingCase
          key={next.decisionId}
          definition={definition}
          sample={sample}
          gradeCase={next}
        />
      ) : queue.notGrader ? (
        <SectionEmpty title="Someone else grades.">
          Only the named grader sees cases. The owner can change who grades under Grader.
        </SectionEmpty>
      ) : (
        <SectionEmpty title="Nothing to grade here.">
          {definition.source === "call"
            ? "New cases arrive while this kind is at Shadow or Ask and Call insights reads recorded calls. A call case takes about twelve minutes."
            : "New cases arrive while this kind is at Shadow or Ask and Whop reports payments. A payment case takes about two minutes."}
        </SectionEmpty>
      )}

      {unsure?.length ? (
        <section aria-labelledby={`${id}-unsure-title`} className="border-t border-border">
          <h3 id={`${id}-unsure-title`} className="px-4 py-2.5 text-[13px] font-semibold">Unsure grades waiting for a second look</h3>
          <ul>
            {unsure.map((entry) => (
              <li key={entry.decisionId}><UnsureGradingCase entry={entry} /></li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}
