"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { cn } from "@/lib/utils";
import { RECORD_HREF } from "./automation-kinds";

/** The person's name, or their email; "Loading…" while it loads; null when there is no person. */
export function usePersonName(leadId: Id<"leads"> | undefined): string | null {
  const person = useQuery(api.leads.queries.getLeadForPicker, leadId ? { leadId } : "skip");
  if (!leadId) return null;
  if (person === undefined) return "Loading…";
  return person?.fullName?.trim() || person?.email || "Someone no longer in the CRM";
}

/** The person's name as text, for a row that names who a result was for. */
export function PersonName({ leadId }: { leadId: Id<"leads"> | undefined }) {
  const name = usePersonName(leadId);
  return <span translate="no">{name ?? "No person"}</span>;
}

/** Links to the records a result touched: the deal, the meeting and the payment. */
export function RecordLinks({
  opportunityId,
  meetingId,
  providerPaymentId,
  paymentRecordId,
  newTab = false,
}: {
  opportunityId?: Id<"opportunities">;
  meetingId?: Id<"meetings">;
  providerPaymentId?: Id<"providerPayments">;
  paymentRecordId?: Id<"paymentRecords">;
  newTab?: boolean;
}) {
  const links = [
    opportunityId ? { href: RECORD_HREF.deal(opportunityId), label: "Deal" } : null,
    meetingId ? { href: RECORD_HREF.meeting(meetingId), label: "Meeting" } : null,
    paymentRecordId
      ? { href: RECORD_HREF.payment(paymentRecordId), label: "Payment" }
      : providerPaymentId
        ? { href: RECORD_HREF.whopPayment(providerPaymentId), label: "Whop payment" }
        : null,
  ].filter((link): link is { href: string; label: string } => link !== null);
  if (!links.length) return null;
  return (
    <span className="inline-flex flex-wrap gap-x-3 gap-y-1">
      {links.map((link) => (
        <Link
          key={link.label}
          href={link.href}
          target={newTab ? "_blank" : undefined}
          rel={newTab ? "noopener noreferrer" : undefined}
          className={cn(detailLinkClass, "inline text-[13px]")}
        >
          {link.label}
          {newTab ? <span className="sr-only"> (opens in a new tab)</span> : null}
        </Link>
      ))}
    </span>
  );
}
