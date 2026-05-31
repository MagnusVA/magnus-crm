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
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import {
  AlarmClockCheckIcon,
  ActivityIcon,
  BarChart3Icon,
  ClipboardListIcon,
  ClockIcon,
  ContactIcon,
  DollarSignIcon,
  KanbanIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  MessageSquareTextIcon,
  SettingsIcon,
  TargetIcon,
  TrendingUpIcon,
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

const leadsCustomersNavItem: NavItem = {
  href: "/workspace/leads-customers",
  label: "Leads & Customers",
  icon: ContactIcon,
};

const adminNavItems: NavItem[] = [
  { href: "/workspace", label: "Overview", icon: LayoutDashboardIcon, exact: true },
  { href: "/workspace/operations", label: "Operations", icon: KanbanIcon },
  { href: "/workspace/lead-gen", label: "Lead Gen", icon: ClipboardListIcon },
  leadsCustomersNavItem,
  { href: "/workspace/team", label: "Team", icon: UsersIcon },
  { href: "/workspace/settings", label: "Settings", icon: SettingsIcon },
];

const billingNavItem: NavItem = {
  href: "/workspace/billing",
  label: "Billing",
  icon: DollarSignIcon,
};

const closerNavItems: NavItem[] = [
  { href: "/workspace/closer", label: "Dashboard", icon: LayoutDashboardIcon, exact: true },
  { href: "/workspace/closer/pipeline", label: "My Pipeline", icon: KanbanIcon },
  leadsCustomersNavItem,
];

const leadGeneratorNavItems: NavItem[] = [
  { href: "/workspace/lead-gen/capture", label: "Capture", icon: TargetIcon, exact: true },
  { href: "/workspace/lead-gen/my-activity", label: "My Activity", icon: ActivityIcon },
];

const reportNavItems: NavItem[] = [
  { href: "/workspace/reports/team", label: "Team Performance", icon: BarChart3Icon },
  { href: "/workspace/reports/revenue", label: "Revenue", icon: DollarSignIcon },
  { href: "/workspace/reports/pipeline", label: "Pipeline Health", icon: ActivityIcon },
  { href: "/workspace/reports/leads", label: "Leads & Conversions", icon: TrendingUpIcon },
  { href: "/workspace/reports/activity", label: "Activity Feed", icon: ClockIcon },
  { href: "/workspace/reports/reminders", label: "Reminders", icon: AlarmClockCheckIcon },
  {
    href: "/workspace/reports/slack-qualifications",
    label: "Slack Qualifications",
    icon: MessageSquareTextIcon,
  },
];

function navForRole(
  role: CrmRole,
  isAdmin: boolean,
  billingOpsEnabled: boolean,
) {
  if (isAdmin) {
    return billingOpsEnabled
      ? [
          ...adminNavItems.slice(0, 2),
          billingNavItem,
          ...adminNavItems.slice(2),
        ]
      : adminNavItems;
  }
  if (role === "lead_generator") return leadGeneratorNavItems;
  return closerNavItems;
}

function homeHrefForRole(role: CrmRole, isAdmin: boolean) {
  if (isAdmin) return "/workspace";
  if (role === "lead_generator") return "/workspace/lead-gen/capture";
  return "/workspace/closer";
}

// ---------------------------------------------------------------------------
// WorkspaceShellClient
// ---------------------------------------------------------------------------

interface WorkspaceShellClientProps {
  initialRole: CrmRole;
  initialDisplayName: string;
  initialEmail: string;
  workosUserId: string;
  workosOrgId: string;
  tenantName: string;
  billingOpsEnabled: boolean;
  children: ReactNode;
}

/**
 * Auth-dependent client shell that streams in after auth resolves.
 *
 * Renders the full sidebar structure (Sidebar + SidebarInset) inside
 * the SidebarProvider context from WorkspaceShellFrame. This replaces
 * the WorkspaceShellSkeleton when the Suspense boundary resolves.
 *
 * SidebarProvider is intentionally NOT rendered here — it lives in
 * WorkspaceShellFrame above the Suspense boundary so sidebar open/close
 * state is preserved during streaming and Activity transitions.
 *
 * @see vercel-composition-patterns: state-lift-state, architecture-compound-components
 * @see vercel-react-best-practices: rendering-activity (state preservation via Activity)
 * @see next-best-practices: rsc-boundaries (serializable props from server)
 */
export function WorkspaceShellClient({
  initialRole,
  initialDisplayName,
  initialEmail,
  workosUserId,
  workosOrgId,
  tenantName,
  billingOpsEnabled,
  children,
}: WorkspaceShellClientProps) {
  return (
    <RoleProvider initialRole={initialRole}>
      <WorkspaceShellClientInner
        initialDisplayName={initialDisplayName}
        initialEmail={initialEmail}
        initialRole={initialRole}
        workosUserId={workosUserId}
        workosOrgId={workosOrgId}
        tenantName={tenantName}
        billingOpsEnabled={billingOpsEnabled}
      >
        {children}
      </WorkspaceShellClientInner>
    </RoleProvider>
  );
}

// ---------------------------------------------------------------------------
// Inner shell — consumes RoleProvider so nav and UI update reactively
// when the user's CRM role changes mid-session.
// (vercel-composition-patterns: state-lift-state)
// ---------------------------------------------------------------------------

function WorkspaceShellClientInner({
  initialDisplayName,
  initialEmail,
  initialRole,
  workosUserId,
  workosOrgId,
  tenantName,
  billingOpsEnabled,
  children,
}: Omit<WorkspaceShellClientProps, "initialRole"> & { initialRole: CrmRole }) {
  const { isAdmin, role } = useRole();
  const { signOut } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const displayName = initialDisplayName || initialEmail;

  const navItems = navForRole(role, isAdmin, billingOpsEnabled);
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
    <>
      <Sidebar>
        <SidebarHeader>
          <Link
            href={homeHref}
            aria-label="MAGNUS CRM workspace home"
            className="group/brand flex min-h-10 items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-1"
          >
            <MagnusBrand
              label="MAGNUS CRM"
              size="sm"
              textClassName="text-sidebar-foreground group-hover/brand:text-sidebar-accent-foreground group-data-[collapsible=icon]:hidden"
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
          {/* Sidebar nav items */}
          <SidebarGroup>
            <SidebarGroupLabel>Navigation</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {navItems.map((item) => {
                  const isActive = item.exact
                    ? pathname === item.href
                    : pathname.startsWith(item.href);
                  const badgeCount =
                    0;
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
                          {badgeCount > 0 && (
                            <span className="ml-auto inline-flex size-5 items-center justify-center rounded-full bg-destructive text-[10px] font-medium text-destructive-foreground">
                              {badgeCount >= 100 ? "99+" : badgeCount}
                            </span>
                          )}
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          {/* Reports section — admin only (UI visibility; layout.tsx enforces auth) */}
          {isAdmin && (
            <SidebarGroup>
              <SidebarGroupLabel>Reports</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {reportNavItems.map((item) => {
                    const isActive = pathname.startsWith(item.href);
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
          )}
        </SidebarContent>

        {/* Sidebar footer — user info and sign out */}
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

      {/* Command palette — global overlay */}
      <CommandPalette billingOpsEnabled={billingOpsEnabled} />
    </>
  );
}
