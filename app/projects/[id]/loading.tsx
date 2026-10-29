import { Skeleton, SkeletonCard } from "@/components/ui/Skeleton";

// Shown while app/projects/[id]/page.tsx's server-side queries (getProject,
// listStores, per-store listImagesByStore) resolve. Shaped like ProjectHub's
// schema-approval card + store list.
export default function ProjectLoading() {
  return (
    <div className="min-h-screen bg-background">
      <div className="flex items-center justify-between px-5 py-2.5 border-b border-border bg-surface">
        <Skeleton className="h-4 w-48" />
      </div>
      <main className="px-8 py-10">
        <div className="max-w-3xl mx-auto space-y-6">
          <div className="bg-surface border border-border-subtle rounded-2xl shadow-sm px-6 py-4">
            <div className="flex items-center gap-3">
              <Skeleton className="h-9 w-9 rounded-xl flex-shrink-0" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-1/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
          </div>
          <div>
            <Skeleton className="h-4 w-24 mb-3" />
            <div className="space-y-2">
              {Array.from({ length: 2 }).map((_, i) => (
                <SkeletonCard key={i} />
              ))}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
