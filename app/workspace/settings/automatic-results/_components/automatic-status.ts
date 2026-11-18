import type { AutomaticStatus, CertificateView, Level } from "./automation-kinds";
import { BREAKER_WORDS } from "./automation-kinds";

const YEAR_MS = 365 * 86_400_000;

type Sample = NonNullable<CertificateView["sample"]>;

/** "Needs a clean sample: 41 of 300." */
export function needsSampleWords(certificate: CertificateView) {
  const correct = certificate.sample && certificate.sample.status !== "lapsed" ? certificate.sample.correct : 0;
  return `Needs a clean sample: ${correct} of ${certificate.target}.`;
}

/** Why a lapsed sample no longer counts. The backend does not say which, so the words follow its figures. */
export function lapsedWords(sample: Sample, now: number) {
  if (sample.oldestCaseAt !== undefined && sample.oldestCaseAt < now - YEAR_MS) {
    return "Cases older than 12 months dropped out of the sample. A new sample is needed.";
  }
  if (sample.members < sample.target) {
    return "The sample closed before it filled, because the level or the rule changed. A new one starts with the next case.";
  }
  return "The rule changed since the sample was graded.";
}

/**
 * Why the Automatic segment can't be chosen for a kind, in words, or
 * undefined when it can. The owner check comes first: an admin never earns it.
 */
export function automaticLockReason({
  mode,
  status,
  certificate,
  canRaise,
  now,
}: {
  mode: Level;
  status: AutomaticStatus;
  certificate: CertificateView | undefined;
  canRaise: boolean;
  now: number;
}): string | undefined {
  if (mode === "automatic" || status.canPromote) return undefined;
  if (!canRaise) return "Only the owner can switch this on.";
  if (!certificate) return "Loading the sample…";
  const sample = certificate.sample;
  const tooFew = certificate.notEnoughRecordedCalls ? " Not enough recorded calls to earn this." : "";
  if (!sample) return `${needsSampleWords(certificate)}${tooFew}`;
  switch (sample.status) {
    case "collecting":
      return `${needsSampleWords(certificate)}${tooFew}`;
    case "failed":
      return "A case in the sample was graded wrong. A new sample starts when the rule changes.";
    case "lapsed":
      return lapsedWords(sample, now);
    case "full":
      return sample.wrong + sample.unsureOpen + sample.ungraded > 0 || sample.correct < sample.target
        ? needsSampleWords(certificate)
        : "The sample is full and clean. Certify it first, under Clean samples.";
    case "certified":
      if (status.breaker) return `Went back to one tap: ${BREAKER_WORDS[status.breaker.reason]}.`;
      return "Waiting on a check past its deadline or an unanswered “This isn't my sale”. Clear those first.";
  }
}

/** What a kind set to Automatic is doing instead, when it isn't writing by itself. */
export function automaticHeldWords(status: AutomaticStatus): string | null {
  if (status.breaker) return `Went back to one tap: ${BREAKER_WORDS[status.breaker.reason]}.`;
  switch (status.automaticBlockedReason) {
    case "whop_stale":
      return "Asks for now: Whop has not been read in the last hour.";
    case "certificate_lapsed":
      return "Asks for now: the rule changed since the sample was graded.";
    case "certificate_required":
      return "Asks for now: there is no current certificate.";
    default:
      return null;
  }
}
