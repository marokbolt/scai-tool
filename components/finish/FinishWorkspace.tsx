"use client";

import { useRef, useState } from "react";
import { RefreshCw, CheckCircle2, Download, AlertTriangle, X, Sparkles, Check, Trash2, XCircle, PackageSearch } from "lucide-react";
import { TopNav } from "@/components/nav/TopNav";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import type { Project, Store, ProductRow } from "@/lib/types";

// Three-tier extraction-confidence badge, mapped 1:1 onto the Excel export's
// own AI-confidence color legend (CLAUDE.md / tailwind.config.ts) instead of
// an ad hoc green/yellow/red. Each tier also gets its own icon shape --
// color is never the only signal for this.
function ConfidenceBadge({ score }: { score: number }) {
  const tier =
    score >= 0.8
      ? { fill: "bg-state-ai-high-fill", text: "text-state-ai-high-text", Icon: CheckCircle2 }
      : score >= 0.6
        ? { fill: "bg-state-low-conf-fill", text: "text-state-low-conf-text", Icon: AlertTriangle }
        : { fill: "bg-state-missing-fill", text: "text-state-missing-text", Icon: XCircle };
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold px-1.5 py-0.5 rounded-full whitespace-nowrap ${tier.fill} ${tier.text}`}>
      <tier.Icon className="h-3 w-3" /> {Math.round(score * 100)}%
    </span>
  );
}

interface Props {
  project: Project;
  store: Store;
  initialProducts: ProductRow[];
}

export function FinishWorkspace({ project, store, initialProducts }: Props) {
  const toast = useToast();
  const [products, setProducts] = useState(initialProducts);
  const [status, setStatus] = useState(project.status);
  const [runningDedup, setRunningDedup] = useState(false);
  const [approving, setApproving] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [selectedDrafts, setSelectedDrafts] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");

  // Destructive-action confirmations (Dialog/ConfirmDialog primitive --
  // components/ui/Dialog.tsx). Rejecting a draft or removing a flagged
  // duplicate both permanently delete the product row with no way back, and
  // previously had zero confirmation at all.
  const [rejectConfirm, setRejectConfirm] = useState<{ ids: string[]; label: string } | null>(null);
  const [removeConfirm, setRemoveConfirm] = useState<{ id: string; label: string } | null>(null);
  const [showApproveConfirm, setShowApproveConfirm] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const draftProducts = products.filter((p) => p.status === "draft");
  const confirmedProducts = products.filter((p) => p.status === "confirmed");
  const activeProducts = confirmedProducts.filter((p) => !p.duplicate_of);
  const flaggedProducts = confirmedProducts.filter((p) => p.duplicate_of);

  // "First truthy field" tends to land on a near-universal, non-identifying
  // column (row_number/#, sub_channel, industry...) rather than anything
  // that actually distinguishes one product from another -- on a real
  // project this showed two genuinely different products both labeled "30"
  // in the duplicates panel (both had the same early column populated and
  // nothing before it), reading as "flagged as a duplicate of itself" when
  // it wasn't. Prefer a column that looks like it actually names the product.
  const labelKeys = project.schema_json
    .filter((c) => /brand|product|description|name/i.test(c.header))
    .map((c) => c.key);
  function productLabel(p: ProductRow): string {
    for (const k of labelKeys) {
      if (p.fields[k]) return p.fields[k] as string;
    }
    return (Object.values(p.fields).find((v) => v) as string) ?? p.id;
  }

  function toggleDraftSelected(id: string) {
    setSelectedDrafts((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleBulkDraftAction(ids: string[], action: "accept" | "reject") {
    if (ids.length === 0) return;
    setBulkBusy(true);
    setError("");
    try {
      const res = await fetch("/api/products/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, action }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Bulk action failed");
      if (action === "accept") {
        setProducts((prev) => prev.map((p) => (ids.includes(p.id) ? { ...p, status: "confirmed" } : p)));
        toast.success(`${ids.length} draft${ids.length === 1 ? "" : "s"} accepted.`);
      } else {
        setProducts((prev) => prev.filter((p) => !ids.includes(p.id)));
        toast.success(`${ids.length} draft${ids.length === 1 ? "" : "s"} rejected and discarded.`);
      }
      setSelectedDrafts((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Bulk action failed");
    } finally {
      setBulkBusy(false);
    }
  }

  // Rejecting a draft permanently discards an AI-extracted row (a real paid
  // Vision call already happened for it) -- gate every path that can reject
  // (row button, "Reject Selected", "Reject All") behind the same confirm.
  function requestReject(ids: string[], label: string) {
    if (ids.length === 0) return;
    setRejectConfirm({ ids, label });
  }

  async function confirmReject() {
    if (!rejectConfirm) return;
    setConfirmBusy(true);
    await handleBulkDraftAction(rejectConfirm.ids, "reject");
    setConfirmBusy(false);
    setRejectConfirm(null);
  }

  // Every keystroke used to fire its own PATCH immediately -- the server's
  // PATCH handler does a non-atomic read-modify-write (read the row, merge
  // one field, write the whole fields object back), so two in-flight
  // requests for the same row (e.g. editing two fields within the same
  // second) could race: the second request's write, built from a read that
  // happened before the first request's write committed, silently clobbers
  // the first edit even though both calls return 200. Debouncing per
  // (product, field) collapses a burst of keystrokes into one request, the
  // same pattern CandidateBoard's notes field already uses -- it narrows the
  // race window from "any two edits within a request round-trip" down to
  // "two edits to the same field within 500ms," not a full fix (that needs a
  // DB-side merge or optimistic lock) but a large, cheap reduction.
  const fieldEditTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const fieldEditOriginals = useRef<Record<string, ProductRow>>({});

  function handleFieldEdit(productId: string, key: string, value: string) {
    const current = products.find((p) => p.id === productId);
    if (!current) return;
    const timerKey = `${productId}:${key}`;
    // Snapshot the pre-edit row only on the FIRST keystroke of a burst --
    // later keystrokes in the same debounce window must roll back all the
    // way to this, not to the mid-burst state the previous keystroke wrote.
    if (!fieldEditTimers.current[timerKey]) {
      fieldEditOriginals.current[timerKey] = current;
    }
    // Editing a draft and saving is itself the human review -- promote it,
    // mirroring the PATCH route's own rule, so it moves out of the Drafts
    // section into the confirmed table without a separate Accept click.
    // This optimistic update stays immediate (not debounced) so typing feels
    // responsive; only the network call below is debounced.
    setProducts((prev) =>
      prev.map((p) =>
        p.id === productId
          ? {
              ...p,
              fields: { ...p.fields, [key]: value },
              field_sources: { ...p.field_sources, [key]: "analyst" },
              status: "confirmed",
            }
          : p
      )
    );
    if (fieldEditTimers.current[timerKey]) clearTimeout(fieldEditTimers.current[timerKey]);
    fieldEditTimers.current[timerKey] = setTimeout(async () => {
      delete fieldEditTimers.current[timerKey];
      const original = fieldEditOriginals.current[timerKey];
      delete fieldEditOriginals.current[timerKey];
      try {
        const res = await fetch(`/api/products/${productId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key, value }),
        });
        if (!res.ok) throw new Error("Save failed");
      } catch {
        // Roll back -- otherwise the row shows as confirmed with the edited
        // value even though the DB still has the old (or draft) row, and it
        // would silently disappear from the Excel export with no indication
        // the edit never actually landed.
        if (original) setProducts((prev) => prev.map((p) => (p.id === productId ? original : p)));
        setError(`Failed to save "${key}" -- your edit was not saved, please try again.`);
      }
    }, 500);
  }

  async function handleRunDedup() {
    setRunningDedup(true);
    setError("");
    try {
      const res = await fetch("/api/dedup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: project.id, store_id: store.id }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Dedup failed");

      const flagMap = new Map<string, { duplicate_of: string; confidence: number }>(
        body.flagged.map((f: { id: string; duplicate_of: string; confidence: number }) => [f.id, f])
      );
      setProducts((prev) =>
        prev.map((p) => {
          const f = flagMap.get(p.id);
          return f ? { ...p, duplicate_of: f.duplicate_of, duplicate_confidence: f.confidence } : p;
        })
      );
      toast.info(
        body.flagged.length > 0
          ? `Duplicate check complete — ${body.flagged.length} possible duplicate${body.flagged.length === 1 ? "" : "s"} flagged.`
          : "Duplicate check complete — nothing flagged."
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Dedup failed");
    } finally {
      setRunningDedup(false);
    }
  }

  async function handleUnflag(productId: string) {
    const previous = products.find((p) => p.id === productId);
    if (!previous) return;
    setProducts((prev) =>
      prev.map((p) => (p.id === productId ? { ...p, duplicate_of: null, duplicate_confidence: null } : p))
    );
    try {
      const res = await fetch(`/api/products/${productId}/unflag`, { method: "POST" });
      if (!res.ok) throw new Error("Unflag failed");
    } catch {
      setProducts((prev) => prev.map((p) => (p.id === productId ? previous : p)));
      setError("Failed to clear the duplicate flag -- it's still flagged, please try again.");
    }
  }

  async function handleRemove(productId: string) {
    const removed = products.find((p) => p.id === productId);
    setProducts((prev) => prev.filter((p) => p.id !== productId));
    try {
      const res = await fetch(`/api/products/${productId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      toast.success("Product removed.");
    } catch {
      if (removed) setProducts((prev) => [...prev, removed]);
      setError("Failed to remove product -- it has not actually been deleted, please try again.");
    }
  }

  async function confirmRemove() {
    if (!removeConfirm) return;
    setConfirmBusy(true);
    await handleRemove(removeConfirm.id);
    setConfirmBusy(false);
    setRemoveConfirm(null);
  }

  // Approving with unresolved drafts/duplicates is still allowed (the
  // analyst may genuinely want to ship without them), but it's a one-way,
  // easy-to-regret action -- gate it behind the shared ConfirmDialog instead
  // of the two sequential native window.confirm() popups this used to be,
  // which looked completely out of place next to the rest of this design
  // system and couldn't show both warnings at once.
  function handleApproveClick() {
    if (draftProducts.length > 0 || flaggedProducts.length > 0) {
      setShowApproveConfirm(true);
      return;
    }
    void doApprove();
  }

  async function doApprove() {
    setApproving(true);
    setError("");
    try {
      const res = await fetch(`/api/projects/${project.id}/approve`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Approve failed");
      setStatus(body.project.status);
      toast.success("Project approved and saved.");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Approve failed");
    } finally {
      setApproving(false);
      setShowApproveConfirm(false);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <TopNav
        crumbs={[
          { label: project.name, href: `/projects/${project.id}` },
          { label: store.name, href: `/projects/${project.id}/stores/${store.id}/review` },
          { label: "Finish" },
        ]}
      >
        {status === "approved" ? (
          <span className="flex items-center gap-1 text-xs font-semibold text-teal">
            <CheckCircle2 className="h-3.5 w-3.5" /> Approved
          </span>
        ) : (
          <button
            onClick={handleApproveClick}
            disabled={approving || activeProducts.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-teal text-white text-xs font-semibold cursor-pointer hover:bg-teal/90 disabled:opacity-60 transition-colors"
          >
            {approving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            Approve & Save
          </button>
        )}
        <a
          href={`/api/export?project_id=${project.id}&store_id=${store.id}`}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-navy text-white text-xs font-semibold cursor-pointer hover:bg-navy/90 transition-colors"
        >
          <Download className="h-3.5 w-3.5" /> Download Excel
        </a>
      </TopNav>

      <main className="px-8 py-8">
        <div className="max-w-7xl mx-auto">
          {draftProducts.length > 0 && (
            <div className="mb-6 border border-state-web-text bg-state-web-fill rounded-xl p-4">
              <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                <p className="text-xs font-bold text-navy flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5" />
                  {draftProducts.length} auto-extracted draft{draftProducts.length === 1 ? "" : "s"} need review — not yet in the Excel export
                </p>
                <div className="flex items-center gap-2">
                  {selectedDrafts.size > 0 && (
                    <>
                      <button
                        onClick={() => handleBulkDraftAction(Array.from(selectedDrafts), "accept")}
                        disabled={bulkBusy}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-teal text-white text-xs font-semibold cursor-pointer hover:bg-teal/90 disabled:opacity-60"
                      >
                        <Check className="h-3 w-3" /> Accept Selected ({selectedDrafts.size})
                      </button>
                      <button
                        onClick={() =>
                          requestReject(Array.from(selectedDrafts), `${selectedDrafts.size} selected draft${selectedDrafts.size === 1 ? "" : "s"}`)
                        }
                        disabled={bulkBusy}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-border text-red text-xs font-semibold cursor-pointer hover:bg-surface disabled:opacity-60"
                      >
                        <Trash2 className="h-3 w-3" /> Reject Selected
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => handleBulkDraftAction(draftProducts.map((p) => p.id), "accept")}
                    disabled={bulkBusy}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-navy text-white text-xs font-semibold cursor-pointer hover:bg-navy/90 disabled:opacity-60"
                  >
                    {bulkBusy ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Accept All
                  </button>
                  <button
                    onClick={() => requestReject(draftProducts.map((p) => p.id), `all ${draftProducts.length} draft${draftProducts.length === 1 ? "" : "s"}`)}
                    disabled={bulkBusy}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-border text-muted text-xs font-semibold cursor-pointer hover:bg-surface disabled:opacity-60"
                  >
                    Reject All
                  </button>
                </div>
              </div>
              <p className="text-xs text-muted mb-2">
                Edit any field to accept that row with your correction, or use the checkboxes to accept/reject in bulk. Nothing here reaches the Excel export until accepted.
              </p>
              <div className="overflow-x-auto border border-border rounded-lg bg-surface">
                <table className="text-xs w-full">
                  <thead>
                    <tr className="bg-background">
                      <th className="px-2 py-1.5 w-8"></th>
                      <th className="px-2 py-1.5 text-left font-semibold text-muted whitespace-nowrap">Conf.</th>
                      {project.schema_json.map((col) => (
                        <th key={col.key} className="px-2 py-1.5 text-left font-semibold text-muted whitespace-nowrap">
                          {col.header}
                        </th>
                      ))}
                      <th className="px-2 py-1.5 w-20"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {draftProducts.map((p, idx) => (
                      <tr key={p.id} className={idx % 2 === 0 ? "bg-surface" : "bg-background"}>
                        <td className="px-2 py-1 text-center">
                          <input
                            type="checkbox"
                            checked={selectedDrafts.has(p.id)}
                            onChange={() => toggleDraftSelected(p.id)}
                            className="cursor-pointer"
                          />
                        </td>
                        <td className="px-2 py-1 whitespace-nowrap">
                          {p.confidence_score != null && <ConfidenceBadge score={p.confidence_score} />}
                        </td>
                        {project.schema_json.map((col) => (
                          <td key={col.key} className="border-b border-border-subtle p-0">
                            <input
                              value={p.fields[col.key] ?? ""}
                              onChange={(e) => handleFieldEdit(p.id, col.key, e.target.value)}
                              placeholder="—"
                              className="w-full min-w-[110px] px-2 py-1.5 text-xs bg-transparent focus:outline-none focus:ring-1 focus:ring-navy focus:bg-surface"
                            />
                          </td>
                        ))}
                        <td className="px-2 py-1 whitespace-nowrap">
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => handleBulkDraftAction([p.id], "accept")}
                              disabled={bulkBusy}
                              title="Accept"
                              className="text-teal hover:bg-state-added-fill rounded p-1 cursor-pointer disabled:opacity-60"
                            >
                              <Check className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={() => requestReject([p.id], `"${productLabel(p)}"`)}
                              disabled={bulkBusy}
                              title="Reject"
                              className="text-red hover:bg-state-missing-fill rounded p-1 cursor-pointer disabled:opacity-60"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between mb-4">
            <p className="text-xs text-muted">
              {activeProducts.length} confirmed rows{flaggedProducts.length > 0 ? ` · ${flaggedProducts.length} flagged as possible duplicates` : ""}
            </p>
            <button
              onClick={handleRunDedup}
              disabled={runningDedup}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-surface text-xs font-semibold text-navy cursor-pointer hover:bg-background disabled:opacity-60 transition-colors"
            >
              {runningDedup ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <AlertTriangle className="h-3.5 w-3.5" />}
              Run Duplicate Check
            </button>
          </div>

          {error && <p className="text-xs text-state-missing-text mb-3">{error}</p>}

          {flaggedProducts.length > 0 && (
            <div className="mb-6 border border-state-override-text bg-state-override-fill rounded-xl p-4">
              <p className="text-xs font-bold text-state-override-text mb-2">
                Possible duplicates — resolve before approving
              </p>
              <div className="space-y-2">
                {flaggedProducts.map((p) => {
                  const original = products.find((o) => o.id === p.duplicate_of);
                  return (
                    <div key={p.id} className="flex items-center justify-between bg-surface rounded-lg px-3 py-2">
                      <p className="text-xs text-text truncate flex-1">
                        <span className="font-semibold">{productLabel(p)} (#{p.fields.row_number ?? "?"})</span>
                        <span className="text-muted"> looks like </span>
                        <span className="font-semibold">
                          {original ? `${productLabel(original)} (#${original.fields.row_number ?? "?"})` : "an earlier row"}
                        </span>
                        <span className="text-muted"> ({Math.round((p.duplicate_confidence ?? 0) * 100)}% similar)</span>
                      </p>
                      <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                        <button
                          onClick={() => handleUnflag(p.id)}
                          className="text-xs font-semibold text-navy hover:underline cursor-pointer"
                        >
                          Not a duplicate
                        </button>
                        <button
                          onClick={() => setRemoveConfirm({ id: p.id, label: `"${productLabel(p)}"` })}
                          className="flex items-center gap-1 text-xs font-semibold text-red hover:underline cursor-pointer"
                        >
                          <X className="h-3 w-3" /> Remove
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="overflow-x-auto border border-border rounded-xl bg-surface">
            <table className="text-xs w-full">
              <thead>
                <tr className="bg-navy text-white">
                  {project.schema_json.map((col) => (
                    <th key={col.key} className="px-2 py-2 text-left font-semibold whitespace-nowrap">
                      {col.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {activeProducts.map((p, idx) => (
                  <tr key={p.id} className={idx % 2 === 0 ? "bg-surface" : "bg-background"}>
                    {project.schema_json.map((col) => (
                      <td key={col.key} className="border-b border-border-subtle p-0">
                        <input
                          value={p.fields[col.key] ?? ""}
                          onChange={(e) => handleFieldEdit(p.id, col.key, e.target.value)}
                          placeholder="—"
                          className="w-full min-w-[120px] px-2 py-1.5 text-xs bg-transparent focus:outline-none focus:ring-1 focus:ring-navy focus:bg-surface"
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {activeProducts.length === 0 && (
              <EmptyState
                icon={PackageSearch}
                title="No confirmed products yet"
                description="Go back to Review to identify and extract products from this store's photos."
              />
            )}
          </div>
        </div>
      </main>

      <ConfirmDialog
        open={!!rejectConfirm}
        onClose={() => setRejectConfirm(null)}
        onConfirm={confirmReject}
        confirming={confirmBusy}
        destructive
        title="Reject and discard?"
        description={`This permanently discards ${rejectConfirm?.label ?? "this draft"}. The extracted data cannot be recovered, and it will not appear in the Excel export.`}
        confirmLabel="Reject & Discard"
      />

      <ConfirmDialog
        open={!!removeConfirm}
        onClose={() => setRemoveConfirm(null)}
        onConfirm={confirmRemove}
        confirming={confirmBusy}
        destructive
        title="Remove this product?"
        description={`This permanently deletes ${removeConfirm?.label ?? "this product"}. This cannot be undone.`}
        confirmLabel="Remove"
      />

      <ConfirmDialog
        open={showApproveConfirm}
        onClose={() => setShowApproveConfirm(false)}
        onConfirm={doApprove}
        confirming={approving}
        destructive
        title="Approve with unresolved items?"
        description={
          <>
            {draftProducts.length > 0 && (
              <p>
                {draftProducts.length} auto-extracted draft{draftProducts.length === 1 ? "" : "s"}{" "}
                {draftProducts.length === 1 ? "hasn't" : "haven't"} been reviewed yet and will NOT be included in the export.
              </p>
            )}
            {flaggedProducts.length > 0 && (
              <p className={draftProducts.length > 0 ? "mt-2" : ""}>
                {flaggedProducts.length} possible duplicate{flaggedProducts.length === 1 ? "" : "s"}{" "}
                {flaggedProducts.length === 1 ? "is" : "are"} still unresolved and will be excluded from the export until
                resolved above.
              </p>
            )}
          </>
        }
        confirmLabel="Approve Anyway"
      />
    </div>
  );
}
