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
  ContactIcon,
  ClipboardListIcon,
  DollarSignIcon,
  LayoutDashboardIcon,
  UsersIcon,
  KanbanIcon,
  SettingsIcon,
  CalendarClockIcon,
  PlusIcon,
  RefreshCwIcon,
  TargetIcon,
} from "lucide-react";
import { useRole } from "@/components/auth/role-context";

const RESPARK_HREF = "/workspace/lead-gen/respark";

// Hoisted static page definitions (vercel-react-best-practices: rendering-hoist-jsx)
const adminPages = [
  { label: "Overview", href: "/workspace", icon: LayoutDashboardIcon, shortcut: "1" },
  { label: "Operations", href: "/workspace/operations", icon: KanbanIcon, shortcut: "2" },
  { label: "Leads & Customers", href: "/workspace/leads-customers", icon: ContactIcon, shortcut: "3" },
  { label: "Lead Gen Ops", href: "/workspace/operations/lead-gen", icon: ClipboardListIcon },
  { label: "Lead Gen Settings", href: "/workspace/lead-gen/settings", icon: SettingsIcon },
  { label: "Respark", href: RESPARK_HREF, icon: RefreshCwIcon },
  { label: "Team", href: "/workspace/team", icon: UsersIcon },
  { label: "Settings", href: "/workspace/settings", icon: SettingsIcon },
  {
    label: "Attribution",
    href: "/workspace/operations/booked-calls/attribution",
    icon: TargetIcon,
  },
];

const billingPage = {
  label: "Billing",
  href: "/workspace/billing",
  icon: DollarSignIcon,
  shortcut: "4",
};

// The same pages, names and order as the closer's sidebar.
const closerPages = [
  { label: "Today", href: "/workspace/closer", icon: CalendarClockIcon, shortcut: "1" },
  { label: "My Pipeline", href: "/workspace/closer/pipeline", icon: KanbanIcon, shortcut: "2" },
  { label: "Leads & Customers", href: "/workspace/leads-customers", icon: ContactIcon, shortcut: "3" },
];

const leadGenPages = [
  { label: "Capture", href: "/workspace/lead-gen/capture", icon: TargetIcon, shortcut: "1" },
  { label: "My Activity", href: "/workspace/lead-gen/my-activity", icon: ActivityIcon, shortcut: "2" },
  { label: "Respark", href: RESPARK_HREF, icon: RefreshCwIcon, shortcut: "3" },
];

export function CommandPalette({
  billingOpsEnabled = false,
}: {
  billingOpsEnabled?: boolean;
}) {
  const router = useRouter();
  const { isAdmin, role, hasPermission } = useRole();
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

  const rolePages = isAdmin
    ? billingOpsEnabled
      ? [
          ...adminPages.slice(0, 2),
          billingPage,
          ...adminPages
            .slice(2)
            .map((page) =>
              page.shortcut === "4" ? { ...page, shortcut: undefined } : page,
            ),
        ]
      : adminPages
    : role === "lead_generator"
      ? leadGenPages
      : closerPages;
  const pages = rolePages.filter(
    (page) => page.href !== RESPARK_HREF || hasPermission("lead-gen:respark"),
  );
  const showNewSideDeal = isAdmin || role === "closer";
  const showQuickActions = isAdmin || showNewSideDeal;

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command Palette"
      description="Search pages and actions…"
    >
      <CommandInput placeholder="Search pages, actions…" />
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
              {showNewSideDeal ? (
                <CommandItem
                  onSelect={() => navigate("/workspace/leads-customers/new-opportunity")}
                >
                  <PlusIcon />
                  <span>New side deal</span>
                </CommandItem>
              ) : null}
            </CommandGroup>
          </>
        ) : null}
      </CommandList>
    </CommandDialog>
  );
}
