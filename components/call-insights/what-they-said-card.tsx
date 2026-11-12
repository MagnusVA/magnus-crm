"use client";

import { useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  costLabel,
  modelLabel,
  notReadReason,
} from "@/lib/callInsights/display";
import { getErrorMessage } from "@/lib/errors";
import { useRole } from "@/components/auth/role-context";
import { Button } from "@/components/ui/button";
import { DetailCardFooter } from "@/app/workspace/closer/meetings/_components/detail-card";
import {
  HiddenGroup,
  WhatTheySaidNotRead,
  WhatTheySaidPending,
  WhatTheySaidRead,
  type MeetingInsights,
} from "./what-they-said-view";

type Admin = NonNullable<MeetingInsights["admin"]>;

/**
 * What the prospect said on this call, read from the recording. This file
 * holds the query and the admin's actions; `what-they-said-view.tsx` draws
 * the card. Renders nothing until there is something to say for this viewer:
 * the query returns null when the feature is off or the viewer may not see it.
 */
export function WhatTheySaidCard({ meetingId }: { meetingId: Id<"meetings"> }) {
  const { isAuthenticated } = useConvexAuth();
  const data = useQuery(
    api.callInsights.queries.forMeeting,
    isAuthenticated ? { meetingId } : "skip",
  );
  const { isAdmin } = useRole();
  if (!data || data.state === "none") return null;

  const footer = data.admin ? (
    <AdminFooter admin={data.admin} />
  ) : (
    <ReaderFooter />
  );

  if (
    data.state === "queued" ||
    data.state === "reading" ||
    data.state === "waiting"
  )
    return (
      <WhatTheySaidPending
        waiting={data.state === "waiting" && isAdmin}
        footer={data.admin ? footer : null}
      />
    );

  if (data.state === "not_read") {
    if (!isAdmin) return null;
    return (
      <WhatTheySaidNotRead
        reason={notReadReason(data.reason)}
        footer={data.admin ? footer : null}
      />
    );
  }

  return (
    <WhatTheySaidRead
      data={data}
      hidden={
        data.admin && data.admin.rejected.length > 0 ? (
          <HiddenItems admin={data.admin} />
        ) : null
      }
      footer={footer}
    />
  );
}

/** What a closer reads at the foot: who read the call. */
export function ReaderFooter() {
  return (
    <DetailCardFooter className="font-normal">
      <span className="text-[0.8125rem]">Read by Claude, checked by Jev</span>
    </DetailCardFooter>
  );
}

/** The admin's foot of the card: model and cost, and Read again. */
function AdminFooter({ admin }: { admin: Admin }) {
  return (
    <DetailCardFooter className="font-normal">
      <span className="text-[0.8125rem]">
        Read by {modelLabel(admin.model)}, checked by Jev ·{" "}
        <span className="font-condensed text-[0.875rem] font-semibold tabular-nums">
          {costLabel(admin.costUsd)}
        </span>
      </span>
      {admin.canReadAgain ? (
        <ReadAgainButton recordingId={admin.recordingId} />
      ) : null}
    </DetailCardFooter>
  );
}

function ReadAgainButton({
  recordingId,
}: {
  recordingId: Id<"callRecordings">;
}) {
  const readAgain = useMutation(api.callInsights.admin.readAgain);
  const [pending, setPending] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          const runId = await readAgain({ recordingId });
          if (runId) toast.success("Reading the call again.");
          else toast.error("This call can't be read again right now.");
        } catch (error) {
          toast.error(getErrorMessage(error, "Couldn't read the call again."));
        } finally {
          setPending(false);
        }
      }}
    >
      {pending ? "Starting…" : "Read again"}
    </Button>
  );
}

/** Saves an admin's decision on an item Jev's check hid. */
function HiddenItems({ admin }: { admin: Admin }) {
  const reviewItem = useMutation(api.callInsights.admin.reviewItem);
  const [pending, setPending] = useState<string | null>(null);
  const runId = admin.runId;
  const decide = async (itemKey: string, decision: "restore" | "dismiss") => {
    if (!runId) return;
    setPending(`${itemKey}:${decision}`);
    try {
      await reviewItem({ runId, itemKey, decision });
    } catch (error) {
      toast.error(getErrorMessage(error, "Couldn't save the decision."));
    } finally {
      setPending(null);
    }
  };
  return (
    <HiddenGroup
      items={admin.rejected}
      pending={pending}
      onDecide={
        runId ? (key, decision) => void decide(key, decision) : undefined
      }
    />
  );
}
