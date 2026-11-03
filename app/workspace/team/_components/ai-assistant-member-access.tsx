"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { RequirePermission } from "@/components/auth/require-permission";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";

const AccessConfirmDialog = dynamic(
  () => import("@/components/ai-assistants/access-confirm-dialog"),
);
type Member = {
  _id: Id<"users">;
  fullName?: string;
  email: string;
  mcpBlockedAt?: number;
};
export function AiAssistantBlockedBadge({ member }: { member: Member }) {
  return member.mcpBlockedAt !== undefined ? (
    <Badge variant="outline" className="mr-2">
      AI blocked
    </Badge>
  ) : null;
}
export function AiAssistantMemberMenuItem({ member }: { member: Member }) {
  const [confirm, setConfirm] = useState(false);
  const setBlocked = useMutation(api.mcp.settings.setUserBlocked);
  const blocked = member.mcpBlockedAt !== undefined;
  const name = member.fullName ?? member.email;
  return (
    <RequirePermission permission="settings:manage">
      <DropdownMenuItem
        onSelect={(event) => {
          event.preventDefault();
          setConfirm(true);
        }}
      >
        {blocked ? "Unblock AI assistant access" : "Block AI assistant access"}
      </DropdownMenuItem>
      {confirm ? (
        <AccessConfirmDialog
          title={`${blocked ? "Unblock" : "Block"} ${name}'s AI assistant access?`}
          description={
            blocked
              ? "Their connected agents can use Magnus again when access is on for their role."
              : "Their connected agents stop working on their next call."
          }
          action={blocked ? "Unblock" : "Block"}
          onClose={() => setConfirm(false)}
          onConfirm={() =>
            setBlocked({ userId: member._id, blocked: !blocked })
          }
        />
      ) : null}
    </RequirePermission>
  );
}
