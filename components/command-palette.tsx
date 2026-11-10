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
  PlusIcon,
  RefreshCwIcon,
  SettingsIcon,
  UserIcon,
  UsersIcon,
} from "lucide-react";
import { useRole } from "@/components/auth/role-context";
import { WORKSPACE_NAV } from "@/components/page-transitions";
import {
  navForRole,
  reportNavItems,
  type NavItem,
} from "@/app/workspace/_components/workspace-nav";

const RESPARK_HREF = "/workspace/lead-gen/respark";

// Pages an admin reaches here that the sidebar doesn't list on its own line.
const adminExtras: NavItem[] = [
  { label: "Lead gen rules", href: "/workspace/settings?tab=lead-gen", icon: SettingsIcon },
  { label: "Fathom", href: "/workspace/settings/fathom", icon: SettingsIcon },
  { label: "Respark", href: RESPARK_HREF, icon: RefreshCwIcon },
];

const profilePage: NavItem = { label: "Profile", href: "/workspace/profile", icon: UserIcon };

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
      router.push(href, { transitionTypes: WORKSPACE_NAV });
      setOpen(false);
    },
    [router],
  );

  // The sidebar's pages in its order, so ⌘1 to ⌘4 match the shell's shortcuts.
  const nav = navForRole(role, isAdmin, billingOpsEnabled);
  const allowed = (page: NavItem) => page.href !== RESPARK_HREF || hasPermission("lead-gen:respark");
  const pages = [...nav, ...(isAdmin ? adminExtras : []), profilePage].filter(allowed);
  // Operations, Team and Booking setup list their sub-pages under their own name.
  const sections = nav.filter(
    (item): item is NavItem & { children: NavItem[] } => item.children !== undefined,
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
          {pages.map((page) => {
            const position = nav.indexOf(page);
            return (
              <PageItem
                key={page.href}
                page={page}
                shortcut={position >= 0 && position < 4 ? String(position + 1) : undefined}
                // A sub-page at the section's own URL (Team's Members, Booking setup's
                // Coverage) is found by its name here instead of listed twice.
                keywords={page.children?.filter((child) => child.href === page.href).map((child) => child.label)}
                onSelect={navigate}
              />
            );
          })}
        </CommandGroup>
        {sections.map((section) => (
          <CommandGroup key={section.href} heading={section.label}>
            {section.children
              .filter((child) => child.href !== section.href)
              .map((child) => (
                <PageItem key={child.href} page={child} keywords={[section.label]} onSelect={navigate} />
              ))}
          </CommandGroup>
        ))}
        {isAdmin ? (
          <CommandGroup heading="Reports">
            {reportNavItems.map((report) => (
              <PageItem key={report.href} page={report} keywords={["Reports"]} onSelect={navigate} />
            ))}
          </CommandGroup>
        ) : null}
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

function PageItem({
  page,
  shortcut,
  keywords,
  onSelect,
}: {
  page: NavItem;
  shortcut?: string;
  /** Extra words that find it: its section's name. */
  keywords?: string[];
  onSelect: (href: string) => void;
}) {
  return (
    <CommandItem value={page.href} keywords={[page.label, ...(keywords ?? [])]} onSelect={() => onSelect(page.href)}>
      <page.icon />
      <span>{page.label}</span>
      {shortcut ? (
        <CommandShortcut>
          <Kbd className="text-[10px]">⌘{shortcut}</Kbd>
        </CommandShortcut>
      ) : null}
    </CommandItem>
  );
}
