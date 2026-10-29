import { Skeleton, SkeletonTable } from "@/components/ui/Skeleton";

// Shown while app/projects/[id]/stores/[storeId]/finish/page.tsx's server
// queries (getProject, getStore, listProductsByStore) resolve. Shaped like
// FinishWorkspace's confirmed-products grid.
export default function FinishLoading() {
  return (
    <div className="min-h-screen bg-background">
      <div className="flex items-center justify-between px-5 py-2.5 border-b border-border bg-surface">
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-7 w-32 rounded-lg" />
      </div>
      <main className="px-8 py-8">
        <div className="max-w-7xl mx-auto">
          <Skeleton className="h-4 w-40 mb-4" />
          <SkeletonTable rows={8} />
        </div>
      </main>
    </div>
  );
}
