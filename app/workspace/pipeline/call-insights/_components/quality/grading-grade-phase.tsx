"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import {
  DetailCard,
  DetailCardFooter,
} from "@/app/workspace/closer/meetings/_components/detail-card";
import { useLocalFormat } from "@/app/workspace/closer/meetings/_components/local-time";
import { ReportNote } from "@/app/workspace/reports/_components/report-ui";
import { getErrorMessage } from "@/lib/errors";
import {
  noShowTierWords,
  suggestionKindWords,
  suggestionTierWords,
} from "@/lib/callInsights/report-display";
import {
  gradingProgress,
  isExtractionClass,
  labelTitle,
  labelValueWords,
  proposeMatches,
  resultValueRows,
  type Verdict,
} from "@/lib/callInsights/quality-display";
import type { ConfirmRequest } from "../confirm-dialog";
import {
  CandidateRow,
  GradingSubhead,
  type AdminLabel,
  type Candidate,
  type GradingView,
} from "./grading-parts";

const ConfirmDialog = dynamic(() => import("../confirm-dialog"));

const MISSED = "missed";

type LabelId = Id<"callInsightEvalLabels">;

/** Remembers, per case and revision, that the proposed matches were applied once, so a deliberate "missed" sticks. */
function proposalKey(caseId: string, revision: number) {
  return `call-insights-quality-proposal:${caseId}:${revision}`;
}
function proposalApplied(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
function markProposalApplied(key: string) {
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // Private windows can refuse storage; the proposal may then apply again on reload.
  }
}

