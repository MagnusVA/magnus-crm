"use client";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { DEFAULT_BUSINESS_DAY } from "@/lib/businessDay";

export function useBusinessDay(bucketKind: "meetings" | "lead-gen" = "meetings") {
  const tenant = useQuery(api.tenants.getCurrentTenant, {});
  return { setting: tenant?.businessDay ?? DEFAULT_BUSINESS_DAY, rebuilding: tenant != null && !(bucketKind === "lead-gen" ? tenant.leadGenBusinessDayReady : tenant.businessDayReady), version: tenant?.businessDayVersion ?? 0, loaded: tenant !== undefined };
}
