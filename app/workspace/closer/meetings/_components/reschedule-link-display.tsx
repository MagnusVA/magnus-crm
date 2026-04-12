"use client";

import { useState } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { CopyIcon, CheckIcon, XIcon, SendIcon, ClockIcon } from "lucide-react";
import { toast } from "sonner";

type RescheduleLinkDisplayProps = {
  url: string;
  onDismiss: () => void;
};

export function RescheduleLinkDisplay({
  url,
  onDismiss,
}: RescheduleLinkDisplayProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    toast.success("Link copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Card className="border-blue-200 bg-blue-50 dark:border-blue-800/40 dark:bg-blue-950/20">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <SendIcon className="size-4" />
          Reschedule Link Ready
        </CardTitle>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onDismiss}
          aria-label="Dismiss reschedule link"
        >
          <XIcon className="size-4" />
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Copy this link and send it to the lead. They&rsquo;ll book directly on
          your calendar &mdash; the new meeting will be linked automatically.
        </p>
        <InputGroup>
          <InputGroupInput value={url} readOnly aria-label="Reschedule link URL" />
          <InputGroupAddon align="inline-end">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleCopy}
              aria-label={copied ? "Link copied" : "Copy reschedule link"}
            >
              {copied ? (
                <CheckIcon className="size-4 text-green-600" />
              ) : (
                <CopyIcon className="size-4" />
              )}
            </Button>
          </InputGroupAddon>
        </InputGroup>
      </CardContent>
    </Card>
  );
}

/**
 * Shown when opportunity.status === "reschedule_link_sent" but the closer
 * doesn't have the link URL in local state (navigated away and came back).
 */
type RescheduleLinkSentBannerProps = {
  opportunityId: Id<"opportunities">;
};

export function RescheduleLinkSentBanner({
  opportunityId,
}: RescheduleLinkSentBannerProps) {
  return (
    <Alert className="border-blue-200 bg-blue-50 dark:border-blue-800/40 dark:bg-blue-950/20">
      <ClockIcon className="size-4 text-blue-600 dark:text-blue-400" />
      <AlertDescription className="text-blue-900 dark:text-blue-100">
        A reschedule link was sent for this opportunity. Waiting for the lead to
        book.
      </AlertDescription>
    </Alert>
  );
}
