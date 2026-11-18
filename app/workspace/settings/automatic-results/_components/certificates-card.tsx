"use client";

import { useId, useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { TranslatableText } from "@/components/translatable-text";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { dayTimeFormat } from "@/components/whop/whop-settings-parts";
import { CARD, CardHead } from "@/app/workspace/team/_components/team-ui";
import { NoteLine, StatusWord, type Tone } from "@/app/workspace/settings/_components/settings-ui";
import { useNow } from "@/hooks/use-now";
import { getErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import {
  AUTOMATION_KINDS,
  ageWords,
  type AutomationSettingsView,
  type CertificateView,
  type KindDefinition,
  type Level,
} from "./automation-kinds";
import { CERTIFY_REFUSAL_WORDS } from "./automation-command-words";
import { INLINE_FIGURE } from "./automation-ui";
import { lapsedWords } from "./automatic-status";

type Sample = NonNullable<CertificateView["sample"]>;

const STATE_WORDS: Record<Sample["status"], { word: string; tone: Tone }> = {
  collecting: { word: "Filling", tone: "muted" },
  full: { word: "Full", tone: "ok" },
  certified: { word: "Certified", tone: "ok" },
  failed: { word: "Failed", tone: "danger" },
  lapsed: { word: "Lapsed", tone: "warning" },
};

/**
 * The clean sample behind each kind: how many cases are clean against the
 * target, what counts against it, and the owner's two steps, opening a sample
 * and certifying a full, clean one. Admins see the same figures; the owner's
 * buttons say why they are off.
 */
export function CertificatesCard({
  view,
  certificates,
}: {
  view: AutomationSettingsView;
  certificates: readonly CertificateView[] | undefined;
}) {
  const id = useId();
  return (
    <section aria-labelledby={`${id}-title`} className={cn(CARD, "@container/certs")}>
      <CardHead
        title={<span id={`${id}-title`}>Clean samples</span>}
        meta="One case per person, graded against the evidence. One wrong or unsure case fails the sample."
      />
      {certificates === undefined ? (
        <p role="status" className="px-4 py-3 text-[13px] text-muted-foreground">Loading the samples…</p>
      ) : (
        <ul>
          {AUTOMATION_KINDS.map((definition) => {
            const certificate = certificates.find((row) => row.kind === definition.kind);
            if (!certificate) return null;
            return (
              <li key={definition.kind} className="border-t border-border first:border-t-0">
                <CertificateBlock
                  definition={definition}
                  certificate={certificate}
                  mode={view.configured?.kinds[definition.kind]?.mode ?? "off"}
                  canRaise={view.canRaise}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function CertificateBlock({
  definition,
  certificate,
  mode,
  canRaise,
}: {
  definition: KindDefinition;
  certificate: CertificateView;
  mode: Level;
  canRaise: boolean;
}) {
  const now = useNow();
  const openSample = useMutation(api.automation.certificates.openSample);
  const certify = useMutation(api.automation.certificates.certify);
  const [pending, setPending] = useState<"open" | "certify" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const sample = certificate.sample;
  const state = sample ? STATE_WORDS[sample.status] : { word: "No sample", tone: "muted" as const };
  const clean = sample !== null && sample.correct === sample.target && sample.wrong === 0 &&
    sample.unsureOpen === 0 && sample.ungraded === 0;
  const canOpenStatus = sample === null || sample.status === "lapsed";
  const showCertify = sample?.status === "full";

  const open = async () => {
    setPending("open");
    setMessage(null);
    try {
      const sampleId = await openSample({ kind: definition.kind });
      if (sampleId === null) {
        setMessage("No sample could open. The kind must be at Shadow or Ask, and a failed sample only reopens after the rule changes.");
      } else {
        toast.success(`A sample is open for ${definition.shortName}. Older eligible cases are being added.`);
      }
    } catch (cause) {
      setMessage(getErrorMessage(cause, "Couldn't open a sample."));
    } finally {
      setPending(null);
    }
  };

  const runCertify = async () => {
    if (!sample) return;
    setPending("certify");
    setMessage(null);
    try {
      const result = await certify({ sampleId: sample.sampleId });
      if (result.ok) toast.success(`${definition.shortName} is certified. The owner can now switch it to Automatic.`);
      else setMessage(CERTIFY_REFUSAL_WORDS[result.code]);
    } catch (cause) {
      setMessage(getErrorMessage(cause, "Couldn't certify the sample."));
    } finally {
      setPending(null);
    }
  };

  const openBlocked = !canRaise
    ? "Only the owner can open a sample."
    : mode === "off"
      ? "Set this kind to Shadow or Ask first."
      : null;
  const certifyBlocked = !canRaise ? "Only the owner can certify a sample." : !clean ? "Every case must be graded correct first." : null;

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-[14px] font-semibold">{definition.shortName}</h3>
        <StatusWord tone={state.tone}>{state.word}</StatusWord>
      </div>
      <dl className="flex flex-wrap gap-x-5 gap-y-1.5 text-[13px]">
        <Figure term="Clean">
          <span className={INLINE_FIGURE}>{sample && sample.status !== "lapsed" ? sample.correct : 0}</span>
          <span className="text-muted-foreground"> of </span>
          <span className={INLINE_FIGURE}>{certificate.target}</span>
        </Figure>
        {sample ? (
          <>
            <Figure term="Wrong" warn={sample.wrong > 0}>
              <span className={INLINE_FIGURE}>{sample.wrong}</span>
            </Figure>
            <Figure term="Open unsure" warn={sample.unsureOpen > 0}>
              <span className={INLINE_FIGURE}>{sample.unsureOpen}</span>
            </Figure>
            <Figure term="Ungraded">
              <span className={INLINE_FIGURE}>{sample.ungraded}</span>
            </Figure>
            <Figure term="Graded after seeing the proposal">
              <span className={INLINE_FIGURE}>{sample.exposed}</span>
            </Figure>
            <Figure term="Cases">
              <span className={INLINE_FIGURE}>{sample.members}</span>
              <span className="text-muted-foreground"> of </span>
              <span className={INLINE_FIGURE}>{sample.target}</span>
            </Figure>
            <Figure term="Oldest case">
              {sample.oldestCaseAt === undefined ? (
                <span className="text-muted-foreground">None yet</span>
              ) : (
                <>
                  <span className={INLINE_FIGURE}>{dayTimeFormat.format(sample.oldestCaseAt)}</span>
                  <span className="text-muted-foreground"> · {ageWords(sample.oldestCaseAt, now)} ago</span>
                </>
              )}
            </Figure>
          </>
        ) : null}
      </dl>

      {certificate.notEnoughRecordedCalls ? (
        <NoteLine tone="warning">
          Not enough recorded calls to earn this. In the last 90 days{" "}
          <span className={INLINE_FIGURE}>{certificate.recentEligiblePeople}</span>{" "}
          {certificate.recentEligiblePeople === 1 ? "person" : "people"} qualified; the sample needs{" "}
          <span className={INLINE_FIGURE}>{certificate.target}</span>, and cases older than 12 months drop out.
        </NoteLine>
      ) : null}
      {sample?.status === "failed" ? (
        <NoteLine tone="danger">A case was graded wrong, so this sample failed. A new sample starts when the rule changes.</NoteLine>
      ) : null}
      {sample?.status === "lapsed" ? <NoteLine tone="warning">{lapsedWords(sample, now)}</NoteLine> : null}
      {sample?.status === "full" && !clean ? (
        <NoteLine>The sample is full. Grade every case, and settle any unsure one, before it can be certified.</NoteLine>
      ) : null}
      {sample?.status === "certified" ? (
        <NoteLine>Certified for the current rule. Switching the kind to Automatic is done in its row above.</NoteLine>
      ) : null}
      {sample === null ? (
        <NoteLine>No sample yet. One opens by itself with the first case the rule would write while the kind is at Shadow or Ask.</NoteLine>
      ) : null}

      {canOpenStatus || showCertify ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {canOpenStatus ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={openBlocked !== null || pending !== null}
              onClick={() => void open()}
            >
              {pending === "open" ? <Spinner data-icon="inline-start" /> : null}
              <TranslatableText>{pending === "open" ? "Opening…" : "Open a sample"}</TranslatableText>
            </Button>
          ) : null}
          {showCertify ? (
            <Button
              type="button"
              size="sm"
              disabled={certifyBlocked !== null || pending !== null}
              onClick={() => void runCertify()}
            >
              {pending === "certify" ? <Spinner data-icon="inline-start" /> : null}
              <TranslatableText>{pending === "certify" ? "Certifying…" : "Certify"}</TranslatableText>
            </Button>
          ) : null}
          {canOpenStatus && openBlocked ? <NoteLine>{openBlocked}</NoteLine> : null}
          {showCertify && certifyBlocked ? <NoteLine>{certifyBlocked}</NoteLine> : null}
          {canOpenStatus && !openBlocked ? (
            <NoteLine>Opening a sample adds this kind&apos;s eligible cases from the last 12 months, one per person.</NoteLine>
          ) : null}
        </div>
      ) : null}
      {message ? <NoteLine tone="danger" role="alert">{message}</NoteLine> : null}
    </div>
  );
}

function Figure({ term, warn, children }: { term: string; warn?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-muted-foreground">{term}</dt>
      <dd className={cn(warn && "text-warning-ink")}>
        {children}
        {warn ? <span className="sr-only"> (counts against the sample)</span> : null}
      </dd>
    </div>
  );
}
