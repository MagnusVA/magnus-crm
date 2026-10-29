"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { CheckIcon, CopyIcon, SendIcon, XIcon } from "lucide-react";
import { toast } from "sonner";

type RescheduleLinkDisplayProps = {
  url: string;
  /** The person's first name, for "Send it to Ana". */
  leadName?: string | null;
  onDismiss: () => void;
};

/**
 * The reschedule link just generated after a no-show. It lives in page state
 * only, so it shows until dismissed or the page reloads; after that the
 * outcome summary says the link is waiting.
 */
export function RescheduleLinkDisplay({
  url,
  leadName,
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
    <section
      aria-labelledby="reschedule-link-heading"
      className="flex flex-col gap-3 rounded-xl border-2 border-primary bg-card px-4 py-3.5"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
        >
          <SendIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2
            id="reschedule-link-heading"
            className="text-lg leading-tight font-semibold"
          >
            Reschedule link ready
          </h2>
          <p className="mt-1 text-muted-foreground">
            Copy it and send it to {leadName ?? "the lead"}. The new booking
            lands on the closer&rsquo;s calendar and links to this deal.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onDismiss}
          aria-label="Dismiss reschedule link"
        >
          <XIcon className="size-4" />
        </Button>
      </div>
      <InputGroup className="sm:ml-11 sm:w-auto">
        <InputGroupInput
          value={url}
          readOnly
          className="font-mono text-xs"
          aria-label="Reschedule link URL"
        />
        <InputGroupAddon align="inline-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCopy}
            aria-label={copied ? "Link copied" : "Copy reschedule link"}
          >
            {copied ? (
              <CheckIcon data-icon="inline-start" className="text-primary-ink" />
            ) : (
              <CopyIcon data-icon="inline-start" />
            )}
            {copied ? "Copied" : "Copy"}
          </Button>
        </InputGroupAddon>
      </InputGroup>
    </section>
  );
}
