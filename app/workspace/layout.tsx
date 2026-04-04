"use client";

import dynamic from "next/dynamic";
import { useAction, useConvexAuth, useQuery } from "convex/react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { api } from "@/convex/_generated/api";
import { redirect, usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Doc } from "@/convex/_generated/dataModel";
import { toast } from "sonner";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { Button } from "@/components/ui/button";
import {
  KanbanIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  SettingsIcon,
  UserCircleIcon,
  UsersIcon,
} from "lucide-react";
import { WorkspaceBreadcrumbs } from "@/components/workspace-breadcrumbs";
import { CommandPaletteTrigger } from "@/components/command-palette-trigger";
import { NotificationCenter } from "@/components/notification-center";
import { useKeyboardShortcut } from "@/hooks/use-keyboard-shortcut";

// Dynamic import for command palette (vercel-react-best-practices: bundle-dynamic-imports)
const CommandPalette = dynamic(
  () => import("@/components/command-palette").then((m) => ({ default: m.CommandPalette })),
  { ssr: false },
);

// Hoisted static nav definitions — avoids re-creation on every render
// (vercel-react-best-practices: rendering-hoist-jsx)

type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType;
  exact?: boolean;
};

const adminNavItems: NavItem[] = [
  { href: "/workspace", label: "Overview", icon: LayoutDashboardIcon, exact: true },
  { href: "/workspace/team", label: "Team", icon: UsersIcon },
  { href: "/workspace/pipeline", label: "Pipeline", icon: KanbanIcon },
  { href: "/workspace/settings", label: "Settings", icon: SettingsIcon },
];

const closerNavItems: NavItem[] = [
  { href: "/workspace/closer", label: "Dashboard", icon: LayoutDashboardIcon, exact: true },
  { href: "/workspace/closer/pipeline", label: "My Pipeline", icon: KanbanIcon },
];

const adminOnlyPaths = [
  "/workspace",
  "/workspace/team",
  "/workspace/pipeline",
  "/workspace/settings",
] as const;

