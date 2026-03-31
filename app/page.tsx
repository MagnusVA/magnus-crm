"use client";

import { LogOut } from "lucide-react";
import Link from "next/link";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function Home() {
  const { user, signOut } = useAuth();

  return (
    <div className="flex min-h-full flex-1 flex-col items-center bg-muted/40 px-4 py-12">
      <Card className="w-full max-w-md shadow-sm">
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0">
          <div className="space-y-1.5">
            <CardTitle>ptdom CRM</CardTitle>
            <CardDescription>
              Multi-tenant appointment management system.
            </CardDescription>
          </div>
          {user ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0 gap-1.5"
              onClick={() => signOut()}
            >
              <LogOut className="size-3.5" aria-hidden />
              Sign out
            </Button>
          ) : (
            <Button asChild variant="outline" size="sm" className="shrink-0">
              <Link href="/sign-in">Sign in</Link>
            </Button>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {user ? (
            <p className="text-muted-foreground text-sm">Signed in as {user.email}</p>
          ) : (
            <p className="text-muted-foreground text-sm">Please sign in to continue.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
