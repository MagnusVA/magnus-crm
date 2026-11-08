"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { MemberIdentityOption } from "@/app/workspace/_components/member-identity";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { ReportProgramDimensionFilter } from "./report-program-dimension-filter";
import { cn } from "@/lib/utils";
import { BAND_SELECT } from "./report-ui";

const ALL_SENTINEL = "__all__";

export type ReportAttributionFilterValue = {
  bookingProgramId?: Id<"tenantPrograms">;
  attributionTeamId?: Id<"attributionTeams">;
  dmCloserId?: Id<"dmClosers">;
};

export function ReportAttributionFilters({
  value,
  onChange,
}: {
  value: ReportAttributionFilterValue;
  onChange: (value: ReportAttributionFilterValue) => void;
}) {
  const teams = useQuery(api.attribution.teams.listTeams, {});
  const dmClosers = useQuery(api.attribution.dmClosers.listDmClosers, {});
  const isAttributionLoading = teams === undefined || dmClosers === undefined;
  const activeTeams = teams?.filter((team) => team.isActive) ?? [];
  const activeDmClosers =
    dmClosers?.filter((dmCloser) => dmCloser.isActive) ?? [];

  return (
    <div className="contents">
      <ReportProgramDimensionFilter
        dimension="booking_program"
        value={value.bookingProgramId}
        onChange={(bookingProgramId) =>
          onChange({ ...value, bookingProgramId })
        }
      />
      <Select
        value={value.attributionTeamId ?? ALL_SENTINEL}
        onValueChange={(next) =>
          onChange({
            ...value,
            attributionTeamId:
              next === ALL_SENTINEL
                ? undefined
                : (next as Id<"attributionTeams">),
          })
        }
        disabled={isAttributionLoading}
      >
        <SelectTrigger className={cn(BAND_SELECT, "w-[184px] max-w-full")} aria-label="DM team">
          <SelectValue placeholder="DM team" />
          {isAttributionLoading ? <Spinner className="ml-2 size-3 text-board-muted" /> : null}
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>DM team</SelectLabel>
            <SelectItem value={ALL_SENTINEL}>All DM teams</SelectItem>
            {activeTeams.map((team) => (
              <SelectItem key={team._id} value={team._id}>
                {team.displayName}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <Select
        value={value.dmCloserId ?? ALL_SENTINEL}
        onValueChange={(next) =>
          onChange({
            ...value,
            dmCloserId:
              next === ALL_SENTINEL ? undefined : (next as Id<"dmClosers">),
          })
        }
        disabled={isAttributionLoading}
      >
        <SelectTrigger className={cn(BAND_SELECT, "w-[184px] max-w-full")} aria-label="DM closer">
          <SelectValue placeholder="DM closer" />
          {isAttributionLoading ? <Spinner className="ml-2 size-3 text-board-muted" /> : null}
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>DM closer</SelectLabel>
            <SelectItem value={ALL_SENTINEL}>All DM closers</SelectItem>
            {activeDmClosers.map((dmCloser) => (
              <SelectItem key={dmCloser._id} value={dmCloser._id}>
                <MemberIdentityOption identity={dmCloser.identity} />
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}
