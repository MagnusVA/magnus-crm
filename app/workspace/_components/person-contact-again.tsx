"use client";

import dynamic from "next/dynamic";
import type { Doc } from "@/convex/_generated/dataModel";
import { contactAgainForbidden, visibleContactAgain } from "@/convex/lib/contactAgain";
import { useRole } from "@/components/auth/role-context";

const ContactAgainDialog = dynamic(() => import("../lead-gen/_components/contact-again-dialog").then(module => module.ContactAgainDialog));

/** The person cards already enforce view access; the setter also checks admin access. */
export function PersonContactAgain({ lead }: { lead: Doc<"leads"> }) {
  const { isAdmin } = useRole();
  if (contactAgainForbidden(lead)) return null;
  const saved = visibleContactAgain(lead);
  if (!saved && !isAdmin) return null;
  return <div className="flex flex-wrap items-start gap-2 px-4 py-2">
    <div className="min-w-0 flex-1 text-sm">
      <p>{saved ? `Contact again on ${saved.date}` : "No contact-again date"}</p>
      {saved ? <p className="whitespace-pre-wrap wrap-break-word text-muted-foreground">{saved.note}</p> : null}
    </div>
    {isAdmin ? <ContactAgainDialog leadId={lead._id} /> : null}
  </div>;
}
