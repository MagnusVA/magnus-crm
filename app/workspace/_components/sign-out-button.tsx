"use client";

import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { Button } from "@/components/ui/button";
import { LogOutIcon } from "lucide-react";
import posthog from "posthog-js";

export function SignOutButton() {
  const { signOut } = useAuth();

  const handleSignOut = () => {
    posthog.capture("user_signed_out");
    posthog.reset();
    signOut();
  };

  return (
    <Button onClick={handleSignOut} variant="outline">
      <LogOutIcon data-icon="inline-start" aria-hidden="true" />
      Sign Out
    </Button>
  );
}
