"use client";

import { useMemo, useState } from "react";
import { ClipboardIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  formatBillingCopyPayload,
  type BillingCopyDetail,
} from "./billing-copy-format";

export function CopyBillingPayloadButton({
  detail,
}: {
  detail: BillingCopyDetail;
}) {
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const payload = useMemo(() => formatBillingCopyPayload(detail), [detail]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(payload);
      toast.success("Billing payload copied.");
    } catch {
      setFallbackOpen(true);
      toast.error("Clipboard unavailable. Select the payload manually.");
    }
  };

  return (
    <>
      <Button onClick={copy} variant="outline">
        <ClipboardIcon aria-hidden="true" data-icon="inline-start" />
        Copy payload
      </Button>
      <Dialog open={fallbackOpen} onOpenChange={setFallbackOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Copy billing payload</DialogTitle>
            <DialogDescription>
              Select this normalized payment payload for the external billing
              handoff.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            className="min-h-80 font-mono text-xs"
            readOnly
            value={payload}
          />
          <DialogFooter>
            <Button onClick={() => setFallbackOpen(false)} variant="outline">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
