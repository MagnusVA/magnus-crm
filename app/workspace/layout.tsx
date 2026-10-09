import { type ReactNode, Suspense } from "react";
import { WorkspaceShellFrame } from "./_components/workspace-shell-frame";
import { WorkspaceAuth } from "./_components/workspace-auth";
import { WorkspaceShellSkeleton } from "./_components/workspace-shell-skeleton";

export default function WorkspaceLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <WorkspaceShellFrame>
      <Suspense fallback={<WorkspaceShellSkeleton />}>
        <WorkspaceAuth>{children}</WorkspaceAuth>
      </Suspense>
    </WorkspaceShellFrame>
  );
}
