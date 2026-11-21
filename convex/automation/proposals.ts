import type { Infer } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type {
  alertProposalValidator,
  automationKindValidator,
  automationModeValidator,
  callEvidenceRefValidator,
  decisionKindValidator,
  decisionProposalValidator,
  paymentEvidenceValidator,
  paymentProposalValidator,
  refusalProposalValidator,
  taskProposalValidator,
} from "./schema";

// Narrowing helpers for the widened decision row (phase 3 contract §1.2).
// The phase 2 payment proposal and evidence carry no `type` tag, so their
// rows still validate; every other member is tagged.

type Decision = Doc<"resultAutomationDecisions">;

export type AutomationKind = Infer<typeof automationKindValidator>;
export type DecisionKind = Infer<typeof decisionKindValidator>;
export type AutomationMode = Infer<typeof automationModeValidator>;
export type PaymentKind = "payment_win" | "additional_payment";
export type CallKind = "call_back" | "payment_owed" | "refusal_loss";

export type DecisionProposal = Infer<typeof decisionProposalValidator>;
export type PaymentProposal = Infer<typeof paymentProposalValidator>;
export type TaskProposal = Infer<typeof taskProposalValidator>;
export type RefusalProposal = Infer<typeof refusalProposalValidator>;
export type AlertProposal = Infer<typeof alertProposalValidator>;
export type PaymentEvidence = Infer<typeof paymentEvidenceValidator>;
export type CallEvidenceRef = Infer<typeof callEvidenceRefValidator>;

export function isPaymentKind(kind: DecisionKind): kind is PaymentKind {
  return kind === "payment_win" || kind === "additional_payment";
}

export function isCallKind(kind: DecisionKind): kind is CallKind {
  return kind === "call_back" || kind === "payment_owed" || kind === "refusal_loss";
}

/** The automation kind a decision belongs to, or null for the alert, which has no level of its own. */
export function automationKindOf(kind: DecisionKind): AutomationKind | null {
  return kind === "paid_on_call_alert" ? null : kind;
}

/** A behaviour that applies at ask or above: a person may confirm. */
export function modeAtLeastAsk(mode: AutomationMode): boolean {
  return mode === "ask" || mode === "automatic";
}

export function isPaymentProposal(proposal: DecisionProposal): proposal is PaymentProposal {
  return !("type" in proposal);
}

/** The payment proposal, or undefined on a row with none or with a call proposal. */
export function paymentProposalOf(decision: Pick<Decision, "proposal">): PaymentProposal | undefined {
  const { proposal } = decision;
  return proposal && isPaymentProposal(proposal) ? proposal : undefined;
}

export function taskProposalOf(decision: Pick<Decision, "proposal">): TaskProposal | undefined {
  const { proposal } = decision;
  return proposal && "type" in proposal && proposal.type === "task" ? proposal : undefined;
}

export function refusalProposalOf(decision: Pick<Decision, "proposal">): RefusalProposal | undefined {
  const { proposal } = decision;
  return proposal && "type" in proposal && proposal.type === "refusal" ? proposal : undefined;
}

export function alertProposalOf(decision: Pick<Decision, "proposal">): AlertProposal | undefined {
  const { proposal } = decision;
  return proposal && "type" in proposal && proposal.type === "alert" ? proposal : undefined;
}

/** The payment evidence, or null on a row whose evidence is a call reading. */
export function paymentEvidenceOf(decision: Pick<Decision, "evidence">): PaymentEvidence | null {
  const { evidence } = decision;
  return "type" in evidence ? null : evidence;
}

export function callEvidenceOf(decision: Pick<Decision, "evidence">): CallEvidenceRef | null {
  const { evidence } = decision;
  return "type" in evidence && evidence.type === "call" ? evidence : null;
}
