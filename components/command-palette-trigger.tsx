"use client";

import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { SearchIcon } from "lucide-react";

/**
 * A button that hints at Cmd+K to open the command palette.
 * Placed in the workspace header.
 * The actual opening is handled by the CommandPalette's keydown listener.
 */
export function CommandPaletteTrigger() {
  return (
    <Button
      variant="outline"
      size="sm"
      className="hidden gap-2 text-muted-foreground sm:flex"
      onClick={() => {
        // Dispatch Cmd+K to trigger the palette
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "k", metaKey: true }),
        );
      }}
    >
      <SearchIcon data-icon="inline-start" />
      <span className="text-xs">Search</span>
      <Kbd className="ml-1">
        <span className="text-[10px]">⌘K</span>
      </Kbd>
    </Button>
  );
}
