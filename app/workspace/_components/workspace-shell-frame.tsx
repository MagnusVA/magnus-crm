import { type ReactNode } from "react";
import { SidebarProvider } from "@/components/ui/sidebar";

/**
 * Static shell for the workspace layout.
 * This component contains NO dynamic data — it renders at build time
 * and is served instantly from CDN / static cache.
 *
 * SidebarProvider lives here (above the Suspense boundary) so sidebar
 * open/close state is preserved across streaming and Activity transitions.
 * All sidebar sub-components (Sidebar, SidebarInset, SidebarTrigger) are
 * descendants via context — they render inside the skeleton (Suspense
 * fallback) and the auth-dependent client shell.
 *
 * The skip-to-content link is rendered here (outside Suspense) so it is
 * always present in the initial static HTML, satisfying WCAG 2.4.1.
 *
 * @see vercel-composition-patterns: architecture-compound-components
 * @see web-design-guidelines: skip-to-content, focus management
 * @see vercel-react-best-practices: rendering-activity (state preservation)
 */
export function WorkspaceShellFrame({ children }: { children: ReactNode }) {
  return (
    <SidebarProvider>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>
      {children}
    </SidebarProvider>
  );
}
