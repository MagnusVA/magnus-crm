"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useRole } from "@/components/auth/role-context";
import { Button } from "@/components/ui/button";
import { AiAssistantAccessRow } from "../ai-assistant-member-access";
import { firstName } from "../team-ui";
import { CardSection, RecordRow, RuledBlock } from "./card-ui";
import { LOGIN_ROLE_LABEL, type DirectoryMember } from "./member-model";

const RoleEditDialog = dynamic(() => import("../role-edit-dialog").then((module) => ({ default: module.RoleEditDialog })));
const RemoveUserDialog = dynamic(() => import("../remove-user-dialog").then((module) => ({ default: module.RemoveUserDialog })));

/**
 * CRM access, for logins only. The old Team page's rules: the owner's login
 * and your own can't change role or be deactivated; a deactivated login has
 * no actions; each action needs its permission.
 */
export function CrmAccessSection({ member }: { member: DirectoryMember }) {
  const login = member.login;
  const { hasPermission } = useRole();
  const currentUser = useQuery(api.users.queries.getCurrentUser, login ? {} : "skip");
  const users = useQuery(api.users.queries.listTeamMembers, login ? {} : "skip");
  const [open, setOpen] = useState<null | "role" | "remove">(null);
  if (!login) return null;

  const first = firstName(member.name);
  const user = users?.find((row) => row._id === login.userId);
  const isSelf = currentUser?._id === login.userId;
  const isOwner = login.role === "tenant_master";
  const active = login.isActive && !login.removed;
  const known = currentUser !== undefined;
  const canEditRole = known && active && !isSelf && !isOwner && hasPermission("team:update-role");
  const canRemove = known && active && !isSelf && !isOwner && hasPermission("team:remove");
  const why = isSelf
    ? "This is your own login, so you can’t change its role or deactivate it here."
    : isOwner
      ? "The owner’s login keeps its role and can’t be deactivated."
      : !active
        ? `${first}’s login is deactivated.`
        : null;
  const name = user ? user.fullName || user.email : member.name;

  return (
    <CardSection title="CRM access" meta={LOGIN_ROLE_LABEL[login.role]}>
      <RuledBlock>
        <RecordRow
          label="Role"
          tip="What they can do in Magnus. Admins run the workspace; phone closers work their meetings; lead generators log captures. A change takes effect on their next session."
          primary={<span className="font-medium">{LOGIN_ROLE_LABEL[login.role]}</span>}
          secondary={why ?? undefined}
          actions={
            canEditRole ? (
              <Button variant="outline" size="sm" onClick={() => setOpen("role")}>
                Change role
              </Button>
            ) : null
          }
        />
        <RecordRow
          label="Sign-in"
          tip="Deactivating removes their access to the workspace. Their meetings, payments and deals stay."
          primary={active ? (login.invitationPending ? "Invited, not signed up yet" : "Can sign in") : "Deactivated"}
          secondary={login.email}
          actions={
            canRemove ? (
              <Button variant="outline" size="sm" className="text-danger-ink" onClick={() => setOpen("remove")}>
                Deactivate login
              </Button>
            ) : null
          }
        />
        <AiAssistantAccessRow
          userId={login.userId}
          name={name}
          firstName={first}
          role={login.role}
          active={active}
          blocked={login.aiAssistantBlocked}
        />
      </RuledBlock>

      {open === "role" ? (
        <RoleEditDialog
          open
          onOpenChange={(next) => !next && setOpen(null)}
          userId={login.userId}
          userName={name}
          userIdentity={user?.avatar}
          currentRole={login.role}
        />
      ) : null}
      {open === "remove" ? (
        <RemoveUserDialog
          open
          onOpenChange={(next) => !next && setOpen(null)}
          userId={login.userId}
          userName={name}
          userIdentity={user?.avatar}
        />
      ) : null}
    </CardSection>
  );
}
