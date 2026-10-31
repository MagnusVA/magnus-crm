"use client";

import { useState } from "react";
import { CalendarPlusIcon } from "lucide-react";
import { FollowUpDialog } from "@/app/workspace/closer/meetings/_components/follow-up-dialog";
import { AdminFollowUpDialog } from "@/app/workspace/pipeline/meetings/_components/admin-follow-up-dialog";
import { useRole } from "@/components/auth/role-context";
import { Button } from "@/components/ui/button";
import type { Id } from "@/convex/_generated/dataModel";

/**
 * "Set next step" on an open deal with none: a call-back or a booking link,
 * set from the deal itself rather than a call. A closer sets it on their own
 * deal; an admin sets it for the deal's closer. The server decides whether
 * the deal takes one (`resolveFollowUpStart`); the page shows the button only
 * where the payload's `nextStep.canSet` says so.
 *
 * Lime: it is the deal's one next action (DESIGN.md, The Next Action Rule).
 */
export function SetNextStepButton({
  opportunityId,
  leadName,
  size = "sm",
}: {
  opportunityId: Id<"opportunities">;
  leadName?: string | null;
  size?: "xs" | "sm" | "default";
}) {
  const { isAdmin } = useRole();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button size={size} onClick={() => setOpen(true)}>
        <CalendarPlusIcon data-icon="inline-start" aria-hidden="true" />
        Set next step
      </Button>
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
    </>
  );
}
