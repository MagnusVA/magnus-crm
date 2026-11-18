"use client";

import { ChevronDownIcon } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { CARD, LABEL } from "@/app/workspace/team/_components/team-ui";
import { cn } from "@/lib/utils";
import { LEVELS, type LevelDefinition } from "./automation-kinds";

/** The four levels in one ruled table, folded by default. */
export function LevelsCard({ levels = LEVELS }: { levels?: readonly LevelDefinition[] }) {
  return (
    <Collapsible className={CARD}>
      <CollapsibleTrigger className="group flex min-h-11 w-full items-center gap-2.5 px-4 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
        <h2 className="text-[15px] font-semibold">The {levels.length} levels</h2>
        <span className="text-[13px] text-muted-foreground">What each level does</span>
        <ChevronDownIcon
          aria-hidden="true"
          className="ml-auto size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="overflow-x-auto border-t border-border">
          <table className="w-full min-w-[34rem] text-left text-[13px] leading-[1.45]">
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className={cn(LABEL, "w-28 px-4 py-2 font-semibold")}>Level</th>
                <th scope="col" className={cn(LABEL, "px-4 py-2 font-semibold")}>What the system does</th>
                <th scope="col" className={cn(LABEL, "px-4 py-2 font-semibold")}>What changes in the CRM</th>
              </tr>
            </thead>
            <tbody>
              {levels.map((level) => (
                <tr key={level.value} className="border-b border-border last:border-b-0">
                  <th scope="row" className="px-4 py-2 align-top font-semibold">
                    {level.label}
                    {level.available ? null : (
                      <span className="block font-normal text-muted-foreground">{level.lockedReason}</span>
                    )}
                  </th>
                  <td className="px-4 py-2 align-top">{level.does}</td>
                  <td className="px-4 py-2 align-top text-muted-foreground">{level.changes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
