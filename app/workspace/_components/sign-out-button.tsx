"use client";

import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { Button } from "@/components/ui/button";
import { LogOutIcon } from "lucide-react";

export function SignOutButton() {
  const { signOut } = useAuth();

  return (
    <Button onClick={() => signOut()} variant="outline">
      <LogOutIcon data-icon="inline-start" aria-hidden="true" />
      Sign Out
    </Button>
  );
}
