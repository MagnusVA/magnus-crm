"use client";

import { createContext, use, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { CrmRole } from "@/convex/lib/roleMapping";
import type { Permission } from "@/convex/lib/permissions";
import { hasPermission } from "@/convex/lib/permissions";

type RoleContextValue = {
  role: CrmRole;
  isAdmin: boolean;
  hasPermission: (permission: Permission) => boolean;
};

const RoleContext = createContext<RoleContextValue | null>(null);

export function RoleProvider({
  initialRole,
  children,
}: {
  initialRole: CrmRole;
  children: ReactNode;
}) {
  const currentUser = useQuery(api.users.queries.getCurrentUser);
  const role = currentUser?.role ?? initialRole;

  const isAdmin = role === "tenant_master" || role === "tenant_admin";

  return (
    <RoleContext
      value={{
        role,
        isAdmin,
        hasPermission: (permission) => hasPermission(role, permission),
      }}
    >
      {children}
    </RoleContext>
  );
}

export function useRole() {
  const ctx = use(RoleContext);
  if (!ctx) throw new Error("useRole must be used within RoleProvider");
  return ctx;
}
