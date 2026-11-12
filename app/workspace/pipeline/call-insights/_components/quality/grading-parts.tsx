"use client";

import type { ReactNode } from "react";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { Checkbox } from "@/components/ui/checkbox";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  VERDICT_CHOICES,
  judgeWords,
  labelTitle,
  labelValueWords,
  tickedParts,
  verdictWords,
  wrongFieldsFor,
  wrongPartOptions,
  wrongPartsWords,
  type Verdict,
  type WrongPart,
} from "@/lib/callInsights/quality-display";
import { cn } from "@/lib/utils";

export type GradingView = FunctionReturnType<
  typeof api.callInsights.eval.cases.caseForGrading
>;
export type AdminLabel = GradingView["adminItems"][number];
export type Candidate = NonNullable<GradingView["candidates"]>[number];
export type JudgeVerdict = NonNullable<GradingView["judge"]>[number];

/** One side of a segmented toggle; the chosen side lifts (DESIGN.md, Segment lift). */
export const SEGMENT =
  "h-[26px] rounded-[5px]! px-3 text-[13px] text-muted-foreground data-[state=on]:bg-card data-[state=on]:font-medium data-[state=on]:text-foreground data-[state=on]:shadow-[0_1px_2px_rgb(20_26_40/0.12)]";
/** The segmented toggle's track. */
export const SEGMENT_GROUP =
  "flex-wrap rounded-[7px] border bg-background p-0.5";

/** A ruled sub-heading inside a grading card: 13px semibold with an optional slate line. */
export function GradingSubhead({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="border-b bg-muted/40 px-4 py-2">
      <h3 className="text-[13px] font-semibold">{title}</h3>
      {children ? (
        <p className="text-[13px] text-muted-foreground">{children}</p>
      ) : null}
    </div>
  );
}

/**
 * Right / Wrong / Not sure, and under Wrong the parts that are wrong. Each
 * change is sent at once: `onGrade` gets the verdict and the exact field
 * names (an empty list means the whole item is wrong).
 */
export function VerdictControl({
  label,
  parts,
  onGrade,
  disabled,
}: {
  label: { labelId: string; adminVerdict?: string; wrongFields?: string[] };
  parts: WrongPart[];
  onGrade: (verdict: Verdict, wrongFields?: string[]) => void;
  disabled?: boolean;
}) {
  const ticked = tickedParts(parts, label.wrongFields);
  const groupId = `wrong-${label.labelId}`;
  return (
    <div className="flex flex-col gap-2">
      <ToggleGroup
        type="single"
        value={label.adminVerdict ?? ""}
        onValueChange={(value) => {
          if (value)
            onGrade(
              value as Verdict,
              value === "wrong" ? wrongFieldsFor(parts, ticked) : undefined,
            );
        }}
        disabled={disabled}
        aria-label="Your grade"
        className={SEGMENT_GROUP}
      >
        {VERDICT_CHOICES.map((choice) => (
          <ToggleGroupItem
            key={choice.value}
            value={choice.value}
            className={cn(SEGMENT, "min-w-20")}
          >
            {choice.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {label.adminVerdict === "wrong" && parts.length ? (
        <fieldset
          aria-describedby={`${groupId}-hint`}
          className="flex flex-col gap-1.5"
        >
          <legend className="sr-only">What is wrong</legend>
          <p
            id={`${groupId}-hint`}
            className="text-[13px] text-muted-foreground"
          >
            Tick what is wrong. Leave all unticked when the whole item is wrong.
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {parts.map((part) => {
              const id = `${groupId}-${part.key}`;
              return (
                <label
                  key={part.key}
                  htmlFor={id}
                  className="flex min-h-6 items-center gap-2 text-sm"
                >
                  <Checkbox
                    id={id}
                    checked={ticked.has(part.key)}
                    disabled={disabled}
                    onCheckedChange={(checked) => {
                      const next = new Set(ticked);
                      if (checked === true) next.add(part.key);
                      else next.delete(part.key);
                      onGrade("wrong", wrongFieldsFor(parts, next));
                    }}
                  />
                  {part.label}
                </label>
              );
            })}
          </div>
        </fieldset>
      ) : null}
    </div>
  );
}

/** Opus's verdict beside an item, only ever rendered once grades are saved. */
export function JudgeLine({ judge }: { judge?: JudgeVerdict }) {
  const words = judgeWords(judge?.verdict);
  if (!words) return null;
  const rerun = judgeWords(judge?.rerunVerdict);
  return (
    <p className="text-[13px] text-muted-foreground">
      <span
        className={cn(
          "font-medium",
          judge?.verdict === "contradicted"
            ? "text-danger-ink"
            : "text-foreground",
        )}
      >
        Opus: {words}
      </span>
      {judge?.verdict === "contradicted" && judge.wrongFields?.length
        ? ` · ${judge.wrongFields.join(", ")}`
        : null}
      {judge?.lines?.length
        ? ` · lines ${judge.lines.map((line) => `#${line}`).join(", ")}`
        : null}
      {rerun && rerun !== words ? ` · asked again: ${rerun}` : null}
    </p>
  );
}

/**
 * One item the reading produced: what it is, its typed values, its statement
 * and quote, and the grade. Read-only once grades are saved, with Opus's
 * verdict beside it when there is one.
 */
export function CandidateRow({
  candidate,
  onGrade,
  judge,
  readOnly,
  extra,
}: {
  candidate: Candidate;
  onGrade?: (verdict: Verdict, wrongFields?: string[]) => void;
  judge?: JudgeVerdict;
  readOnly?: boolean;
  extra?: ReactNode;
}) {
  const parts = wrongPartOptions(candidate);
  const values = labelValueWords(candidate);
  return (
    <li className="flex flex-col gap-2 border-b px-4 py-3 last:border-b-0">
      <div className="min-w-0">
        <p className="text-sm font-medium">{labelTitle(candidate)}</p>
        {values.length ? (
          <p className="text-[13px] text-muted-foreground">
            {values.join(" · ")}
          </p>
        ) : null}
        {candidate.statement ? (
          <p className="mt-1 text-sm leading-snug">{candidate.statement}</p>
        ) : null}
        {candidate.quote ? (
          <blockquote className="mt-1 border-l-2 pl-2.5 text-sm leading-snug text-muted-foreground">
            &ldquo;{candidate.quote}&rdquo;
          </blockquote>
        ) : candidate.itemClass !== "result" &&
          candidate.itemClass !== "attendance" &&
          !candidate.statement ? (
          <p className="mt-1 text-[13px] text-muted-foreground">
            The statement and quote are gone with the transcript.
          </p>
        ) : null}
        {extra}
      </div>
      {readOnly ? (
        <div className="flex flex-col gap-0.5">
          <p className="text-[13px]">
            <span className="text-muted-foreground">Your grade: </span>
            <span className="font-medium">
              {verdictWords(candidate.adminVerdict)}
            </span>
            {candidate.adminVerdict === "wrong" ? (
              <span className="text-muted-foreground">
                {" "}
                · {wrongPartsWords(parts, candidate.wrongFields)}
              </span>
            ) : null}
          </p>
          <JudgeLine judge={judge} />
        </div>
      ) : onGrade ? (
        <VerdictControl label={candidate} parts={parts} onGrade={onGrade} />
      ) : null}
    </li>
  );
}
