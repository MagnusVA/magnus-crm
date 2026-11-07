"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useRole } from "@/components/auth/role-context";
import { Button } from "@/components/ui/button";
import { RecordRow } from "./member-card/card-ui";

const AccessConfirmDialog = dynamic(() => import("@/components/ai-assistants/access-confirm-dialog"));

/**
 * The member card's AI assistant row (docs/plans/closer-assistant.md §7):
 * whether this login's connected agents may use Magnus, and Block or
 * Unblock. Shown for closers, the one role with tools, and for anyone
 * already blocked.
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
  if (role !== "closer" && !blocked) return null;
  const canChange = active && hasPermission("settings:manage");

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
            : `Can use Magnus while AI assistants are on for closers.`
        }
        actions={
          canChange ? (
            <Button variant="outline" size="sm" onClick={() => setConfirm(true)}>
              {blocked ? "Unblock" : "Block"}
            </Button>
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
