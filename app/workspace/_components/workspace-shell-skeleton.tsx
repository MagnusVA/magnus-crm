"use client";

import { Skeleton } from "@/components/ui/skeleton";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuItem,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { MagnusBrand } from "@/components/magnus-brand";

/**
 * Suspense fallback for the workspace shell.
 *
 * Renders the full sidebar + inset structure with skeleton content so the
 * user sees the workspace chrome instantly while auth resolves. With PPR
 * and `cacheComponents: true`, this skeleton IS the static HTML served
 * from CDN — it prerenderers at build time inside the Suspense boundary.
 *
 * Dimensions match the real nav/header/footer to prevent CLS when the
 * auth-dependent WorkspaceShellClient streams in and replaces this.
 *
 * This component consumes SidebarProvider context from WorkspaceShellFrame
 * (the parent above the Suspense boundary), so sidebar open/close state
 * transfers seamlessly when the real content replaces this skeleton.
 *
 * @see vercel-react-best-practices: rendering-hoist-jsx
 */
export function WorkspaceShellSkeleton() {
  return (
    <>
      <Sidebar>
        {/* Matches the real brand block: lime M, "Magnus" in the condensed face */}
        <SidebarHeader className="px-3 pt-4 pb-3">
          <div className="flex min-h-9 items-center gap-2 rounded-md px-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
            <MagnusBrand
              label="Magnus"
              size="xs"
              markVariant="lime"
              markClassName="size-6"
              textClassName="font-condensed text-[22px] font-semibold tracking-[0.01em] text-sidebar-foreground group-data-[collapsible=icon]:hidden"
            />
          </div>
        </SidebarHeader>
        <SidebarContent>
          {/* Sidebar nav skeleton — the real nav group has no label */}
          <SidebarGroup className="pt-0">
            <SidebarGroupContent>
              <SidebarMenu>
                {Array.from({ length: 4 }).map((_, i) => (
                  <SidebarMenuItem key={i}>
                    <Skeleton className="h-8 w-full rounded-md" />
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        {/* Footer skeleton — matches the avatar, name, role and sign-out button */}
        <SidebarFooter className="border-t border-sidebar-border px-3 py-3">
          <div className="flex items-center gap-1">
            <div className="flex min-w-0 flex-1 items-center gap-2.5 px-1 py-1 group-data-[collapsible=icon]:hidden">
              <Skeleton className="size-6 shrink-0 rounded-full" />
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex h-5 items-center">
                  <Skeleton className="h-3.5 w-24 rounded" />
                </div>
                <div className="flex h-4 items-center">
                  <Skeleton className="h-3 w-16 rounded" />
                </div>
              </div>
            </div>
            <Skeleton className="size-8 shrink-0 rounded-md" />
          </div>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="flex h-13 shrink-0 items-center gap-2 border-b bg-card px-4">
          <SidebarTrigger aria-label="Toggle sidebar" />
          <Separator orientation="vertical" className="h-4" />
          {/* Matches the real bar: breadcrumbs, the search field, the theme toggle */}
          <Skeleton className="h-4 w-32 rounded" />
          <div className="ml-auto flex items-center gap-2">
            <Skeleton className="hidden h-8 w-64 rounded-md sm:block" />
            <Skeleton className="size-9 rounded-md" />
          </div>
        </header>
        <div
          id="main-content"
          className="page-inset flex-1 overflow-auto"
          tabIndex={-1}
        >
          {/* Main content skeleton */}
          <div className="flex flex-col gap-4">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-4 w-96" />
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-32 rounded-lg" />
              ))}
            </div>
          </div>
        </div>
      </SidebarInset>
    </>
  );
}
