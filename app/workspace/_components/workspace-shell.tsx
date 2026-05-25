/**
 * @deprecated This component has been split into three parts:
 * - WorkspaceShellFrame (static server shell)
 * - WorkspaceAuth (Suspense-wrapped auth resolver)
 * - WorkspaceShellClient (auth-dependent client shell)
 *
 * See app/workspace/layout.tsx for the new composition.
 * This file can be deleted once all imports are updated.
 */

"use client";

import { type ReactNode } from "react";
import dynamic from "next/dynamic";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import type { CrmRole } from "@/convex/lib/roleMapping";
import { RoleProvider, useRole } from "@/components/auth/role-context";
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
  ActivityIcon,
  ClipboardListIcon,
  KanbanIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  SettingsIcon,
  TargetIcon,
  type LucideIcon,
  UserCircleIcon,
  UsersIcon,
} from "lucide-react";
import { WorkspaceBreadcrumbs } from "@/components/workspace-breadcrumbs";
import { CommandPaletteTrigger } from "@/components/command-palette-trigger";
import { NotificationCenter } from "@/components/notification-center";
import { ThemeToggle } from "@/components/theme-toggle";
import { MagnusBrand } from "@/components/magnus-brand";
import { useKeyboardShortcut } from "@/hooks/use-keyboard-shortcut";
import { usePostHogIdentify } from "@/hooks/use-posthog-identify";
import posthog from "posthog-js";

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
  icon: LucideIcon;
  exact?: boolean;
};

const adminNavItems: NavItem[] = [
  { href: "/workspace", label: "Overview", icon: LayoutDashboardIcon, exact: true },
  { href: "/workspace/lead-gen", label: "Lead Gen", icon: ClipboardListIcon },
  { href: "/workspace/team", label: "Team", icon: UsersIcon },
  { href: "/workspace/pipeline", label: "Pipeline", icon: KanbanIcon },
  { href: "/workspace/settings", label: "Settings", icon: SettingsIcon },
];

const closerNavItems: NavItem[] = [
  { href: "/workspace/closer", label: "Dashboard", icon: LayoutDashboardIcon, exact: true },
  { href: "/workspace/closer/pipeline", label: "My Pipeline", icon: KanbanIcon },
];

const leadGeneratorNavItems: NavItem[] = [
  { href: "/workspace/lead-gen/capture", label: "Capture", icon: TargetIcon, exact: true },
  { href: "/workspace/lead-gen/my-activity", label: "My Activity", icon: ActivityIcon },
];

function navForRole(role: CrmRole, isAdmin: boolean) {
  if (isAdmin) return adminNavItems;
  if (role === "lead_generator") return leadGeneratorNavItems;
  return closerNavItems;
}

function homeHrefForRole(role: CrmRole, isAdmin: boolean) {
  if (isAdmin) return "/workspace";
  if (role === "lead_generator") return "/workspace/lead-gen/capture";
  return "/workspace/closer";
}

// ---------------------------------------------------------------------------
// WorkspaceShell
// ---------------------------------------------------------------------------

interface WorkspaceShellProps {
  initialRole: CrmRole;
  initialDisplayName: string;
  initialEmail: string;
  workosUserId: string;
  workosOrgId: string;
  tenantName: string;
  children: ReactNode;
}

export function WorkspaceShell({
  initialRole,
  initialDisplayName,
  initialEmail,
  workosUserId,
  workosOrgId,
  tenantName,
  children,
}: WorkspaceShellProps) {
  return (
    <RoleProvider initialRole={initialRole}>
      <WorkspaceShellInner
        initialDisplayName={initialDisplayName}
        initialEmail={initialEmail}
        initialRole={initialRole}
        workosUserId={workosUserId}
        workosOrgId={workosOrgId}
        tenantName={tenantName}
      >
        {children}
      </WorkspaceShellInner>
    </RoleProvider>
  );
}

// ---------------------------------------------------------------------------
// Inner shell — consumes RoleProvider so nav and UI update reactively
// when the user's CRM role changes mid-session.
// (vercel-composition-patterns: state-lift-state)
// ---------------------------------------------------------------------------

function WorkspaceShellInner({
  initialDisplayName,
  initialEmail,
  initialRole,
  workosUserId,
  workosOrgId,
  tenantName,
  children,
}: {
  initialDisplayName: string;
  initialEmail: string;
  initialRole: CrmRole;
  workosUserId: string;
  workosOrgId: string;
  tenantName: string;
  children: ReactNode;
}) {
  const { isAdmin, role } = useRole();
  const { signOut } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const displayName = initialDisplayName || initialEmail;

  const navItems = navForRole(role, isAdmin);
  const homeHref = homeHrefForRole(role, isAdmin);

  // Identify user in PostHog with full context
  usePostHogIdentify({
    workosUserId,
    email: initialEmail,
    name: initialDisplayName,
    role: initialRole,
    workosOrgId,
    tenantName,
  });

  const handleSignOut = () => {
    posthog.capture("user_signed_out");
    posthog.reset();
    signOut();
  };

  // TODO [Phase 6]: When WorkOS permissions become authoritative, call
  // refreshAuth() (from useAuth) after role-changing flows complete. This
  // updates the client-side session state to match the latest WorkOS
  // membership.
  //
  // Example:
  //   const { refreshAuth } = useAuth();
  //   // Pass refreshAuth to dialogs or call it from an event handler
  //   // after role mutations succeed.
  //
  // This is not needed in Phase 5 because authorization reads fresh CRM
  // role data on every server request, and the RoleProvider subscription
  // handles client-side updates via useQuery(getCurrentUser).

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
    <SidebarProvider>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>
      <Sidebar>
        <SidebarHeader>
          <Link
            href={homeHref}
            aria-label="MAGNUS CRM workspace home"
            className="flex min-h-10 items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-1"
          >
            <MagnusBrand
              label="MAGNUS CRM"
              size="sm"
              textClassName="text-sidebar-foreground group-data-[collapsible=icon]:hidden"
            />
          </Link>
          <Separator className="mx-2" />
          <div className="flex flex-col gap-1 px-2 py-1.5">
            <p className="truncate text-sm font-medium">{displayName}</p>
            <p className="text-xs capitalize text-sidebar-foreground/70">
              {role.replace(/_/g, " ")}
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
                onClick={handleSignOut}
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
            <ThemeToggle />
            <NotificationCenter />
          </div>
        </header>
        <div
          id="main-content"
          className="flex-1 overflow-auto p-6"
          tabIndex={-1}
        >
          {children}
        </div>
      </SidebarInset>
      <CommandPalette />
    </SidebarProvider>
  );
}
