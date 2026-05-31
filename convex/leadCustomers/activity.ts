import type { Doc, Id } from "../_generated/dataModel";

export type EntityActivityEvent =
  | {
      kind: "opportunity_status";
      at: number;
      opportunityId: Id<"opportunities">;
      status: Doc<"opportunities">["status"];
    }
  | {
      kind: "meeting";
      at: number;
      meetingId: Id<"meetings">;
      status: Doc<"meetings">["status"];
    }
  | {
      kind: "payment";
      at: number;
      paymentId: Id<"paymentRecords">;
      amountMinor: number;
      currency: string;
    }
  | {
      kind: "customer";
      at: number;
      customerId: Id<"customers">;
      status: Doc<"customers">["status"];
    };

export function buildEntityActivity(input: {
  customer: Doc<"customers"> | null;
  opportunities: Doc<"opportunities">[];
  meetings: Doc<"meetings">[];
  payments: Doc<"paymentRecords">[];
  maxActivity: number;
}) {
  const events: EntityActivityEvent[] = [
    ...input.opportunities.map((opportunity) => ({
      kind: "opportunity_status" as const,
      at:
        opportunity.latestActivityAt ??
        opportunity.paymentReceivedAt ??
        opportunity.latestMeetingAt ??
        opportunity.updatedAt,
      opportunityId: opportunity._id,
      status: opportunity.status,
    })),
    ...input.meetings.map((meeting) => ({
      kind: "meeting" as const,
      at: meeting.scheduledAt,
      meetingId: meeting._id,
      status: meeting.status,
    })),
    ...input.payments.map((payment) => ({
      kind: "payment" as const,
      at: payment.recordedAt,
      paymentId: payment._id,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
    })),
  ];

  if (input.customer) {
    events.push({
      kind: "customer",
      at: input.customer.convertedAt,
      customerId: input.customer._id,
      status: input.customer.status,
    });
  }

  return events.sort((left, right) => right.at - left.at).slice(0, input.maxActivity);
}
