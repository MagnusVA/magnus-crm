export type CrmRole = "tenant_master" | "tenant_admin" | "closer";
export type WorkosSlug = "owner" | "tenant-admin" | "closer";

const CRM_TO_WORKOS_ROLE: Record<CrmRole, WorkosSlug> = {
  tenant_master: "owner",
  tenant_admin: "tenant-admin",
  closer: "closer",
};

const WORKOS_TO_CRM_ROLE: Record<string, CrmRole> = {
  owner: "tenant_master",
  "tenant-admin": "tenant_admin",
  closer: "closer",
};

export const ADMIN_ROLES: CrmRole[] = ["tenant_master", "tenant_admin"];

export function mapCrmRoleToWorkosSlug(crmRole: CrmRole): WorkosSlug {
  return CRM_TO_WORKOS_ROLE[crmRole];
}

export function mapWorkosSlugToCrmRole(workosSlug: string): CrmRole {
  return WORKOS_TO_CRM_ROLE[workosSlug] ?? "closer";
}

export function isAdminRole(role: string): boolean {
  return ADMIN_ROLES.includes(role as CrmRole);
}
