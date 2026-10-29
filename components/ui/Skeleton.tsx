// Shimmer/pulse loading placeholders. Pure presentational -- no hooks, no
// portals -- so these can be dropped into a Server Component (e.g. a
// route's loading.tsx) just as freely as a client one.

interface SkeletonProps {
  className?: string;
}

/** Base building block -- a single pulsing rectangle. Compose the shaped
 * helpers below for common layouts, or use this directly for anything
 * bespoke. */
export function Skeleton({ className = "" }: SkeletonProps) {
  return <div className={`animate-pulse rounded-md bg-border-subtle ${className}`} />;
}

export function SkeletonText({ lines = 3, className = "" }: { lines?: number; className?: string }) {
  return (
    <div className={`space-y-2 ${className}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={`h-3 ${i === lines - 1 ? "w-2/3" : "w-full"}`} />
      ))}
    </div>
  );
}

/** A row-style card placeholder -- matches the shape of a ProjectHub store
 * row / homepage project row (icon chip + two lines of text). */
export function SkeletonCard({ className = "" }: { className?: string }) {
  return (
    <div className={`bg-surface border border-border-subtle rounded-xl px-5 py-4 ${className}`}>
      <div className="flex items-center gap-3">
        <Skeleton className="h-9 w-9 rounded-lg flex-shrink-0" />
        <div className="flex-1 space-y-2 min-w-0">
          <Skeleton className="h-3.5 w-1/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      </div>
    </div>
  );
}

export function SkeletonThumbnail({ className = "" }: { className?: string }) {
  return <Skeleton className={`aspect-video w-full ${className}`} />;
}

/** A dense-table placeholder -- matches the Finish Review grid shape
 * (header bar + N row bars). */
export function SkeletonTable({ rows = 6, className = "" }: { rows?: number; className?: string }) {
  return (
    <div className={`border border-border rounded-xl overflow-hidden ${className}`}>
      <Skeleton className="h-8 w-full rounded-none" />
      <div className="divide-y divide-border-subtle">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="px-3 py-2.5 bg-surface">
            <Skeleton className="h-3 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
