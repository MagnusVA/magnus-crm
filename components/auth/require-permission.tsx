"use client";

import type { ReactNode } from "react";
import type { Permission } from "@/convex/lib/permissions";
import { useRole } from "./role-context";

export function RequirePermission({
  permission,
  children,
  fallback = null,
}: {
  permission: Permission;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { hasPermission } = useRole();
  return hasPermission(permission) ? children : fallback;
}

export function AdminOnly({
  children,
  fallback = null,
}: {
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { isAdmin } = useRole();
  return isAdmin ? children : fallback;
}
