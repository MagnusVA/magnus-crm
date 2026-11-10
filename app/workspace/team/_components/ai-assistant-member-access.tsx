"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useRole } from "@/components/auth/role-context";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { RecordRow } from "./member-card/card-ui";

const AccessConfirmDialog = dynamic(() => import("@/components/ai-assistants/access-confirm-dialog"));

/**
 * The member card's AI assistant row (docs/plans/closer-assistant.md §7):
 * whether this login's connected agents may use Magnus, and Block or
 * Unblock. Shown for closers, the owner and admins (the roles with tools),
 * and for anyone already blocked. Blocking an admin or the owner is the
 * owner's (docs/plans/admin-assistant.md §4).
 */
export function AiAssistantAccessRow({
  userId,
  name,
  firstName,
  role,
  active,
  blocked,
}: {
  userId: Id<"users">;
  name: string;
  firstName: string;
  role: "tenant_master" | "tenant_admin" | "closer" | "lead_generator";
  active: boolean;
  blocked: boolean;
}) {
  const { hasPermission } = useRole();
  const setBlocked = useMutation(api.mcp.settings.setUserBlocked);
  const [confirm, setConfirm] = useState(false);
  const adminTarget = role === "tenant_master" || role === "tenant_admin";
  if (role !== "closer" && !adminTarget && !blocked) return null;
  const canChange = active && hasPermission("settings:manage");
  const ownerOnly = adminTarget && !hasPermission("mcp:manage-admin-access");
  const roleWord = role === "tenant_master" ? "the owner" : role === "tenant_admin" ? "admins" : "closers";

  return (
    <>
      <RecordRow
        label="AI assistant"
        tip="Whether the AI apps this person connected (Claude, ChatGPT) can use Magnus. Turning access on for a role is in Settings › Integrations."
        primary={
          blocked ? <span className="font-medium text-warning-ink">Blocked</span> : <span className="font-medium">Allowed</span>
        }
        secondary={
          blocked
            ? `${firstName}’s connected agents can’t use Magnus.`
            : `Can use Magnus while AI assistants are on for ${roleWord}.`
        }
        actions={
          canChange ? (
            ownerOnly ? (
              // A disabled button gets no pointer events, so a span carries the tooltip.
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0} className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <Button variant="outline" size="sm" disabled>
                      {blocked ? "Unblock" : "Block"}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>Only the owner can block an admin</TooltipContent>
              </Tooltip>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setConfirm(true)}>
                {blocked ? "Unblock" : "Block"}
              </Button>
            )
          ) : null
        }
      />
      {confirm ? (
        <AccessConfirmDialog
          title={`${blocked ? "Unblock" : "Block"} ${name}’s AI assistant access?`}
          description={
            blocked
              ? `${firstName}’s connected agents can use Magnus again when access is on for their role.`
              : `${firstName}’s connected agents stop working on their next call.`
          }
          action={blocked ? "Unblock" : "Block"}
          onClose={() => setConfirm(false)}
          onConfirm={() => setBlocked({ userId, blocked: !blocked })}
        />
      ) : null}
    </>
  );
}
