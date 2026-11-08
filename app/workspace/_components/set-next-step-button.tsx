"use client";

import { Suspense, useState } from "react";
import dynamic from "next/dynamic";
import { CalendarPlusIcon } from "lucide-react";
import { useRole } from "@/components/auth/role-context";
import { Button } from "@/components/ui/button";
import type { Id } from "@/convex/_generated/dataModel";

const FollowUpDialog = dynamic(() =>
  import("@/app/workspace/closer/meetings/_components/follow-up-dialog").then((m) => ({
    default: m.FollowUpDialog,
  })),
);
const AdminFollowUpDialog = dynamic(() =>
  import("@/app/workspace/pipeline/meetings/_components/admin-follow-up-dialog").then((m) => ({
    default: m.AdminFollowUpDialog,
  })),
);

/**
 * "Set next step" on an open deal with none: a call-back or a booking link,
 * set from the deal itself rather than a call. A closer sets it on their own
 * deal; an admin sets it for the deal's closer. The server decides whether
 * the deal takes one (`resolveFollowUpStart`); the page shows the button only
 * where the payload's `nextStep.canSet` says so. Pass that as `canSet` rather
 * than unmounting this: a booking link makes `canSet` false while its dialog
 * still shows the link to copy.
 *
 * Lime: it is the deal's one next action (DESIGN.md, The Next Action Rule).
 */
export function SetNextStepButton({
  canSet,
  opportunityId,
  leadName,
  size = "sm",
}: {
  canSet: boolean;
  opportunityId: Id<"opportunities">;
  leadName?: string | null;
  size?: "xs" | "sm" | "default";
}) {
  const { isAdmin } = useRole();
  const [open, setOpen] = useState(false);

  return (
    <>
      {canSet ? (
        <Button size={size} onClick={() => setOpen(true)}>
          <CalendarPlusIcon data-icon="inline-start" aria-hidden="true" />
          Set next step
        </Button>
      ) : null}
      {/* The dialog suspends on its first render; this boundary keeps that
          wait to the dialog. */}
      <Suspense fallback={null}>
        {open ? (
          isAdmin ? (
            <AdminFollowUpDialog
              open
              onOpenChange={setOpen}
              opportunityId={opportunityId}
              leadName={leadName}
            />
          ) : (
            <FollowUpDialog
              open
              onOpenChange={setOpen}
              opportunityId={opportunityId}
              leadName={leadName}
            />
          )
        ) : null}
      </Suspense>
    </>
  );
}
