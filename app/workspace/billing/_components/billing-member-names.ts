"use client";

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

/**
 * Names of the workspace's people, by user id, for the Billing panels that
 * name a closer. Only owners and admins can read the team, which is who
 * reaches these panels. `undefined` while loading.
 */
export function useMemberNames(enabled = true) {
  const members = useQuery(api.users.queries.listTeamMembers, enabled ? {} : "skip");
  return useMemo(() => {
    if (!members) return undefined;
    return new Map<Id<"users">, string>(
      members.map((member) => [
        member._id,
        member.fullName?.trim() || member.calendlyMemberName?.trim() || member.email,
      ]),
    );
  }, [members]);
}
