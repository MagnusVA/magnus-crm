"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  ACTION_DIALOG,
  ActionDialogFooter,
  ActionDialogHeader,
  CancelButton,
  SubmitButton,
  SubmitError,
  WhatHappens,
} from "@/app/workspace/_components/action-dialog";
import { getErrorMessage } from "@/lib/errors";

/** Confirms a disconnect: what stops, then what stays. */
export function DisconnectWhopDialog({
  connectionId,
  open,
  onOpenChange,
}: {
  connectionId: Id<"tenantPaymentConnections">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const disconnect = useMutation(api.payments.connection.disconnect);
  const [pending, setPending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function confirm() {
    setPending(true);
    setSubmitError(null);
    try {
      await disconnect({ connectionId });
      toast.success("Whop disconnected.");
      onOpenChange(false);
    } catch (error) {
      setSubmitError(getErrorMessage(error, "Could not disconnect Whop."));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!pending) onOpenChange(value);
      }}
    >
      <DialogContent className={ACTION_DIALOG} showCloseButton={!pending}>
        <ActionDialogHeader
          title="Disconnect Whop?"
          description="To connect again you'll need an API key for the same Whop account and a new webhook secret."
        />
        <SubmitError>{submitError}</SubmitError>
        <WhatHappens
          label="What stops"
          steps={[
            "Whop payment events stop reaching Magnus.",
            "The 15-minute and nightly checks stop.",
            "Magnus deletes the saved API key and webhook secret.",
          ]}
        />
        <WhatHappens
          label="What stays"
          steps={["The Whop payments Magnus already read, and their links to people and deals in Billing."]}
        />
        <ActionDialogFooter>
          <CancelButton disabled={pending} onClick={() => onOpenChange(false)} />
          <SubmitButton type="button" danger pending={pending} pendingLabel="Disconnecting…" onClick={() => void confirm()}>
            Disconnect Whop
          </SubmitButton>
        </ActionDialogFooter>
      </DialogContent>
    </Dialog>
  );
}
