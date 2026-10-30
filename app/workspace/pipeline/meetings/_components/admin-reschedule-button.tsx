"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import type { Id } from "@/convex/_generated/dataModel";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { LinkIcon } from "lucide-react";
import { toast } from "sonner";
import posthog from "posthog-js";
import { reportClientError } from "@/lib/observability/report-client-error";
import { getErrorMessage } from "@/lib/errors";

/**
 * Generates a reschedule link for a deal a no-show closed, on the assigned
 * closer's behalf. The deal reopens at Follow-up with the link pending.
 */
export function AdminRescheduleButton({
  opportunityId,
  meetingId,
  onRescheduleLinkCreated,
}: {
  opportunityId: Id<"opportunities">;
  meetingId: Id<"meetings">;
  onRescheduleLinkCreated: (url: string) => void;
}) {
  const [isLoading, setIsLoading] = useState(false);
  const createRescheduleLink = useMutation(
    api.admin.meetingActions.adminCreateRescheduleLink,
  );

  const handleClick = async () => {
    setIsLoading(true);
    try {
      const result = await createRescheduleLink({
        opportunityId,
        meetingId,
      });
      onRescheduleLinkCreated(result.schedulingLinkUrl);
      posthog.capture("admin_reschedule_link_created", {
        opportunity_id: opportunityId,
        meeting_id: meetingId,
      });
      toast.success("Reschedule link generated");
    } catch (error) {
      reportClientError(error, { flow: "admin_reschedule_link_create" });
      toast.error(
        getErrorMessage(error, "Failed to generate reschedule link"),
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Button size="sm" onClick={handleClick} disabled={isLoading}>
      {isLoading ? (
        <>
          <Spinner data-icon="inline-start" />
          Generating…
        </>
      ) : (
        <>
          <LinkIcon data-icon="inline-start" />
          Send reschedule link
        </>
      )}
    </Button>
  );
}
