"use client";

import type { Dispatch, SetStateAction } from "react";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { LeadGenFilters } from "./lead-gen-admin-page-client";

type LeadGenTeamOption = {
  _id: Id<"attributionTeams">;
  name: string;
  isActive: boolean;
};

export function LeadGenFilterBar({
  value,
  onChange,
  workers,
  teams,
}: {
  value: LeadGenFilters;
  onChange: Dispatch<SetStateAction<LeadGenFilters>>;
  workers: Doc<"leadGenWorkers">[] | undefined;
  teams: LeadGenTeamOption[] | undefined;
}) {
  return (
    <FieldGroup className="grid grid-cols-[repeat(auto-fit,minmax(8.75rem,1fr))] gap-2 rounded-lg border bg-card p-2">
      <Field className="min-w-0 gap-1">
        <FieldLabel
          className="text-[11px] text-muted-foreground"
          htmlFor="lead-gen-start-date"
        >
          Start
        </FieldLabel>
        <Input
          autoComplete="off"
          className="h-7 rounded-md text-xs md:text-xs"
          id="lead-gen-start-date"
          name="startDayKey"
          type="date"
          value={value.startDayKey}
          onChange={(event) =>
            onChange((current) => ({
              ...current,
              startDayKey: event.target.value,
            }))
          }
        />
      </Field>

      <Field className="min-w-0 gap-1">
        <FieldLabel
          className="text-[11px] text-muted-foreground"
          htmlFor="lead-gen-end-date"
        >
          End
        </FieldLabel>
        <Input
          autoComplete="off"
          className="h-7 rounded-md text-xs md:text-xs"
          id="lead-gen-end-date"
          name="endDayKey"
          type="date"
          value={value.endDayKey}
          onChange={(event) =>
            onChange((current) => ({
              ...current,
              endDayKey: event.target.value,
            }))
          }
        />
      </Field>

      <Field className="min-w-0 gap-1">
        <FieldLabel className="text-[11px] text-muted-foreground">
          Worker
        </FieldLabel>
        <Select
          value={value.workerId ?? "all"}
          onValueChange={(nextValue) =>
            onChange((current) => ({
              ...current,
              workerId:
                nextValue === "all"
                  ? undefined
                  : (nextValue as Id<"leadGenWorkers">),
            }))
          }
        >
          <SelectTrigger className="h-7 w-full rounded-md text-xs" size="sm">
            <SelectValue placeholder="All workers" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="all">All Workers</SelectItem>
              {(workers ?? []).map((worker) => (
                <SelectItem key={worker._id} value={worker._id}>
                  {worker.displayName ?? worker.email}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>

      <Field className="min-w-0 gap-1">
        <FieldLabel className="text-[11px] text-muted-foreground">
          Team
        </FieldLabel>
        <Select
          value={value.teamId ?? "all"}
          onValueChange={(nextValue) =>
            onChange((current) => ({
              ...current,
              teamId:
                nextValue === "all"
                  ? undefined
                  : (nextValue as Id<"attributionTeams">),
            }))
          }
        >
          <SelectTrigger className="h-7 w-full rounded-md text-xs" size="sm">
            <SelectValue placeholder="All teams" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="all">All Teams</SelectItem>
              {(teams ?? []).map((team) => (
                <SelectItem key={team._id} value={team._id}>
                  {team.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>

      <Field className="min-w-0 gap-1">
        <FieldLabel className="text-[11px] text-muted-foreground">
          Source
        </FieldLabel>
        <Select
          value={value.source ?? "all"}
          onValueChange={(nextValue) =>
            onChange((current) => ({
              ...current,
              source:
                nextValue === "all"
                  ? undefined
                  : (nextValue as LeadGenFilters["source"]),
            }))
          }
        >
          <SelectTrigger className="h-7 w-full rounded-md text-xs" size="sm">
            <SelectValue placeholder="All sources" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="all">All Sources</SelectItem>
              <SelectItem value="instagram">Instagram</SelectItem>
              <SelectItem value="meta_business">Meta Business</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
    </FieldGroup>
  );
}