/** "Paid on the call · Ready" and its values, the suggestion the reading made. */
function SuggestionFacts({ candidate }: { candidate: Candidate }) {
  const format = useLocalFormat();
  const rows = resultValueRows(candidate.resultValues ?? {}, (at) =>
    format(at, "MMM d, h:mm a"),
  );
  return (
    <dl className="mt-1 flex flex-col gap-0.5 text-[13px]">
      {rows.map((row) => (
        <div key={row.field} className="flex gap-2">
          <dt className="w-28 shrink-0 text-muted-foreground">{row.label}</dt>
          <dd className="min-w-0">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** What the admin said in step 1, under the suggestion it is compared with. */
function YouSaid({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-1 text-[13px]">
      <span className="text-muted-foreground">You said: </span>
      {children}
    </p>
  );
}

function adminResultWords(
  items: AdminLabel[],
  format: (at: number, pattern: string) => string,
) {
  const result = items.find((item) => item.itemClass === "result");
  if (!result?.resultKind) return null;
  const values = resultValueRows(result.resultValues ?? {}, (at) =>
    format(at, "MMM d, h:mm a"),
  );
  return [
    suggestionKindWords(result.resultKind),
    ...values.map((row) => row.value),
  ].join(" · ");
}

function adminAttendanceWords(items: AdminLabel[]) {
  const attendance = items.find((item) => item.itemClass === "attendance");
  if (!attendance) return null;
  return attendance.category === "held"
    ? "the prospect attended"
    : "the prospect didn't attend";
}

/**
 * Step 2, "Grade the reading", and the saved summary. While grading, each
 * item the reading produced takes Right, Wrong (with the wrong parts) or Not
 * sure; the admin's own items are matched to the reading's (the proposal is
 * applied once); the suggested result and the no-show tier are graded the
 * same way. Once saved the grades are read-only and Opus's verdicts, if any,
 * appear beside each item; they never show before.
 */
export function GradingGradePhase({ view }: { view: GradingView }) {
  const caseId = view.case.caseId;
  const done = view.phase === "done";
  const format = useLocalFormat();

  const grade = useMutation(
    api.callInsights.eval.labels.gradeItem,
  ).withOptimisticUpdate((store, args) => {
    const current = store.getQuery(api.callInsights.eval.cases.caseForGrading, {
      caseId,
    });
    if (!current?.candidates) return;
    store.setQuery(
      api.callInsights.eval.cases.caseForGrading,
      { caseId },
      {
        ...current,
        candidates: current.candidates.map((candidate) =>
          candidate.labelId === args.labelId
            ? {
                ...candidate,
                adminVerdict: args.verdict,
                wrongFields:
                  args.verdict === "wrong" ? (args.wrongFields ?? []) : [],
              }
            : candidate,
        ),
      },
    );
  });
  const match = useMutation(
    api.callInsights.eval.labels.matchAdminItem,
  ).withOptimisticUpdate((store, args) => {
    const current = store.getQuery(api.callInsights.eval.cases.caseForGrading, {
      caseId,
    });
    if (!current) return;
    store.setQuery(
      api.callInsights.eval.cases.caseForGrading,
      { caseId },
      {
        ...current,
        adminItems: current.adminItems.map((item) =>
          item.labelId === args.labelId
            ? { ...item, matchedLabelId: args.matchedLabelId ?? undefined }
            : item,
        ),
      },
    );
  });
  const commitLabels = useMutation(api.callInsights.eval.labels.commitLabels);
  const reopen = useMutation(api.callInsights.eval.labels.reopenCase);

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  const candidates = view.candidates ?? [];
  const extracted = candidates.filter((candidate) =>
    isExtractionClass(candidate.itemClass),
  );
  const resultCandidate = candidates.find(
    (candidate) => candidate.itemClass === "result",
  );
  const attendanceCandidate = candidates.find(
    (candidate) => candidate.itemClass === "attendance",
  );
  const ownItems = view.adminItems.filter((item) =>
    isExtractionClass(item.itemClass),
  );
  const progress = gradingProgress(candidates);
  const judgeByLabel = new Map(
    (view.judge ?? []).map((verdict) => [verdict.labelId, verdict]),
  );
  const youSaidResult = adminResultWords(view.adminItems, format);
  const youSaidAttendance = adminAttendanceWords(view.adminItems);

  // Apply the proposed matches once, when grading starts and nothing is matched yet.
  const applying = useRef(false);
  useEffect(() => {
    if (done || applying.current) return;
    const key = proposalKey(caseId, view.case.labelRevision);
    if (proposalApplied(key)) return;
    if (
      ownItems.length === 0 ||
      ownItems.some((item) => item.matchedLabelId !== undefined)
    ) {
      markProposalApplied(key);
      return;
    }
    const proposal = proposeMatches(ownItems, extracted).filter(
      (pair) => pair.matchedLabelId !== null,
    );
    applying.current = true;
    markProposalApplied(key);
    void Promise.all(
      proposal.map((pair) =>
        match({
          labelId: pair.labelId,
          matchedLabelId: pair.matchedLabelId as LabelId,
        }),
      ),
    ).catch((cause) =>
      setError(getErrorMessage(cause, "Couldn't match your items.")),
    );
  }, [caseId, done, extracted, match, ownItems, view.case.labelRevision]);

  const onGrade =
    (labelId: LabelId) => (verdict: Verdict, wrongFields?: string[]) => {
      setError(null);
      grade({
        labelId,
        verdict,
        ...(verdict === "wrong" ? { wrongFields: wrongFields ?? [] } : {}),
      }).catch((cause) =>
        setError(getErrorMessage(cause, "Couldn't save the grade.")),
      );
    };

  const onMatch = (labelId: LabelId, value: string) => {
    setError(null);
    match({
      labelId,
      matchedLabelId: value === MISSED ? null : (value as LabelId),
    }).catch((cause) =>
      setError(getErrorMessage(cause, "Couldn't save the match.")),
    );
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await commitLabels({ caseId });
    } catch (cause) {
      setError(getErrorMessage(cause, "Couldn't save the grades."));
    } finally {
      setSaving(false);
    }
  };

  const askReopen = () =>
    setConfirm({
      title: `Reopen ${view.case.leadName}'s grades?`,
      description:
        "The call goes back to grading, and its grades leave the results until you save them again.",
      warning:
        "Grades you make after seeing Opus's verdicts don't count for calibrating Opus.",
      confirmLabel: "Reopen",
      pendingLabel: "Reopening…",
      run: async () => {
        await reopen({ caseId });
      },
    });

  const usedBy = new Map<string, string>();
  for (const item of ownItems)
    if (item.matchedLabelId) usedBy.set(item.matchedLabelId, item.labelId);

  const graded = candidates.filter(
    (candidate) => candidate.adminVerdict !== undefined,
  );
  const right = graded.filter(
    (candidate) => candidate.adminVerdict === "right",
  ).length;
  const wrong = graded.filter(
    (candidate) => candidate.adminVerdict === "wrong",
  ).length;
  const unsure = graded.filter(
    (candidate) => candidate.adminVerdict === "unsure",
  ).length;
  const found = ownItems.filter(
    (item) => item.matchedLabelId !== undefined,
  ).length;

  return (
    <div className="flex min-w-0 flex-col gap-3.5 short:gap-3">
      {done ? (
        <DetailCard
          title="Grades saved"
          meta={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={askReopen}
            >
              Reopen
            </Button>
          }
        >
          <div className="flex flex-col gap-1 px-4 py-3 text-sm">
            <p>
              {right} right, {wrong} wrong, {unsure} not sure, of{" "}
              {candidates.length} the reading produced.
            </p>
            <p className="text-muted-foreground">
              {view.case.listSkipped
                ? "You skipped your own list, so this call doesn't count toward the missed-item checks."
                : `Your list: ${ownItems.length} ${ownItems.length === 1 ? "item" : "items"}, ${found} found by the reading, ${ownItems.length - found} missed.`}
            </p>
            {view.case.judgeExposed ? (
              <p className="text-muted-foreground">
                These grades were reopened after Opus&apos;s verdicts were
                visible, so they don&apos;t count for calibrating Opus.
              </p>
            ) : null}
            {view.judge === undefined || view.judge.length === 0 ? (
              <p className="text-muted-foreground">
                Opus hasn&apos;t graded this call.
              </p>
            ) : null}
          </div>
        </DetailCard>
      ) : null}

      <DetailCard
        title={done ? "What the reading found" : "Grade the reading"}
        meta={
          done
            ? null
            : `Step 2 of 2 · ${progress.graded} of ${progress.total} graded`
        }
      >
        {done ? null : (
          <ReportNote>
            Mark each item Right, Wrong or Not sure. Not sure is saved but never
            counts as right.
          </ReportNote>
        )}
        <GradingSubhead title="Items" />
        {extracted.length === 0 ? (
          <SectionEmpty title="The reading listed nothing for this call." />
        ) : (
          <ul aria-label="Items the reading produced">
            {extracted.map((candidate) => (
              <CandidateRow
                key={candidate.labelId}
                candidate={candidate}
                readOnly={done}
                judge={judgeByLabel.get(candidate.labelId)}
                onGrade={onGrade(candidate.labelId)}
              />
            ))}
          </ul>
        )}

        <GradingSubhead title="Suggested result" />
        {resultCandidate ? (
          <ul aria-label="Suggested result">
            <CandidateRow
              candidate={resultCandidate}
              readOnly={done}
              judge={judgeByLabel.get(resultCandidate.labelId)}
              onGrade={onGrade(resultCandidate.labelId)}
              extra={
                <>
                  <p className="text-sm">
                    {resultCandidate.resultKind
                      ? suggestionKindWords(resultCandidate.resultKind)
                      : "No result"}
                    {resultCandidate.resultTier ? (
                      <span className="text-muted-foreground">
                        {" "}
                        · {suggestionTierWords(resultCandidate.resultTier)}
                      </span>
                    ) : null}
                  </p>
                  <SuggestionFacts candidate={resultCandidate} />
                  {youSaidResult ? <YouSaid>{youSaidResult}</YouSaid> : null}
                </>
              }
            />
          </ul>
        ) : (
          <SectionEmpty title="The reading suggested no result for this call." />
        )}

        <GradingSubhead title="No-show" />
        {attendanceCandidate ? (
          <ul aria-label="No-show tier">
            <CandidateRow
              candidate={attendanceCandidate}
              readOnly={done}
              judge={judgeByLabel.get(attendanceCandidate.labelId)}
              onGrade={onGrade(attendanceCandidate.labelId)}
              extra={
                <>
                  <p className="text-sm">
                    {noShowTierWords(attendanceCandidate.noShowTier ?? "none")}
                  </p>
                  {youSaidAttendance ? (
                    <YouSaid>{youSaidAttendance}</YouSaid>
                  ) : null}
                </>
              }
            />
          </ul>
        ) : (
          <SectionEmpty title="The reading gave no no-show tier." />
        )}
      </DetailCard>

      <DetailCard
        title="Your items"
        meta={view.case.listSkipped ? "Skipped" : `${ownItems.length}`}
      >
        {view.case.listSkipped ? (
          <SectionEmpty title="You skipped your own list." />
        ) : ownItems.length === 0 ? (
          <SectionEmpty title="You listed nothing for this call." />
        ) : (
          <>
            {done ? null : (
              <ReportNote>
                Each of your items is matched to the reading&apos;s item that
                says the same. Change it, or choose &ldquo;The reading missed
                this&rdquo;.
              </ReportNote>
            )}
            <ul aria-label="Your items">
              {ownItems.map((item) => {
                const options = extracted.filter(
                  (candidate) => candidate.itemClass === item.itemClass,
                );
                const matched = options.find(
                  (candidate) => candidate.labelId === item.matchedLabelId,
                );
                const values = labelValueWords(item);
                const selectId = `match-${item.labelId}`;
                return (
                  <li
                    key={item.labelId}
                    className="flex flex-col gap-2 border-b px-4 py-3 last:border-b-0"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{labelTitle(item)}</p>
                      {values.length ? (
                        <p className="text-[13px] text-muted-foreground">
                          {values.join(" · ")}
                        </p>
                      ) : null}
                    </div>
                    {done ? (
                      <p className="text-[13px]">
                        {matched ? (
                          <>
                            <span className="text-muted-foreground">
                              Matched:{" "}
                            </span>
                            {labelTitle(matched)}
                          </>
                        ) : (
                          <span className="font-medium">
                            The reading missed this
                          </span>
                        )}
                      </p>
                    ) : (
                      <div className="flex flex-col gap-1">
                        <label
                          htmlFor={selectId}
                          className="text-[13px] text-muted-foreground"
                        >
                          The reading&apos;s item
                        </label>
                        <NativeSelect
                          id={selectId}
                          className="w-full @lg:max-w-96"
                          value={item.matchedLabelId ?? MISSED}
                          onChange={(event) =>
                            onMatch(item.labelId, event.target.value)
                          }
                        >
                          <NativeSelectOption value={MISSED}>
                            The reading missed this
                          </NativeSelectOption>
                          {options.map((candidate) => {
                            const taken =
                              usedBy.has(candidate.labelId) &&
                              usedBy.get(candidate.labelId) !== item.labelId;
                            return (
                              <NativeSelectOption
                                key={candidate.labelId}
                                value={candidate.labelId}
                                disabled={taken}
                              >
                                {labelTitle(candidate)}
                                {taken ? " (matched to another item)" : ""}
                              </NativeSelectOption>
                            );
                          })}
                        </NativeSelect>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </DetailCard>

      {done ? null : (
        <DetailCard title="Save grades">
          {error ? (
            <p
              role="alert"
              className="border-b px-4 py-2 text-[13px] text-danger-ink"
            >
              {error}
            </p>
          ) : null}
          <DetailCardFooter className="border-t-0 bg-background">
            <span className="text-[13px] font-normal">
              {progress.complete
                ? "Every item has a grade."
                : `${progress.total - progress.graded} still ${progress.total - progress.graded === 1 ? "needs" : "need"} a grade.`}
            </span>
            <Button
              type="button"
              className="font-semibold"
              disabled={!progress.complete || saving}
              onClick={() => void save()}
            >
              {saving ? <Spinner data-icon="inline-start" /> : null}
              Save grades
            </Button>
          </DetailCardFooter>
        </DetailCard>
      )}
      {done && error ? (
        <p role="alert" className="px-1 text-[13px] text-danger-ink">
          {error}
        </p>
      ) : null}

      {confirm ? (
        <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      ) : null}
    </div>
  );
}
