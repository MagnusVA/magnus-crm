export const PERMISSIONS = {
  "team:invite": ["tenant_master", "tenant_admin"],
  "team:remove": ["tenant_master", "tenant_admin"],
  "team:update-role": ["tenant_master"],
  "pipeline:view-all": ["tenant_master", "tenant_admin"],
  "pipeline:view-own": ["tenant_master", "tenant_admin", "closer"],
  "settings:manage": ["tenant_master", "tenant_admin"],
  "meeting:view-own": ["tenant_master", "tenant_admin", "closer"],
  "meeting:manage-own": ["closer"],
  "payment:record": ["closer"],
  "payment:view-all": ["tenant_master", "tenant_admin"],
  "payment:view-own": ["tenant_master", "tenant_admin", "closer"],
  "team:assign-event-type": ["tenant_master", "tenant_admin"],
  "team:manage-availability": ["tenant_master", "tenant_admin"],
  "follow-up:create": ["closer"],
  "follow-up:complete": ["closer"],
  "reassignment:execute": ["tenant_master", "tenant_admin"],
  "reassignment:view-all": ["tenant_master", "tenant_admin"],
  "lead:view-all": ["tenant_master", "tenant_admin", "closer"],
  "lead:edit": ["tenant_master", "tenant_admin"],
  "lead:create": ["tenant_master", "tenant_admin"],
  "lead:delete": ["tenant_master"],
  "lead:merge": ["tenant_master", "tenant_admin", "closer"],
  "lead:convert": ["tenant_master", "tenant_admin"],
  "lead:export": ["tenant_master", "tenant_admin"],
} as const;

export type Permission = keyof typeof PERMISSIONS;

export function hasPermission(role: string, permission: Permission): boolean {
  const allowedRoles = PERMISSIONS[permission];
  return (allowedRoles as readonly string[]).includes(role);
}
