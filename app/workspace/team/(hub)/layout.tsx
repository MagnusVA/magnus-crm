import { Suspense } from "react";
import { requireRole } from "@/lib/auth";
import { TeamBand } from "../_components/team-band";
import { TEAM_ROOT_CLASS } from "../_components/team-layout";
import { TeamSectionSkeleton } from "../_components/team-section-skeleton";

export const unstable_instant = false;

/**
 * The Team hub's sections (Members, Review, Teams, Schedules, Goals) share one
 * band, rendered here so it stays mounted while the tabs change; each page
 * renders only what sits under it. Redistribute sits outside this group.
 */
export default function TeamHubLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={TEAM_ROOT_CLASS}>
      <Suspense
        fallback={
          <>
            <div className="h-[158px] rounded-xl bg-board" aria-hidden />
            <TeamSectionSkeleton />
          </>
        }
      >
        <AdminOnly>
          <TeamBand />
          {children}
        </AdminOnly>
      </Suspense>
    </div>
  );
}

async function AdminOnly({ children }: { children: React.ReactNode }) {
  await requireRole(["tenant_master", "tenant_admin"]);
  return <>{children}</>;
}
