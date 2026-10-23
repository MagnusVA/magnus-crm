"use client";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { DEFAULT_BUSINESS_DAY } from "@/lib/businessDay";

export function useBusinessDay() {
  const tenant = useQuery(api.tenants.getCurrentTenant, {});
  return { setting: tenant?.businessDay ?? DEFAULT_BUSINESS_DAY, rebuilding: tenant?.businessDayRebuild?.state === "running", version: tenant?.businessDayVersion ?? 0, loaded: tenant !== undefined };
}
