import { formatCash } from "@/lib/closer-pipeline";

// The person page's timeline in the product's words (CONTEXT.md): each event
// is a fact, then the deal it belongs to, short enough for the 20rem rail:
// "Won TestProgram", "Payment recorded · $2,000", "No-show · TestProgram
// call Oct 10". Raw status transitions are left out.

/** What one timeline entry carries (convex/leadCustomers/timeline.ts). */
export type TimelineEntryFacts = {
  eventType: string;
  label: string;
  actorName: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  detail: string | null;
  opportunityId: string | null;
  amount: { amountMinor: number; currency: string } | null;
  callAt: number | null;
  task: { type: "scheduling_link" | "manual_reminder"; reschedule: boolean; method: "call" | "text" | null } | null;
};

/** "Payment recorded" then " · $2,000" as a condensed figure, then " · TestProgram". */
export type TimelineSentence = {
  fact: string;
  figure: string | null;
  subject: string | null;
};

/** Events the page leaves out: the old lead status repeats the lifecycle stage. */
export function isShownOnTimeline(entry: Pick<TimelineEntryFacts, "eventType">): boolean {
  return entry.eventType !== "lead.status_changed";
}

const LIFECYCLE_ORDER = ["prospect", "in conversation", "qualified", "booked", "showed", "customer"];

/** A stored value in words: "not_a_fit" reads "Not a fit". */
function words(value: string | null): string | null {
  if (!value) return null;
  const spaced = value.replaceAll("_", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function sentence(fact: string, subject: string | null = null, figure: string | null = null): TimelineSentence {
  return { fact, figure, subject };
}

/**
 * The entry as one sentence. `programOf` names the deal by its id (the
 * page's deals); `dayOf` writes a business day ("Oct 10").
 */
export function timelineSentence(
  entry: TimelineEntryFacts,
  programOf: (opportunityId: string) => string | null,
  dayOf: (ms: number) => string,
): TimelineSentence {
  const program = entry.opportunityId ? programOf(entry.opportunityId) : null;
  const to = (entry.toStatus ?? "").toLowerCase();
  const call = typeof entry.callAt !== "number" ? null : [program, `call ${dayOf(entry.callAt)}`].filter(Boolean).join(" ");
  const amount = entry.amount ? formatCash(entry.amount.amountMinor, entry.amount.currency) : null;

  switch (entry.eventType) {
    case "opportunity.created":
      return sentence("Deal created", program);
    case "opportunity.stage_changed":
    case "opportunity.status_changed":
    case "opportunity.marked_lost":
      if (to.includes("won")) return sentence(program ? `Won ${program}` : "Deal won");
      if (to.includes("lost") || entry.eventType === "opportunity.marked_lost") {
        return sentence(program ? `Lost ${program}` : "Deal lost");
      }
      return sentence(entry.toStatus ? `Moved to ${entry.toStatus}` : "Deal moved", program);
    case "opportunity.deleted":
      return sentence("Deal deleted", program);
    case "opportunity.stale_flagged":
      return sentence("Deal expired", program);
    case "meeting.created":
    case "invitee.created":
    case "slack_qualified_lead_booked":
      return sentence("Call booked", program);
    case "meeting.no_show":
      return sentence("No-show", call);
    case "meeting.canceled":
    case "invitee.canceled":
      return sentence("Call canceled", call);
    case "meeting.held":
    case "meeting.completed":
      return sentence("Call held", call);
    case "meeting.started":
      return sentence("Call started", program);
    case "meeting.no_show_reverted":
      return sentence("No-show undone", call);
    case "meeting.status_changed":
      if (to === "held" || to === "completed") return sentence("Call held", call);
      if (to.replace(" ", "_") === "no_show") return sentence("No-show", call);
      if (to === "canceled") return sentence("Call canceled", call);
      return sentence(entry.label, call);
    case "followUp.created":
      if (entry.task?.type === "scheduling_link") {
        return sentence(entry.task.reschedule ? "Reschedule link sent" : "Scheduling link sent", program);
      }
      if (entry.task?.type === "manual_reminder") {
        return sentence(entry.task.method === "text" ? "Text-back task set" : "Call-back task set", program);
      }
      return sentence("Task created", program);
    case "followUp.completed":
      return sentence("Task done", program);
    case "followUp.booked":
      return sentence("Booked from the link", program);
    case "followUp.expired":
      return sentence("Task expired", program);
    case "payment.recorded":
    case "payment.verified":
    case "payment.corrected":
    case "payment.disputed":
    case "payment.voided":
      return sentence(entry.label, null, amount);
    case "customer.converted":
      return sentence("Became a customer");
    case "enrollment.created":
      return sentence("Enrolled", entry.detail);
    case "enrollment.status_changed":
      return sentence(entry.toStatus ?? entry.label, entry.detail);
    case "enrollment.removed":
      return sentence("Enrollment removed", entry.detail);
    case "lead.created":
      return sentence("Added to the CRM");
    case "lead.lifecycle_stage_changed": {
      if (to === "customer") return sentence("Became a customer");
      const back =
        LIFECYCLE_ORDER.indexOf((entry.fromStatus ?? "").toLowerCase()) > LIFECYCLE_ORDER.indexOf(to);
      return entry.toStatus
        ? sentence(back ? `Moved back to ${entry.toStatus}` : `Reached the ${entry.toStatus} stage`, back ? entry.actorName : null)
        : sentence(entry.label);
    }
    case "lead.disposition_changed":
      return sentence(entry.toStatus ? `Disposition: ${words(entry.toStatus)}` : entry.label, entry.actorName);
    case "lead.captured":
    case "lead.capture_voided":
    case "lead.resparked":
    case "lead.marked_not_a_fit":
    case "lead.slack_qualified":
    case "lead.portal_link_copied":
    case "lead.portal_note_added":
    case "lead.portal_profile_updated":
      return sentence(entry.label, entry.actorName);
    default:
      return sentence(entry.label, program ?? entry.detail);
  }
}
