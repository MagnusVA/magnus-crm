"use client";

import { Check, Copy, Link2 } from "lucide-react";
import { useCallback, useRef, useState } from "react";

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

  const copyUrl = useCallback(async () => {
    await navigator.clipboard.writeText(result.inviteUrl);
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  }, [result.inviteUrl]);

  return (
    <div
      className="rounded-lg border border-primary/25 bg-primary/5 p-5 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2 motion-safe:duration-400"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        <Link2 className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-3">
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
                {new Intl.DateTimeFormat(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }).format(result.expiresAt)}
              </time>
              .
            </p>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <code className="flex-1 overflow-x-auto rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
              {result.inviteUrl}
            </code>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 gap-2"
              aria-label={copied ? "Link copied" : "Copy invite link"}
              onClick={copyUrl}
            >
              {copied ? (
                <>
                  <Check className="size-3.5" aria-hidden="true" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="size-3.5" aria-hidden="true" />
                  Copy Link
                </>
              )}
            </Button>
          </div>
        </div>

        <button
          type="button"
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Dismiss invite banner"
          onClick={onDismiss}
        >
          <span aria-hidden="true" className="text-xs">
            &times;
          </span>
        </button>
      </div>
    </div>
  );
}
