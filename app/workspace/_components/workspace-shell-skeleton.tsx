import { Skeleton } from "@/components/ui/skeleton";
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
  SidebarMenuItem,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";

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
        <SidebarHeader>
          <span className="px-2 py-1.5 text-xs font-semibold uppercase tracking-[0.25em] text-sidebar-foreground/80">
            Magnus
          </span>
          <Separator className="mx-2" />
          {/* User info skeleton — matches displayName + role label */}
          <div className="flex flex-col gap-1 px-2 py-1.5">
            <Skeleton className="h-4 w-24 rounded" />
            <Skeleton className="h-3 w-16 rounded" />
          </div>
        </SidebarHeader>
        <SidebarContent>
          {/* Sidebar nav skeleton — 4 items matches admin nav count */}
          <SidebarGroup>
            <SidebarGroupLabel>Navigation</SidebarGroupLabel>
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
        <SidebarFooter>
          {/* Footer skeleton — matches Profile + Sign Out items */}
          <SidebarMenu>
            <SidebarMenuItem>
              <Skeleton className="h-8 w-full rounded-md" />
            </SidebarMenuItem>
            <SidebarMenuItem>
              <Skeleton className="h-8 w-full rounded-md" />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="flex h-12 items-center gap-2 border-b px-4">
          <SidebarTrigger aria-label="Toggle sidebar" />
          <Separator orientation="vertical" className="h-4" />
          {/* Toolbar skeleton — matches breadcrumbs + action buttons */}
          <div className="ml-auto flex items-center gap-2">
            <Skeleton className="h-6 w-32 rounded" />
            <Skeleton className="h-8 w-8 rounded-md" />
            <Skeleton className="h-8 w-8 rounded-md" />
            <Skeleton className="h-8 w-8 rounded-md" />
          </div>
        </header>
        <div
          id="main-content"
          className="flex-1 overflow-auto p-6"
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
