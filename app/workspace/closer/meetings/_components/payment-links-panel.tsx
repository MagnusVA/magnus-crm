"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CopyIcon, LinkIcon, InfoIcon } from "lucide-react";
import { toast } from "sonner";

type PaymentLinksPanelProps = {
  paymentLinks: Array<{ provider: string; label: string; url: string }>;
};

/**
 * Payment Links Panel — copyable payment URLs on the meeting detail page.
 *
 * Shows all payment links configured for the event type. Closers copy these
 * links and share them with leads during meetings.
 *
 * Uses sonner `toast.success()` for copy confirmation instead of inline state.
 */
export function PaymentLinksPanel({ paymentLinks }: PaymentLinksPanelProps) {
  const handleCopy = (url: string, label: string) => {
    navigator.clipboard.writeText(url);
    toast.success(`${label} link copied to clipboard`);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Payment Links</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {paymentLinks.map((link, index) => (
          <div
            key={index}
            className="flex items-center justify-between gap-3 rounded-lg border bg-card p-3 transition-colors hover:bg-accent/50"
          >
            <div className="flex min-w-0 flex-1 items-start gap-2.5">
              <LinkIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{link.label}</p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {link.url}
                </p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleCopy(link.url, link.label)}
              aria-label={`Copy ${link.label} link`}
            >
              <CopyIcon data-icon="inline-start" />
              Copy
            </Button>
          </div>
        ))}

        <Alert className="mt-1">
          <InfoIcon />
          <AlertDescription>
            Share these links with the lead during the meeting.
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}
