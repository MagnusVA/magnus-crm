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
  { label: "Team", href: "/workspace/team", icon: UsersIcon, shortcut: "2" },
  { label: "Pipeline", href: "/workspace/pipeline", icon: KanbanIcon, shortcut: "3" },
  { label: "Settings", href: "/workspace/settings", icon: SettingsIcon, shortcut: "4" },
  { label: "Opportunities", href: "/workspace/opportunities", icon: TargetIcon },
];

const closerPages = [
  { label: "Dashboard", href: "/workspace/closer", icon: LayoutDashboardIcon, shortcut: "1" },
  { label: "My Pipeline", href: "/workspace/closer/pipeline", icon: KanbanIcon, shortcut: "2" },
  { label: "My Schedule", href: "/workspace/closer", icon: CalendarIcon, shortcut: "3" },
  { label: "Opportunities", href: "/workspace/opportunities", icon: TargetIcon },
];

export function CommandPalette() {
  const router = useRouter();
  const { isAdmin } = useRole();
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

  const pages = isAdmin ? adminPages : closerPages;

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
        <>
          <CommandSeparator />
          <CommandGroup heading="Quick Actions">
            {isAdmin ? (
              <CommandItem onSelect={() => navigate("/workspace/team")}>
                <UsersIcon />
                <span>Invite team member</span>
              </CommandItem>
            ) : null}
            <CommandItem onSelect={() => navigate("/workspace/opportunities/new")}>
              <PlusIcon />
              <span>Create opportunity</span>
            </CommandItem>
          </CommandGroup>
        </>
      </CommandList>
    </CommandDialog>
  );
}
