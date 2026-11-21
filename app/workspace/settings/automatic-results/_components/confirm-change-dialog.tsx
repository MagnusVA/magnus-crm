"use client";

import { useState, type ReactNode } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  ACTION_DIALOG,
  ActionDialogFooter,
  ActionDialogHeader,
  CancelButton,
  DialogNote,
  SubmitButton,
  SubmitError,
} from "@/app/workspace/_components/action-dialog";
import { getErrorMessage } from "@/lib/errors";

export type ConfirmChange = {
  title: string;
  /** What will change, in one plain line. */
  description: ReactNode;
  /** One more muted line, such as what happens to pending proposals. */
  note?: ReactNode;
  confirmLabel: string;
  pendingLabel: string;
  /** For lowering or pausing: the danger button and a danger header line. */
  danger?: boolean;
  /** Runs the change; a rejection keeps the dialog open with the error. */
  run: () => Promise<void>;
};

/** One confirmation before a switch changes, in the Action Dialogs frame. */
export default function ConfirmChangeDialog({
  request,
  onClose,
}: {
  request: ConfirmChange;
  onClose: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setPending(true);
    setError(null);
    try {
      await request.run();
      onClose();
    } catch (cause) {
      setError(getErrorMessage(cause, "Couldn't save the change."));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent className={ACTION_DIALOG} showCloseButton={!pending}>
        <ActionDialogHeader
          title={request.title}
          description={request.description}
          tone={request.danger ? "danger" : "muted"}
        />
        <SubmitError>{error}</SubmitError>
        {request.note ? <DialogNote>{request.note}</DialogNote> : null}
        <ActionDialogFooter>
          <CancelButton onClick={onClose} disabled={pending} />
          <SubmitButton
            type="button"
            onClick={() => void confirm()}
            pending={pending}
            pendingLabel={request.pendingLabel}
            danger={request.danger}
          >
            {request.confirmLabel}
          </SubmitButton>
        </ActionDialogFooter>
      </DialogContent>
    </Dialog>
  );
}
