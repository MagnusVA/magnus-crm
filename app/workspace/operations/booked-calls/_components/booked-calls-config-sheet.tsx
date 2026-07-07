"use client";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { AttributionTab } from "@/app/workspace/settings/_components/attribution-tab";

/**
 * Configuration surface for the Booked Calls page: hosts the full DM
 * attribution registry (teams with booking goals, closers with hourly rates,
 * portal access, booking links) that previously lived only under
 * Settings → Attribution. The content stays mounted per Sheet semantics only
 * while open, so the registry queries do not run until the sheet is used.
 */
export function BookedCallsConfigSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full overflow-y-auto data-[side=right]:sm:max-w-3xl"
      >
        <SheetHeader>
          <SheetTitle>Configuration</SheetTitle>
          <SheetDescription>
            DM teams, booking goals per business day, DM closers, hourly
            contract rates, and portal attribution settings. Also available
            under Settings → Attribution.
          </SheetDescription>
        </SheetHeader>
        <div className="min-w-0 flex-1 px-4 pb-6">
          <AttributionTab />
        </div>
      </SheetContent>
    </Sheet>
  );
}
