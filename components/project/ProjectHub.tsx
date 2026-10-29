"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Store as StoreIcon,
  Plus,
  RefreshCw,
  FileSpreadsheet,
} from "lucide-react";
import { TopNav } from "@/components/nav/TopNav";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import type { Project, Store } from "@/lib/types";

interface StoreProgress {
  store: Store;
  imageCount: number;
  reviewedCount: number;
}

interface Props {
  project: Project;
  storesWithProgress: StoreProgress[];
}

export function ProjectHub({ project, storesWithProgress }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [approved, setApproved] = useState(!!project.schema_approved_at);
  const [category, setCategory] = useState(project.context_json.category ?? "");
  const [segmentsText, setSegmentsText] = useState(project.context_json.segments_text ?? "");
  const [rawNotes, setRawNotes] = useState(project.context_json.raw_notes ?? "");
  const [schemaExpanded, setSchemaExpanded] = useState(!approved);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState("");

  const stores = storesWithProgress;
  const [showAddStore, setShowAddStore] = useState(stores.length === 0 && approved);
  const [storeCountry, setStoreCountry] = useState("");
  const [storeName, setStoreName] = useState("");
  const [creatingStore, setCreatingStore] = useState(false);

  async function handleApprove() {
    setApproving(true);
    setError("");
    try {
      const res = await fetch(`/api/projects/${project.id}/approve-schema`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, segments_text: segmentsText, raw_notes: rawNotes }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Approve failed");
      setApproved(true);
      setSchemaExpanded(false);
      toast.success("Schema approved — you can now add stores and photos.");
      if (stores.length === 0) setShowAddStore(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Approve failed");
    } finally {
      setApproving(false);
    }
  }

  async function handleCreateStore(e: React.FormEvent) {
    e.preventDefault();
    if (!storeName.trim()) {
      setError("Store name is required.");
      return;
    }
    setCreatingStore(true);
    setError("");
    try {
      const res = await fetch("/api/stores", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: project.id, country: storeCountry, name: storeName }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not create store");
      router.push(`/projects/${project.id}/stores/${body.store.id}/upload`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not create store");
      setCreatingStore(false);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <TopNav crumbs={[{ label: project.name }]} />
      <main className="px-8 py-10">
        <div className="max-w-3xl mx-auto space-y-6">
          {/* Schema approval card */}
          <div className="bg-surface border border-border-subtle rounded-2xl shadow-sm overflow-hidden">
            <button
              onClick={() => setSchemaExpanded((v) => !v)}
              className="w-full flex items-center justify-between px-6 py-4 cursor-pointer hover:bg-background transition-colors duration-150"
            >
              <div className="flex items-center gap-3 text-left">
                <div
                  className={`h-9 w-9 rounded-xl flex items-center justify-center flex-shrink-0 transition-colors duration-150 ${
                    approved ? "bg-state-added-fill" : "bg-state-low-conf-fill"
                  }`}
                >
                  {approved ? (
                    <CheckCircle2 className="h-4.5 w-4.5 text-state-added-text" />
                  ) : (
                    <FileSpreadsheet className="h-4.5 w-4.5 text-state-low-conf-text" />
                  )}
                </div>
                <div>
                  <p className="text-sm font-semibold text-text">
                    {approved ? "Parsed schema approved" : "Review the model's understanding of your Excel"}
                  </p>
                  <p className="text-xs text-text-secondary">
                    {project.template_file_name} · {project.schema_json.length} columns
                    {approved && " · confirmed"}
                  </p>
                </div>
              </div>
              {schemaExpanded ? (
                <ChevronDown className="h-4 w-4 text-muted flex-shrink-0" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted flex-shrink-0" />
              )}
            </button>

            {schemaExpanded && (
              <div className="px-6 pb-6 border-t border-border-subtle pt-5 space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wide mb-1.5">
                    Category
                  </label>
                  <input
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    disabled={approved}
                    className="w-full text-sm border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-navy/20 focus:border-navy disabled:bg-background disabled:text-text-secondary transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wide mb-1.5">
                    Category / Segment Definitions
                  </label>
                  <textarea
                    value={segmentsText}
                    onChange={(e) => setSegmentsText(e.target.value)}
                    disabled={approved}
                    rows={6}
                    className="w-full text-xs leading-relaxed border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-navy/20 focus:border-navy disabled:bg-background disabled:text-text-secondary transition-colors resize-y"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wide mb-1.5">
                    Template Notes
                  </label>
                  <textarea
                    value={rawNotes}
                    onChange={(e) => setRawNotes(e.target.value)}
                    disabled={approved}
                    rows={4}
                    className="w-full text-xs leading-relaxed border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-navy/20 focus:border-navy disabled:bg-background disabled:text-text-secondary transition-colors resize-y"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wide mb-1.5">
                    Parsed Columns ({project.schema_json.length})
                  </label>
                  <div className="border border-border rounded-lg max-h-56 overflow-y-auto divide-y divide-border-subtle">
                    {project.schema_json.map((col) => (
                      <div key={col.key} className="flex justify-between gap-2 px-3 py-1.5 text-xs">
                        <span className="text-text">{col.header}</span>
                        <span className="text-muted font-mono">{col.key}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {!approved && (
                  <button
                    onClick={handleApprove}
                    disabled={approving}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-navy text-white text-sm font-semibold cursor-pointer hover:bg-navy/90 disabled:opacity-60 transition-colors"
                  >
                    {approving ? <RefreshCw className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                    Approve & Continue
                  </button>
                )}
              </div>
            )}
          </div>

          {error && <p className="text-xs text-state-missing-text">{error}</p>}

          {/* Stores */}
          {approved && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-text">Stores ({stores.length})</h2>
                {!showAddStore && (
                  <button
                    onClick={() => setShowAddStore(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-navy text-white text-xs font-semibold cursor-pointer hover:bg-navy/90 transition-colors"
                  >
                    <Plus className="h-3.5 w-3.5" /> Add Store
                  </button>
                )}
              </div>

              {showAddStore && (
                <form
                  onSubmit={handleCreateStore}
                  className="bg-surface border border-border-subtle rounded-2xl shadow-sm p-5 mb-3 flex items-end gap-3"
                >
                  <div className="flex-1">
                    <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wide mb-1.5">
                      Country
                    </label>
                    <input
                      value={storeCountry}
                      onChange={(e) => setStoreCountry(e.target.value)}
                      placeholder="e.g. Macao"
                      className="w-full text-sm border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-navy/20 focus:border-navy transition-colors"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wide mb-1.5">
                      Store Name
                    </label>
                    <input
                      value={storeName}
                      onChange={(e) => setStoreName(e.target.value)}
                      placeholder="e.g. 7-Eleven Taipa"
                      autoFocus
                      className="w-full text-sm border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-navy/20 focus:border-navy transition-colors"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={creatingStore}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-navy text-white text-sm font-semibold cursor-pointer hover:bg-navy/90 disabled:opacity-60 transition-colors whitespace-nowrap"
                  >
                    {creatingStore ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                    Create & Upload Photos
                  </button>
                  {stores.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowAddStore(false)}
                      className="px-3 py-2 text-xs font-semibold text-muted hover:text-text cursor-pointer"
                    >
                      Cancel
                    </button>
                  )}
                </form>
              )}

              {stores.length === 0 && !showAddStore ? (
                <EmptyState
                  icon={StoreIcon}
                  title="No stores yet"
                  description="Add one to start uploading photos."
                  actionLabel="Add Store"
                  onAction={() => setShowAddStore(true)}
                />
              ) : (
                <div className="space-y-2">
                  {stores.map(({ store, imageCount, reviewedCount }) => {
                    const pct = imageCount === 0 ? 0 : Math.round((reviewedCount / imageCount) * 100);
                    return (
                      <Link
                        key={store.id}
                        href={
                          imageCount === 0
                            ? `/projects/${project.id}/stores/${store.id}/upload`
                            : `/projects/${project.id}/stores/${store.id}/review`
                        }
                        className="group block bg-surface border border-border-subtle rounded-xl px-5 py-4 hover:shadow-md hover:border-navy/20 transition-all duration-150"
                      >
                        <div className="flex items-center justify-between gap-4">
                          <div className="min-w-0 flex items-center gap-3">
                            <div className="h-9 w-9 rounded-lg bg-background flex items-center justify-center flex-shrink-0">
                              <StoreIcon className="h-4 w-4 text-navy" />
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-text truncate">
                                {store.name}
                                {store.country && <span className="text-text-secondary font-normal"> · {store.country}</span>}
                              </p>
                              <p className="text-xs text-text-secondary">
                                {imageCount === 0
                                  ? "No photos yet — click to upload"
                                  : `${imageCount} photo${imageCount === 1 ? "" : "s"} · ${reviewedCount} reviewed`}
                              </p>
                            </div>
                          </div>
                          {imageCount > 0 && (
                            <div className="w-28 flex-shrink-0">
                              <div className="h-1.5 rounded-full bg-background overflow-hidden">
                                <div
                                  className="h-full bg-teal transition-all duration-300"
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                              <p className="text-xs text-muted mt-1 text-right font-mono tabular-nums">{pct}%</p>
                            </div>
                          )}
                        </div>
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
