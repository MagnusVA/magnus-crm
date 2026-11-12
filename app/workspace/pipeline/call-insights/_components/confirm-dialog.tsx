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

export type ConfirmRequest = {
  title: string;
  /** One 13px line under the title: what happens. */
  description: ReactNode;
  /** A warning set on the amber surface, such as the AI Gateway limit. */
  warning?: ReactNode;
  /** One more muted line, such as a quality check that hasn't passed. */
  note?: ReactNode;
  confirmLabel: string;
  pendingLabel: string;
  /** For turning something off: the danger button and a danger header line. */
  danger?: boolean;
  /** Runs the change; a rejection keeps the dialog open with the error. */
  run: () => Promise<void>;
};

/**
 * The page's confirm step in the Action Dialogs frame: the title names the
 * change, one line says what happens, and the action comes last.
 */
export default function ConfirmDialog({
  request,
  onClose,
}: {
  request: ConfirmRequest;
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
        {request.warning ? (
          <DialogNote tone="warning">{request.warning}</DialogNote>
        ) : null}
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
