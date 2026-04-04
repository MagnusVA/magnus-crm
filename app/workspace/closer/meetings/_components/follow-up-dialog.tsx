"use client";

import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import {
  CalendarPlusIcon,
  AlertCircleIcon,
  CheckCircleIcon,
  CopyIcon,
} from "lucide-react";
import { toast } from "sonner";

type FollowUpDialogProps = {
  opportunityId: Id<"opportunities">;
  onSuccess?: () => Promise<void>;
};

type DialogState = "idle" | "loading" | "success" | "error";

/**
 * Follow-Up Scheduling Dialog (Phase 7E)
 *
 * Creates a single-use Calendly scheduling link that the closer
 * can share with the lead. The link is:
 * - Single-use (expires after one booking)
 * - Auto-linked to this opportunity via the pipeline processor
 * - Displayed in a copy-friendly input
 *
 * Dialog states:
 * - idle: Show button to generate link
 * - loading: Show spinner while calling backend action
 * - success: Show the link with copy button
 * - error: Show error message with retry button
 *
 * On close, all state resets for a clean re-open.
 */
export function FollowUpDialog({
  opportunityId,
  onSuccess,
}: FollowUpDialogProps) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<DialogState>("idle");
  const [bookingUrl, setBookingUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const createFollowUp = useAction(api.closer.followUp.createFollowUp);

  const handleGenerate = async () => {
    setState("loading");
    setError(null);

    try {
      const result = await createFollowUp({ opportunityId });
      setBookingUrl(result.bookingUrl);
      await onSuccess?.();
      setState("success");
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? err.message
          : "Failed to create scheduling link. Please try again.";
      setError(message);
      setState("error");
      toast.error(message);
    }
  };

  const handleCopy = async () => {
    if (bookingUrl) {
      try {
        await navigator.clipboard.writeText(bookingUrl);
        setCopied(true);
        toast.success("Scheduling link copied to clipboard");
        setTimeout(() => setCopied(false), 2000);
      } catch {
        toast.error("Failed to copy link");
      }
    }
  };

  const handleClose = () => {
    setOpen(false);
    // Reset state on close — small delay lets the dialog close animation finish
    setTimeout(() => {
      setState("idle");
      setBookingUrl(null);
      setError(null);
      setCopied(false);
    }, 200);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="lg">
          <CalendarPlusIcon data-icon="inline-start" />
          Schedule Follow-up
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Schedule Follow-up</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* Idle State: Initial prompt + Generate button */}
          {state === "idle" && (
            <>
              <p className="text-sm text-muted-foreground">
                Generate a single-use Calendly scheduling link to share with the
                lead. When they book, it will automatically link to this
                opportunity.
              </p>
              <Button onClick={handleGenerate} className="w-full" size="lg">
                <CalendarPlusIcon data-icon="inline-start" />
                Generate Scheduling Link
              </Button>
            </>
          )}

          {/* Loading State: Spinner + message */}
          {state === "loading" && (
            <div className="flex flex-col items-center gap-3 py-6">
              <Spinner className="size-6" />
              <p className="text-center text-sm text-muted-foreground">
                Creating scheduling link via Calendly...
              </p>
            </div>
          )}

          {/* Success State: Show link + Copy button + Done */}
          {state === "success" && bookingUrl && (
            <>
              <div className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">
                  Share this link with the lead. It can only be used once.
                </p>
                <InputGroup>
                  <InputGroupInput
                    value={bookingUrl}
                    readOnly
                    className="font-mono text-xs"
                    aria-label="Scheduling link"
                  />
                  <InputGroupAddon align="inline-end">
                    <Button
                      onClick={handleCopy}
                      variant="ghost"
                      size="sm"
                      aria-label={
                        copied
                          ? "Link copied to clipboard"
                          : "Copy scheduling link"
                      }
                    >
                      <CopyIcon data-icon="inline-start" />
                      {copied ? "Copied" : "Copy"}
                    </Button>
                  </InputGroupAddon>
                </InputGroup>
              </div>

              <Alert>
                <CheckCircleIcon />
                <AlertDescription>
                  Scheduling link created successfully
                </AlertDescription>
              </Alert>

              <Button onClick={handleClose} className="w-full">
                Done
              </Button>
            </>
          )}

          {/* Error State: Error message + Retry button */}
          {state === "error" && (
            <>
              <Alert variant="destructive">
                <AlertCircleIcon />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
              <div className="flex flex-col gap-2">
                <Button
                  onClick={handleGenerate}
                  className="w-full"
                  variant="outline"
                >
                  Try Again
                </Button>
                <Button
                  onClick={handleClose}
                  variant="ghost"
                  className="w-full"
                >
                  Cancel
                </Button>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
