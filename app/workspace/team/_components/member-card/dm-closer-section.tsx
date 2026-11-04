"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { ArrowUpRightIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Skeleton } from "@/components/ui/skeleton";
import { DmCloserFields } from "../teams/roster-card";
import { firstName, HelpTip } from "../team-ui";
import { CardSection } from "./card-ui";
import type { DirectoryMember } from "./member-model";

/**
 * Each DM closer record: utm_medium, the team its links credit, and Active,
 * edited with the team page's own fields (save as you go, Undo). What their
 * links book stays in Booking setup; the card links there.
 */
export function DmCloserSections({ member }: { member: DirectoryMember }) {
  const has = member.dmClosers.length > 0;
  const closers = useQuery(api.attribution.dmClosers.listDmClosers, has ? {} : "skip");
  const teams = useQuery(api.attribution.teams.listTeams, has ? {} : "skip");
  if (!has) return null;
  const first = firstName(member.name);

  return (
    <>
      {member.dmClosers.map((record) => {
        const closer = closers?.find((row) => row._id === record.dmCloserId);
        const id = `dm-closer-${record.dmCloserId}`;
        return (
          <CardSection
            key={record.dmCloserId}
            id={id}
            title={member.dmClosers.length > 1 ? `DM closer · ${record.utmMedium}` : "DM closer"}
            meta={record.isActive ? "In the link portal" : "Hidden from the link portal"}
            action={
              <Link
                href={`/workspace/booking?team=${record.teamId}&closer=${record.dmCloserId}`}
                className="inline-flex min-h-6 items-center gap-1 rounded-sm text-[13px] font-semibold underline decoration-foreground/40 underline-offset-2 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <HelpTip tip={`Opens Booking setup › Coverage on this team's column, with the portal preview showing ${first}. Which event type each link books is set there.`}>
                  What {first} gets
                </HelpTip>
                <ArrowUpRightIcon aria-hidden="true" className="size-3.5" />
              </Link>
            }
          >
            {closer && teams ? (
              <DmCloserFields
                id={id}
                closer={closer}
                teams={teams}
                teamMembers={[]}
                fields={["utm_medium", "team", "active"]}
                teamLabel="Links credit"
                className="grid grid-cols-1 gap-x-3 gap-y-2.5 @lg/card:grid-cols-3"
              />
            ) : closers !== undefined && !closer ? (
              <p className="text-[13px] text-muted-foreground">This DM closer was removed.</p>
            ) : (
              <div role="status" aria-label="Loading DM closer" className="grid grid-cols-1 gap-3 @lg/card:grid-cols-3">
                <Skeleton className="h-[52px]" />
                <Skeleton className="h-[52px]" />
                <Skeleton className="h-[52px]" />
              </div>
            )}
          </CardSection>
        );
      })}
    </>
  );
}