export default function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = useQuery(api.users.queries.getCurrentUser);
  const claimInvitedAccount = useAction(api.workos.userActions.claimInvitedAccount);
  const { signOut } = useAuth();
  const pathname = usePathname();
  const { isAuthenticated } = useConvexAuth();

  // ---------------------------------------------------------------------------
  // Auto-claim for invited users who just completed sign-up.
  //
  // When an invited user signs up via the WorkOS invitation email, their JWT
  // contains a real workosUserId — but their CRM record still has a placeholder
  // "pending:<email>". getCurrentUser returns null because the lookup by
  // workosUserId doesn't match the placeholder.
  //
  // claimInvitedAccount patches the real workosUserId into the pending CRM
  // record, which causes getCurrentUser to reactively re-resolve.
  // ---------------------------------------------------------------------------
  const [claimedUser, setClaimedUser] = useState<Doc<"users"> | null>(null);
  // Track whether we've attempted the claim (ref avoids re-render + lint issues)
  const claimAttemptedRef = useRef(false);
  // Surface claim-attempt status for the render path via state
  const [claimDone, setClaimDone] = useState(false);

  useEffect(() => {
    // Only attempt claim once, and only when getCurrentUser resolved to null
    if (user !== null || claimAttemptedRef.current) {
      return;
    }

    claimAttemptedRef.current = true;

    void claimInvitedAccount({})
      .then((result) => {
        if (result) {
          setClaimedUser(result);
        }
      })
      .catch((error: unknown) => {
        console.error("[Workspace] claimInvitedAccount failed", error);
      })
      .finally(() => {
        setClaimDone(true);
      });
  }, [user, claimInvitedAccount]);

  // Resolve which user record to render with.
  // Once the claim succeeds, getCurrentUser will reactively pick up the change
  // on the next tick. Until then, use the claimedUser as a bridge.
  const resolvedUser = user ?? claimedUser;

  // Loading state — query still in flight
  if (user === undefined) {
    return <WorkspaceLoadingShell />;
  }

  // getCurrentUser is null but we haven't finished the claim attempt yet
  if (user === null && !claimDone) {
    return <WorkspaceLoadingShell />;
  }

  // Session expired — Convex auth dropped, toast from ConvexClientProvider handles prompt
  if (resolvedUser === null && !isAuthenticated) {
    return null;
  }

  // No CRM user found (and claim attempt returned nothing) — show empty state
  if (resolvedUser === null) {
    return <NotProvisionedScreen onSignOut={() => signOut()} />;
  }

  const isAdmin = resolvedUser.role === "tenant_master" || resolvedUser.role === "tenant_admin";
  const isAdminOnlyPath = adminOnlyPaths.some((path) =>
    path === "/workspace" ? pathname === path : pathname.startsWith(path),
  );

  if (resolvedUser.role === "closer" && isAdminOnlyPath) {
    redirect("/workspace/closer");
  }

  const navItems = isAdmin ? adminNavItems : closerNavItems;

  const router = useRouter();

  // Navigation shortcuts: Cmd+1 through Cmd+N
  useKeyboardShortcut({ key: "1", modifiers: ["meta"], handler: () => router.push(navItems[0]?.href ?? "/workspace") });
  useKeyboardShortcut({ key: "2", modifiers: ["meta"], handler: () => router.push(navItems[1]?.href ?? "/workspace") });
  useKeyboardShortcut({ key: "3", modifiers: ["meta"], handler: () => router.push(navItems[2]?.href ?? "/workspace") });
  useKeyboardShortcut({ key: "4", modifiers: ["meta"], handler: () => router.push(navItems[3]?.href ?? "/workspace") });

  return (
    <SidebarProvider>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>
      <Sidebar>
        <SidebarHeader>
          {/* Brand wordmark — links to role-appropriate home */}
          <Link
            href={isAdmin ? "/workspace" : "/workspace/closer"}
            className="flex items-center gap-2 px-2 py-1.5"
          >
            <span className="text-xs font-semibold uppercase tracking-[0.25em] text-sidebar-foreground/80">
              Magnus
            </span>
          </Link>
          <Separator className="mx-2" />
          {/* Existing user info */}
          <div className="flex flex-col gap-1 px-2 py-1.5">
            <p className="truncate text-sm font-medium">
              {resolvedUser.fullName ?? resolvedUser.email}
            </p>
            <p className="text-xs capitalize text-sidebar-foreground/70">
              {resolvedUser.role.replace(/_/g, " ")}
            </p>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Navigation</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {navItems.map((item) => {
                  const isActive = item.exact
                    ? pathname === item.href
                    : pathname.startsWith(item.href);
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        asChild
                        isActive={isActive}
                        tooltip={item.label}
                      >
                        <Link href={item.href}>
                          <item.icon />
                          <span>{item.label}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip="Profile">
                <Link href="/workspace/profile">
                  <UserCircleIcon />
                  <span>Profile</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => signOut()}
                tooltip="Sign out"
              >
                <LogOutIcon />
                <span>Sign Out</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="flex h-12 items-center gap-2 border-b px-4">
          <SidebarTrigger aria-label="Toggle sidebar" />
          <Separator orientation="vertical" className="h-4" />
          <WorkspaceBreadcrumbs />
          <div className="ml-auto flex items-center gap-2">
            <CommandPaletteTrigger />
            <NotificationCenter />
          </div>
        </header>
        <div id="main-content" className="flex-1 overflow-auto p-6" tabIndex={-1}>
          {children}
        </div>
      </SidebarInset>
      {/* Command palette — lazy loaded, rendered outside the sidebar */}
      <CommandPalette isAdmin={isAdmin} />
    </SidebarProvider>
  );
}

/**
 * Skeleton loading shell that mirrors the real sidebar layout structure
 * to prevent layout shift when the user query resolves.
 * Uses shadcn Skeleton and SidebarMenuSkeleton components.
 */
function WorkspaceLoadingShell() {
  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader>
          <div className="flex flex-col gap-2 px-2 py-1.5">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-20" />
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Navigation</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {["70%", "55%", "85%", "62%"].map((width, i) => (
                  <SidebarMenuItem key={i}>
                    <SidebarMenuSkeleton showIcon width={width} />
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
      <SidebarInset>
        <header className="flex h-12 items-center gap-2 border-b px-4">
          <Skeleton className="size-7 rounded-md" />
        </header>
        <div className="flex-1 p-6">
          <div className="flex flex-col gap-4">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-4 w-96" />
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

/**
 * Shown when the authenticated user has no CRM record
 * (e.g., system admin, or user who hasn't been provisioned yet).
 * Uses the shadcn Empty compound component.
 */
function NotProvisionedScreen({
  onSignOut,
}: {
  onSignOut: () => void;
}) {
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
        <Button onClick={onSignOut} variant="outline">
          <LogOutIcon data-icon="inline-start" aria-hidden="true" />
          Sign Out
        </Button>
      </Empty>
    </div>
  );
}
