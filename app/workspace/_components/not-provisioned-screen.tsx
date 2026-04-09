"use client";

import { UserCircleIcon } from "lucide-react";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { SignOutButton } from "./sign-out-button";

/**
 * Shown when the authenticated user has no CRM record
 * (e.g., user who hasn't been provisioned yet).
 * Uses the shadcn Empty compound component.
 *
 * Client component so it can be rendered from the client-side workspace gate.
 */
export function NotProvisionedScreen() {
  return (
    <div className="flex flex-1 h-screen items-center justify-center">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <UserCircleIcon />
          </EmptyMedia>
          <EmptyTitle>Account Not Found</EmptyTitle>
          <EmptyDescription>
            Your account has not been set up yet. Please contact your
            administrator.
          </EmptyDescription>
        </EmptyHeader>
        <SignOutButton />
      </Empty>
    </div>
  );
}
