"use client";

import { Check, Copy, Link2, XIcon } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InviteResult = {
  tenantId: string;
  workosOrgId: string;
  inviteUrl: string;
  expiresAt: number;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

export function InviteBanner({
  result,
  onDismiss,
}: {
  result: InviteResult;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copyUrl = async () => {
    await navigator.clipboard.writeText(result.inviteUrl);
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className="rounded-lg border border-primary/25 bg-primary/5 p-5 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2 motion-safe:duration-400"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        <Link2 className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1 flex flex-col gap-3">
          <div>
            <p className="text-sm font-semibold text-foreground">
              Invite Generated
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Tenant{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                {result.tenantId.slice(0, 12)}&hellip;
              </code>{" "}
              is ready. Expires{" "}
              <time dateTime={new Date(result.expiresAt).toISOString()}>
                {dateTimeFormatter.format(result.expiresAt)}
              </time>
              .
            </p>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <code className="flex-1 overflow-x-auto rounded-md border border-border bg-muted/30 px-3 py-2 text-xs font-mono">
              {result.inviteUrl}
            </code>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              aria-label={copied ? "Link copied" : "Copy invite link"}
              onClick={copyUrl}
            >
              {copied ? (
                <>
                  <Check data-icon="inline-start" aria-hidden="true" />
                  Copied
                </>
              ) : (
                <>
                  <Copy data-icon="inline-start" aria-hidden="true" />
                  Copy Link
                </>
              )}
            </Button>
          </div>
        </div>

        <Button size="icon-xs" variant="ghost" aria-label="Dismiss invite banner" onClick={onDismiss}>
          <XIcon aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
