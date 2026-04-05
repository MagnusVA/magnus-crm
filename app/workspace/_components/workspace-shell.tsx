"use client";

import { type ReactNode } from "react";
import dynamic from "next/dynamic";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import type { CrmRole } from "@/convex/lib/roleMapping";
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
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
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
  () =>
    import("@/components/command-palette").then((m) => ({
      default: m.CommandPalette,
    })),
  { ssr: false },
);

// ---------------------------------------------------------------------------
// Hoisted static nav definitions — avoids re-creation on every render
// (vercel-react-best-practices: rendering-hoist-jsx)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// WorkspaceShell
// ---------------------------------------------------------------------------

interface WorkspaceShellProps {
  initialRole: CrmRole;
  initialDisplayName: string;
  initialEmail: string;
  children: ReactNode;
}

export function WorkspaceShell({
  initialRole,
  initialDisplayName,
  initialEmail,
  children,
}: WorkspaceShellProps) {
  const { signOut } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  const isAdmin =
    initialRole === "tenant_master" || initialRole === "tenant_admin";
  const navItems = isAdmin ? adminNavItems : closerNavItems;

  // Navigation shortcuts: Cmd+1 through Cmd+4
  useKeyboardShortcut({
    key: "1",
    modifiers: ["meta"],
    handler: () => router.push(navItems[0]?.href ?? "/workspace"),
  });
  useKeyboardShortcut({
    key: "2",
    modifiers: ["meta"],
    handler: () => router.push(navItems[1]?.href ?? "/workspace"),
  });
  useKeyboardShortcut({
    key: "3",
    modifiers: ["meta"],
    handler: () => router.push(navItems[2]?.href ?? "/workspace"),
  });
  useKeyboardShortcut({
    key: "4",
    modifiers: ["meta"],
    handler: () => router.push(navItems[3]?.href ?? "/workspace"),
  });

  return (
    // Phase 4: RoleProvider will wrap this entire return block.
    // For now, initialRole is used directly for nav/UI decisions.
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
          {/* User info */}
          <div className="flex flex-col gap-1 px-2 py-1.5">
            <p className="truncate text-sm font-medium">
              {initialDisplayName}
            </p>
            <p className="text-xs capitalize text-sidebar-foreground/70">
              {initialRole.replace(/_/g, " ")}
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
