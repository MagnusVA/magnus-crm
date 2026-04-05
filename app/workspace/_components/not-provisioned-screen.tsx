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
 * This is a Server Component — the sign-out button is a separate
 * client component to keep the boundary minimal.
 */
export function NotProvisionedScreen() {
  return (
    <div className="flex h-screen items-center justify-center">
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
