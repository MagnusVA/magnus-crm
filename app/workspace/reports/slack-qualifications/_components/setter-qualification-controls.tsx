"use client";

import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { BAND_SELECT } from "../../_components/report-ui";

type SetterOption = {
  slackUserId: string;
  displayName: string;
  isDeleted: boolean;
};

/** The band's filter: one setter, or all of them. */
export function SetterFilter({
  setters,
  value,
  onChange,
}: {
  setters: SetterOption[];
  value: string | null;
  onChange: (slackUserId: string | null) => void;
}) {
  return (
    <Select value={value ?? "all"} onValueChange={(slackUserId) => onChange(slackUserId === "all" ? null : slackUserId)}>
      <SelectTrigger aria-label="Setter" className={cn(BAND_SELECT, "w-[224px] max-w-full")}>
        <SelectValue placeholder="All setters" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value="all">All setters</SelectItem>
          {setters.map((setter) => (
            <SelectItem key={setter.slackUserId} value={setter.slackUserId}>
              {setter.displayName}
              {setter.isDeleted ? " (deactivated)" : ""}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
