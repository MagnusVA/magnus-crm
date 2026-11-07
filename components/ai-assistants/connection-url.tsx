"use client";

import { CopyIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/** The MCP connection URL in mono with a Copy button, as a fact row's value. */
export function ConnectionUrl({ url }: { url: string | null }) {
  if (!url) {
    return <span className="text-[13px] text-muted-foreground">Not configured yet.</span>;
  }
  return (
    <span className="flex min-w-0 items-center gap-2">
      <code translate="no" className="min-w-0 flex-1 rounded-[4px] bg-muted px-1.5 py-0.5 font-mono text-[12.5px] break-all">
        {url}
      </code>
      <Button
        type="button"
        variant="outline"
        size="xs"
        className="shrink-0"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            toast.success("Connection URL copied.");
          } catch {
            toast.error("Couldn't copy the URL. Select it and copy it manually.");
          }
        }}
      >
        <CopyIcon data-icon="inline-start" aria-hidden="true" />
        Copy
      </Button>
    </span>
  );
}
