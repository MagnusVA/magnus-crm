"use client";

import { useState } from "react";
import { CheckIcon, CopyIcon, MailIcon, MessageSquareIcon, PhoneIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/**
 * How to reach the person: the number large enough to read while dialling,
 * Call, Text and Copy beside it, and the email under it. On an open task the
 * way the task asks for (call or text) is lime; once the task is done, none
 * is.
 */
export function ReachCard({
  personName,
  phone,
  email,
  method,
  open,
}: {
  personName: string;
  phone: string | null;
  email: string | null;
  method: "call" | "text";
  /** The task is still pending, so reaching out is the next action. */
  open: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copyLabel = copied ? "Phone number copied" : "Copy phone number";

  const copy = async () => {
    if (!phone) return;
    try {
      await navigator.clipboard.writeText(phone);
      setCopied(true);
      toast.success("Phone number copied");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy the number. Select it and copy it instead.");
    }
  };

  // The way the task asks for is the next action while the task is open.
  const variantFor = (way: "call" | "text") => (open && method === way ? "default" : "outline");

  return (
    <Card className="gap-0 py-0" aria-label={`Reach ${personName}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5 px-4 py-3">
        {phone ? (
          <>
            <p
              className="mr-auto font-condensed text-[1.75rem] leading-none font-semibold tracking-[0.01em] tabular-nums select-all"
              translate="no"
            >
              {phone}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                asChild
                variant={variantFor("call")}
                size="lg"
                className="px-3.5 font-semibold"
              >
                <a href={`tel:${phone}`} aria-label={`Call ${personName}`}>
                  <PhoneIcon data-icon="inline-start" aria-hidden />
                  Call
                </a>
              </Button>
              <Button
                asChild
                variant={variantFor("text")}
                size="lg"
                className="px-3.5 font-semibold"
              >
                <a href={`sms:${phone}`} aria-label={`Text ${personName}`}>
                  <MessageSquareIcon data-icon="inline-start" aria-hidden />
                  Text
                </a>
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon-lg"
                aria-label={copyLabel}
                title={copyLabel}
                onClick={copy}
              >
                {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
              </Button>
            </div>
          </>
        ) : (
          <p className="mr-auto text-muted-foreground">
            No phone number on file. Reach out by email, or add a number on the person&rsquo;s
            page.
          </p>
        )}
      </div>
      {email ? (
        <div className="flex min-h-10 items-center gap-2 border-t px-4 py-2 text-[0.8125rem] text-muted-foreground">
          <MailIcon className="size-3.5 shrink-0" aria-hidden />
          <a
            href={`mailto:${email}`}
            className="min-w-0 truncate rounded-sm font-medium text-foreground underline decoration-foreground/30 underline-offset-[3px] outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
            translate="no"
          >
            {email}
          </a>
        </div>
      ) : null}
    </Card>
  );
}
