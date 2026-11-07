"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useNow } from "@/hooks/use-now";
import { CARD, CardHead } from "@/app/workspace/team/_components/team-ui";
import { formatDayTime, type InviteResult } from "./admin-ui";

/** The link to send, after a new invite or a new link: one field and Copy link. */
export function InviteLinkCard({ result, onDismiss }: { result: InviteResult; onDismiss: () => void }) {
  const now = useNow();
  const [copied, setCopied] = useState(false);
  const fieldRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result.inviteUrl);
    } catch {
      fieldRef.current?.focus();
      fieldRef.current?.select();
      toast.error("Couldn't copy the link.", { description: "It's selected in the field, so copy it from there." });
      return;
    }
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section
      role="status"
      aria-live="polite"
      aria-label={`Invite link for ${result.companyName}`}
      className={`${CARD} motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-1 motion-safe:duration-200`}
    >
      <CardHead
        title={
          <>
            Invite link for <span translate="no">{result.companyName}</span>
          </>
        }
        meta={
          <>
            expires{" "}
            <time dateTime={new Date(result.expiresAt).toISOString()}>{formatDayTime(result.expiresAt, now)}</time>
          </>
        }
      >
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="-mr-2 text-muted-foreground"
          aria-label="Dismiss the invite link"
          onClick={onDismiss}
        >
          <XIcon aria-hidden="true" />
        </Button>
      </CardHead>
      <div className="flex items-center gap-2 px-4 py-3">
        <Input
          ref={fieldRef}
          readOnly
          value={result.inviteUrl}
          aria-label={`Invite link for ${result.companyName}`}
          onFocus={(event) => event.currentTarget.select()}
          translate="no"
          spellCheck={false}
          className="h-8 min-w-0 flex-1 truncate font-mono text-[12.5px] tracking-[-0.01em]"
        />
        <Button type="button" variant="outline" className="shrink-0" onClick={copy}>
          {copied ? <CheckIcon data-icon="inline-start" aria-hidden="true" /> : <CopyIcon data-icon="inline-start" aria-hidden="true" />}
          {copied ? "Copied" : "Copy link"}
        </Button>
      </div>
    </section>
  );
}
