"use client";

import { useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/**
 * Copies the person's Instagram handle, without the @, so the lead generator
 * can paste it into Instagram or Meta Business Suite search with no typos.
 */
export function CopyHandleButton({ handle }: { handle: string | null | undefined }) {
  const [copied, setCopied] = useState(false);
  const clean = handle?.trim().replace(/^@+/, "");
  if (!clean) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(clean);
      setCopied(true);
      toast.success(`Copied ${clean}`);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy. Select the handle and copy it by hand.");
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      onClick={() => void copy()}
      aria-label={`Copy handle ${clean}`}
    >
      {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}
