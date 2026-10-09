"use client";

import { Button } from "@/components/ui/button";
import { LogOutIcon } from "lucide-react";
import { useSignOut } from "@/hooks/use-sign-out";

export function SignOutButton() {
  const handleSignOut = useSignOut();

  return (
    <Button onClick={handleSignOut} variant="outline">
      <LogOutIcon data-icon="inline-start" aria-hidden="true" />
      Sign Out
    </Button>
  );
}
