import {
  leadingWith,
  mainCurrency,
  resolveNextStep,
  type CurrencyAmount,
  type DeskTaskStep,
  type ShownStep,
} from "@/lib/closer-pipeline";

// The person page's reading of its deals (DESIGN.md, "The Board Strip";
// .impeccable/surfaces/app-workspace-leads-customers-leadid-page-tsx.md,
// "Data rules"): each open deal's next step as of now, the strip's one
// NEXT STEP, the deal cards' order and what the person has paid.

export type Outcome = "open" | "won" | "lost";

/** The payload's next step on an open deal; null on a closed one. */
export type PayloadNextStep = {
  callAt: number | null;
  task: DeskTaskStep;
  canSet: boolean;
} | null;

/** The meeting behind a deal's `callAt`, when the page has it. */
export type CallMeeting = {
  status: "scheduled" | "held" | "no_show" | "canceled";
  scheduledAt: number;
  durationMinutes: number;
};

/**
 * An open deal's step as of `now`, in My Pipeline's order: the next call
 * (or the call under way), else the open task, else a call that ended with
 * nothing recorded, else none.
 */
export type OpenDealState =
  | { kind: "step"; step: Exclude<ShownStep, null> }
  | { kind: "not_recorded"; callAt: number }
  | { kind: "none" };

export function openDealState(
  nextStep: Exclude<PayloadNextStep, null>,
  callMeeting: CallMeeting | null,
  now: number,
): OpenDealState {
  const { step, missedCallAt } = resolveNextStep(nextStep, now);
  if (step !== null) return { kind: "step", step };
  if (missedCallAt === null) return { kind: "none" };
  // The page has no meeting for this call (past its meeting cap): the call
  // passed and the deal still points at it, so its result is owed.
  if (callMeeting === null) return { kind: "not_recorded", callAt: missedCallAt };
  if (callMeeting.status !== "scheduled") return { kind: "none" };
  const endsAt = callMeeting.scheduledAt + callMeeting.durationMinutes * 60_000;
  // A call under way is still the step until it ends.
  if (endsAt > now) return { kind: "step", step: { kind: "call", at: missedCallAt } };
  return { kind: "not_recorded", callAt: missedCallAt };
}

/** When a step happens, for ordering: calls and tasks by time, then links by when they went out. */
function stepOrder(step: Exclude<ShownStep, null>): [number, number] {
  if (step.kind === "call") return [0, step.at];
  if (step.kind === "task") return [0, step.dueAt ?? Number.MAX_SAFE_INTEGER];
  return [1, step.sentAt];
}

export type PersonDeal<T> = {
  item: T;
  outcome: Outcome;
  createdAt: number;
  /** Null on a closed deal. */
  state: OpenDealState | null;
  /** The viewer may act on it: their own deal, or any deal for an admin. */
  canAct: boolean;
};

const OUTCOME_ORDER: Record<Outcome, number> = { open: 0, won: 1, lost: 2 };

/**
 * Open deals first, those with no step (or an unrecorded call) at the top,
 * then by when the step happens; then won, then lost. Newest first within.
 */
export function comparePersonDeals<T>(a: PersonDeal<T>, b: PersonDeal<T>): number {
  const byOutcome = OUTCOME_ORDER[a.outcome] - OUTCOME_ORDER[b.outcome];
  if (byOutcome !== 0) return byOutcome;
  if (a.outcome === "open") {
    const [groupA, timeA] = openRank(a.state);
    const [groupB, timeB] = openRank(b.state);
    const byStep = groupA - groupB || timeA - timeB;
    if (byStep !== 0) return byStep;
  }
  return b.createdAt - a.createdAt;
}

/** An open deal's place: no step or an unrecorded call first, then by its step. */
function openRank(state: OpenDealState | null): [number, number] {
  if (state === null || state.kind !== "step") return [0, 0];
  const [group, time] = stepOrder(state.step);
  return [1 + group, time];
}

/** The strip's NEXT STEP across the person's open deals. */
export type StripNextStep<D> =
  | { kind: "not_recorded"; deal: D; callAt: number; others: number }
  | { kind: "none"; deal: D; owed: boolean; others: number }
  | { kind: "step"; deal: D; step: Exclude<ShownStep, null> }
  | { kind: "no_open" };

/**
 * What the viewer owes first, in amber: a call with nothing recorded, then
 * a deal with no next step, among the deals they can act on. Else the
 * soonest step on any open deal. Open deals only another closer can act on,
 * none with a step, read "No next step" without the amber.
 */
export function stripNextStep<D extends PersonDeal<unknown>>(sorted: D[]): StripNextStep<D> {
  const open = sorted.filter((deal) => deal.outcome === "open" && deal.state !== null);
  if (open.length === 0) return { kind: "no_open" };
  const owed = open.filter((deal) => deal.canAct && deal.state?.kind !== "step");
  const unrecorded = owed.find((deal) => deal.state?.kind === "not_recorded");
  if (unrecorded && unrecorded.state?.kind === "not_recorded") {
    return {
      kind: "not_recorded",
      deal: unrecorded,
      callAt: unrecorded.state.callAt,
      others: owed.length - 1,
    };
  }
  if (owed.length > 0) return { kind: "none", deal: owed[0], owed: true, others: owed.length - 1 };
  const withStep = open
    .filter((deal) => deal.state?.kind === "step")
    .sort((a, b) => {
      if (a.state?.kind !== "step" || b.state?.kind !== "step") return 0;
      const [groupA, timeA] = stepOrder(a.state.step);
      const [groupB, timeB] = stepOrder(b.state.step);
      return groupA - groupB || timeA - timeB;
    });
  const soonest = withStep[0];
  if (soonest && soonest.state?.kind === "step") {
    return { kind: "step", deal: soonest, step: soonest.state.step };
  }
  return { kind: "none", deal: open[0], owed: false, others: open.length - 1 };
}

/**
 * What the payments add up to, one sum per currency, the main currency
 * (the most payments) first. Disputed payments don't count. Amounts in
 * different currencies are never added (DESIGN.md, The Separate Currencies Rule).
 */
export function paidByCurrency(
  payments: ReadonlyArray<{ currency: string; amountMinor: number; status: string }>,
): CurrencyAmount[] {
  const byCurrency = new Map<string, CurrencyAmount>();
  for (const payment of payments) {
    if (payment.status === "disputed") continue;
    const code = payment.currency.toUpperCase();
    const entry = byCurrency.get(code) ?? { currency: code, amountMinor: 0, paymentCount: 0 };
    entry.amountMinor += payment.amountMinor;
    entry.paymentCount = (entry.paymentCount ?? 0) + 1;
    byCurrency.set(code, entry);
  }
  const amounts = [...byCurrency.values()];
  const main = mainCurrency(amounts);
  return leadingWith(
    [...amounts].sort((x, y) => (y.paymentCount ?? 0) - (x.paymentCount ?? 0)),
    main,
  );
}

/** The deal's program: the sold one on a won deal, else the booked one. */
export function dealProgramName(opportunity: {
  outcome: Outcome;
  soldProgramName?: string;
  firstBookingProgramName?: string;
}): string | null {
  if (opportunity.outcome === "won") {
    return opportunity.soldProgramName ?? opportunity.firstBookingProgramName ?? null;
  }
  return opportunity.firstBookingProgramName ?? opportunity.soldProgramName ?? null;
}
