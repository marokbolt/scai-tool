import { Skeleton, SkeletonCard } from "@/components/ui/Skeleton";

// Next.js route-segment loading state -- shown automatically while
// app/page.tsx's server-side DB queries (listProjects/listImages/
// listProducts) resolve. Shaped like the real project list so the layout
// doesn't jump once data arrives.
export default function HomeLoading() {
  return (
    <div className="min-h-screen bg-background">
      <div className="flex items-center justify-between px-5 py-2.5 border-b border-border bg-surface">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-7 w-28 rounded-lg" />
      </div>
      <main className="px-8 py-10">
        <div className="max-w-3xl mx-auto">
          <div className="mb-8 space-y-2">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-64" />
          </div>
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
