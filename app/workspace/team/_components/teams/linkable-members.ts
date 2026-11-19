/**
 * Whether a CRM user can be picked as a DM closer's linked user: an active
 * login, not deactivated or removed (the server checks the same).
 */
export function isLinkableMember(member: { isActive: boolean; deletedAt?: number }) {
  return member.isActive && member.deletedAt === undefined;
}
