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
    <FieldGroup className="grid gap-4 rounded-lg border bg-card p-4 md:grid-cols-2 xl:grid-cols-5">
      <Field>
        <FieldLabel htmlFor="lead-gen-start-date">Start Day</FieldLabel>
        <Input
          autoComplete="off"
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

      <Field>
        <FieldLabel htmlFor="lead-gen-end-date">End Day</FieldLabel>
        <Input
          autoComplete="off"
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

      <Field>
        <FieldLabel>Worker</FieldLabel>
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
          <SelectTrigger>
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

      <Field>
        <FieldLabel>Team</FieldLabel>
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
          <SelectTrigger>
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

      <Field>
        <FieldLabel>Source</FieldLabel>
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
          <SelectTrigger>
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
