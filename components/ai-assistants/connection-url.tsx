"use client";

import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export function ConnectionUrl({ url }: { url: string | null }) {
  if (!url)
    return (
      <p className="text-sm text-muted-foreground">
        The connection URL hasn&apos;t been configured yet.
      </p>
    );
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">Connection URL</span>
      <div className="flex min-w-0 items-center gap-2">
        <code
          className="min-w-0 flex-1 break-all rounded-md border bg-muted px-3 py-2 text-xs"
          translate="no"
        >
          {url}
        </code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(url);
              toast.success("Connection URL copied.");
            } catch {
              toast.error(
                "Couldn't copy the URL. Select it and copy it manually.",
              );
            }
          }}
        >
          Copy
        </Button>
      </div>
    </div>
  );
}
