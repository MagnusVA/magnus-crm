"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import {
  ActivityIcon,
  ClipboardCheckIcon,
  ClipboardListIcon,
  ContactIcon,
  DollarSignIcon,
  LayoutDashboardIcon,
  UsersIcon,
  KanbanIcon,
  SettingsIcon,
  CalendarIcon,
  PlusIcon,
  TargetIcon,
} from "lucide-react";
import { useRole } from "@/components/auth/role-context";

// Hoisted static page definitions (vercel-react-best-practices: rendering-hoist-jsx)
const adminPages = [
  { label: "Overview", href: "/workspace", icon: LayoutDashboardIcon, shortcut: "1" },
  { label: "Operations", href: "/workspace/operations", icon: KanbanIcon, shortcut: "2" },
  { label: "Reviews", href: "/workspace/reviews", icon: ClipboardCheckIcon, shortcut: "3" },
  { label: "Leads", href: "/workspace/leads", icon: ContactIcon, shortcut: "4" },
  { label: "Lead Gen Ops", href: "/workspace/lead-gen", icon: ClipboardListIcon },
  { label: "Lead Gen Settings", href: "/workspace/lead-gen/settings", icon: SettingsIcon },
  { label: "Opportunities", href: "/workspace/opportunities", icon: TargetIcon },
  { label: "Team", href: "/workspace/team", icon: UsersIcon },
  { label: "Settings", href: "/workspace/settings", icon: SettingsIcon },
];

const billingPage = {
  label: "Billing",
  href: "/workspace/billing",
  icon: DollarSignIcon,
  shortcut: "4",
};

const closerPages = [
  { label: "Dashboard", href: "/workspace/closer", icon: LayoutDashboardIcon, shortcut: "1" },
  { label: "My Pipeline", href: "/workspace/closer/pipeline", icon: KanbanIcon, shortcut: "2" },
  { label: "My Schedule", href: "/workspace/closer", icon: CalendarIcon, shortcut: "3" },
  { label: "Opportunities", href: "/workspace/opportunities", icon: TargetIcon },
];

const leadGenPages = [
  { label: "Capture", href: "/workspace/lead-gen/capture", icon: TargetIcon, shortcut: "1" },
  { label: "My Activity", href: "/workspace/lead-gen/my-activity", icon: ActivityIcon, shortcut: "2" },
];

export function CommandPalette({
  billingOpsEnabled = false,
}: {
  billingOpsEnabled?: boolean;
}) {
  const router = useRouter();
  const { isAdmin, role } = useRole();
  const [open, setOpen] = useState(false);

  // Global keyboard shortcut: Cmd+K or Ctrl+K
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const navigate = useCallback(
    (href: string) => {
      router.push(href);
      setOpen(false);
    },
    [router],
  );

  const pages = isAdmin
    ? billingOpsEnabled
      ? [
          ...adminPages.slice(0, 3),
          billingPage,
          ...adminPages
            .slice(3)
            .map((page) =>
              page.shortcut === "4" ? { ...page, shortcut: undefined } : page,
            ),
        ]
      : adminPages
    : role === "lead_generator"
      ? leadGenPages
      : closerPages;
  const showCreateOpportunity = isAdmin || role === "closer";
  const showQuickActions = isAdmin || showCreateOpportunity;

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command Palette"
      description="Search pages and actions..."
    >
      <CommandInput placeholder="Search pages, actions..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Pages">
          {pages.map((page) => (
            <CommandItem
              key={page.label}
              onSelect={() => navigate(page.href)}
            >
              <page.icon />
              <span>{page.label}</span>
              {page.shortcut ? (
                <CommandShortcut>
                  <Kbd className="text-[10px]">⌘{page.shortcut}</Kbd>
                </CommandShortcut>
              ) : null}
            </CommandItem>
          ))}
        </CommandGroup>
        {showQuickActions ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Quick Actions">
              {isAdmin ? (
                <CommandItem onSelect={() => navigate("/workspace/team")}>
                  <UsersIcon />
                  <span>Invite team member</span>
                </CommandItem>
              ) : null}
              {showCreateOpportunity ? (
                <CommandItem
                  onSelect={() => navigate("/workspace/opportunities/new")}
                >
                  <PlusIcon />
                  <span>Create opportunity</span>
                </CommandItem>
              ) : null}
            </CommandGroup>
          </>
        ) : null}
      </CommandList>
    </CommandDialog>
  );
}
