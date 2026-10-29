import Link from "next/link";
import { Upload, FolderOpen } from "lucide-react";
import { listProjects, listImages, listProducts } from "@/lib/db";
import { TopNav } from "@/components/nav/TopNav";
import { EmptyState } from "@/components/ui/EmptyState";

// Reads live DB state on every request -- must not be statically frozen
// at build time (Next.js would otherwise prerender this once and never
// show new projects created after deploy).
export const dynamic = "force-dynamic";

// Mirrors ProjectHub's own schema-approval badge exactly (same state-added /
// state-low-conf token pair) instead of a parallel ad hoc color pick -- the
// two screens describe the same "approved vs not yet" fact and should look
// like it.
function StatusBadge({ status }: { status: "draft" | "approved" }) {
  if (status === "approved") {
    return (
      <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-state-added-fill text-state-added-text">
        Approved
      </span>
    );
  }
  return (
    <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-state-low-conf-fill text-state-low-conf-text">
      Draft
    </span>
  );
}

export default async function HomePage() {
  const projects = await listProjects();
  const withProgress = await Promise.all(
    projects.map(async (p) => {
      const [images, products] = await Promise.all([listImages(p.id), listProducts(p.id)]);
      return { project: p, images, products };
    })
  );

  return (
    <div className="min-h-screen bg-background">
      <TopNav crumbs={[]}>
        <Link
          href="/projects/new"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-navy text-white text-xs font-semibold cursor-pointer hover:bg-navy/90 transition-colors"
        >
          <Upload className="h-3.5 w-3.5" /> New Project
        </Link>
      </TopNav>

      <main className="px-8 py-10">
        <div className="max-w-3xl mx-auto">
          <div className="mb-8">
            <h1 className="text-xl font-bold text-navy">StoreAudit</h1>
            <p className="text-sm text-muted mt-1">Human draws the box, AI fills the fields.</p>
          </div>

          {withProgress.length === 0 ? (
            <EmptyState
              icon={FolderOpen}
              title="No projects yet"
              description='Click "New Project" above to upload a shelf-photo set and an Excel template.'
              actionLabel="New Project"
              actionHref="/projects/new"
            />
          ) : (
            <div className="space-y-3">
              {withProgress.map(({ project: p, images, products }) => {
                const reviewedCount = images.filter((i) => i.is_reviewed).length;
                const confirmed = products.filter((pr) => pr.status === "confirmed" && !pr.duplicate_of).length;
                const drafts = products.filter((pr) => pr.status === "draft").length;
                return (
                  <Link
                    key={p.id}
                    href={`/projects/${p.id}`}
                    className="block bg-surface border border-border rounded-xl px-5 py-4 hover:shadow-md hover:border-navy/30 transition-all cursor-pointer"
                  >
                    <div className="flex items-center justify-between">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-bold text-text truncate">{p.name}</p>
                          <StatusBadge status={p.status} />
                        </div>
                        <p className="text-xs text-muted mt-0.5">
                          {p.context_json.category ?? "Category unknown"} · {p.schema_json.length} columns · {images.length} images ({reviewedCount} reviewed) · {confirmed} products confirmed
                          {drafts > 0 && <span className="text-state-web-text font-semibold"> · {drafts} drafts awaiting review</span>}
                        </p>
                      </div>
                      <p className="text-xs text-muted flex-shrink-0 ml-3">{new Date(p.created_at).toLocaleString()}</p>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
