"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { CheckCircle2, ChevronLeft, ChevronRight, X, PartyPopper, Play, AlertCircle, SkipForward, Sparkles, RefreshCw } from "lucide-react";
import { BoxDrawTool, type ExtractionModel } from "./BoxDrawTool";
import { CandidateBoard, type CandidateItemStatus } from "./CandidateBoard";
import { FieldForm } from "./FieldForm";
import { CostTracker } from "./CostTracker";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { useToast } from "@/components/ui/Toast";
import { TopNav } from "@/components/nav/TopNav";
import { publicUrl } from "@/lib/storage";
import type { Project, Store, ProjectImage, ProductRow, BoundingBox } from "@/lib/types";
import { GLOBAL_COST_LIMIT_USD, checkCostCaps, type CallRecord } from "@/lib/pricing";

const TYPE_LABEL: Record<string, string> = {
  storefront: "Storefront",
  aisle: "Aisle",
  shelf: "Shelf",
  product_solo: "Product close-up",
};

interface Props {
  project: Project;
  store: Store;
  initialImages: ProjectImage[];
  initialProducts: ProductRow[];
  initialGlobalCost: number;
}

export function ReviewWorkspace({ project, store, initialImages, initialProducts, initialGlobalCost }: Props) {
  const toast = useToast();
  const [images, setImages] = useState(initialImages);
  const [products, setProducts] = useState(initialProducts);
  const [currentImageId, setCurrentImageId] = useState(initialImages[0]?.id ?? "");
  const [model, setModel] = useState<ExtractionModel>("claude-haiku");
  const [extracting, setExtracting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [cropBlob, setCropBlob] = useState<Blob | null>(null);
  const [boxDrawNotes, setBoxDrawNotes] = useState("");
  const [fields, setFields] = useState<Record<string, string | null>>({});
  const [editedKeys, setEditedKeys] = useState<Set<string>>(new Set());
  const [meta, setMeta] = useState<{ in_scope: boolean; confidence_score: number | null; reason: string | null } | null>(null);
  const [modelUsed, setModelUsed] = useState<string | null>(null);
  const [pendingBox, setPendingBox] = useState<BoundingBox | null>(null);
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [skipping, setSkipping] = useState(false);
  // costExhausted means "blocked by EITHER cap" -- there are now two layered
  // caps (lib/pricing.ts checkCostCaps): this project's own cost_limit_usd,
  // and the shared GLOBAL_COST_LIMIT_USD across every project, which must
  // never reset just because a new project was created. Every API response
  // that trips either one sets costExhausted here the same way; costCapReason
  // below only exists so the banner/header text can tell the analyst which
  // one actually blocked them.
  // Computed via the same checkCostCaps the server uses, not just the global
  // figure -- otherwise a project already over its OWN budget (while the
  // shared global cap is nowhere near reached) would render every action
  // button enabled on first load, only correcting itself after the first
  // call 402s.
  const initialCapCheck = checkCostCaps(project, initialGlobalCost);
  const [costExhausted, setCostExhausted] = useState(initialCapCheck.blocked);
  const [costCapReason, setCostCapReason] = useState<"project" | "global" | null>(
    initialCapCheck.blocked ? initialCapCheck.cap : null
  );
  const [liveCost, setLiveCost] = useState(initialGlobalCost);
  // This project's own running spend, shown alongside the global figure so
  // the analyst can see "$2.14 of this project's $5.00 budget" -- a project
  // with no project-specific limit configured (cost_limit_usd falsy/<=0)
  // shows none of this and falls back to the global cap alone.
  const [liveProjectCost, setLiveProjectCost] = useState(project.total_cost_usd);
  const hasProjectLimit = project.cost_limit_usd > 0;
  const [autoExtracting, setAutoExtracting] = useState(false);
  const [confirmReRunExtract, setConfirmReRunExtract] = useState(false);
  const [autoExtractMessage, setAutoExtractMessage] = useState("");
  const [autoExtractModel, setAutoExtractModel] = useState<ExtractionModel>("claude-sonnet");
  const [identifying, setIdentifying] = useState(false);

  interface QueueItem {
    id: string;
    blob: Blob;
    box: BoundingBox;
    imageId: string;
    imageName: string;
    notes: string;
  }
  interface BatchResult {
    id: string;
    imageId: string;
    imageName: string;
    cropBlob: Blob;
    box: BoundingBox;
    fields: Record<string, string | null>;
    meta: { in_scope: boolean; confidence_score: number | null; reason: string | null };
    modelUsed: string;
  }
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const [batchMessage, setBatchMessage] = useState("");
  // Extraction runs concurrently, but each result still needs an explicit
  // human review/confirm before it's saved -- these hold the queued-up
  // results the analyst steps through one at a time, reusing the same
  // FieldForm + Confirm flow as a single live extraction.
  const [batchResults, setBatchResults] = useState<BatchResult[]>([]);
  const [batchReviewIndex, setBatchReviewIndex] = useState(-1);
  const inBatchReview = batchReviewIndex >= 0 && batchReviewIndex < batchResults.length;

  // Navigation is disabled during any in-flight save/extract so a stale
  // async response can never land fields on the wrong image (found this bug
  // during review: switching images mid-extraction silently overwrote the
  // newly-selected image's form with the previous image's result). Also
  // locked during batch review (main image is driven by whichever result is
  // under review, not free navigation) and whenever the queue has anything
  // staged -- the analyst must finish (Run All or Clear) one image's queue
  // before moving to another, so a queue can never span multiple images.
  // autoExtracting (the whole-image pass) takes 1-3 minutes -- without this,
  // switching images mid-call loses the only visual sign it's still running
  // and nothing stops clicking it again on another image in the meantime.
  const navLocked =
    extracting || confirming || skipping || batchRunning || inBatchReview || queue.length > 0 || autoExtracting;

  const grouped = useMemo(() => {
    const acc: Record<string, ProjectImage[]> = {};
    for (const img of images) {
      const key = img.image_type ?? "unclassified";
      (acc[key] ??= []).push(img);
    }
    return acc;
  }, [images]);

  // Flat order matches the sidebar's grouped display, so Prev/Next follows
  // the same order the analyst sees.
  const orderedImages = useMemo(() => Object.values(grouped).flat(), [grouped]);

  const currentImage = images.find((i) => i.id === currentImageId) ?? null;
  const currentImageProducts = products.filter((p) => p.image_id === currentImageId);
  const currentProducts = currentImageProducts.filter((p) => p.status === "confirmed");
  const currentIndex = orderedImages.findIndex((i) => i.id === currentImageId);
  const allReviewed = images.length > 0 && images.every((i) => i.is_reviewed);

  // Picking "the first truthy field" as a display label tends to surface
  // whatever column happens to come first in the schema (e.g. a country
  // field) rather than something that actually identifies the product --
  // prefer a column that looks like a brand/product/description field.
  const labelKeys = useMemo(
    () => project.schema_json.filter((c) => /brand|product|description|name/i.test(c.header)).map((c) => c.key),
    [project.schema_json]
  );
  function productLabel(p: ProductRow): string {
    for (const k of labelKeys) {
      if (p.fields[k]) return p.fields[k] as string;
    }
    return (Object.values(p.fields).find((v) => v) as string) ?? p.id;
  }

  // Shared reset for the right-panel form -- used when discarding an
  // unconfirmed extraction, cancelling an edit, switching images, and after
  // a non-batch confirm.
  function resetForm() {
    setFields({});
    setMeta(null);
    setModelUsed(null);
    setCropBlob(null);
    setEditedKeys(new Set());
    setPendingBox(null);
    setEditingProductId(null);
    setError("");
    setBoxDrawNotes("");
  }

  function selectImage(id: string) {
    if (navLocked) return;
    setCurrentImageId(id);
    resetForm();
  }

  function goToOffset(offset: number) {
    if (currentIndex === -1) return;
    const next = orderedImages[currentIndex + offset];
    if (next) selectImage(next.id);
  }

  function advanceToNextUnreviewed() {
    const startIdx = currentIndex === -1 ? 0 : currentIndex + 1;
    const next =
      orderedImages.slice(startIdx).find((i) => !i.is_reviewed) ??
      orderedImages.find((i) => !i.is_reviewed);
    if (next) selectImage(next.id);
  }

  async function handleSkip() {
    if (!currentImage) return;
    setSkipping(true);
    setError("");
    try {
      await fetch(`/api/image-review/${currentImage.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_reviewed: true }),
      });
      setImages((prev) => prev.map((i) => (i.id === currentImage.id ? { ...i, is_reviewed: true } : i)));
      advanceToNextUnreviewed();
    } catch {
      setError("Failed to skip image");
    } finally {
      setSkipping(false);
    }
  }

  async function handleRemoveProduct(productId: string) {
    const removed = products.find((p) => p.id === productId);
    setProducts((prev) => prev.filter((p) => p.id !== productId));
    try {
      const res = await fetch(`/api/products/${productId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
    } catch {
      // Roll back -- otherwise the row looks gone here but still exists in
      // the DB and silently reappears in Finish Review / the Excel export.
      if (removed) setProducts((prev) => [...prev, removed]);
      setError("Failed to remove product -- it has not actually been deleted, please try again.");
    }
  }

  // Reads the WHOLE current image in one call instead of requiring a box per
  // product -- validated against real shelf photos before this was wired in
  // (scripts/validate-whole-image-extraction.mjs). Results land as drafts,
  // reviewed/accepted in bulk on the Finish Review page, not here.
  //
  // force is NEVER computed client-side from existing drafts (that defeated
  // the server's own re-run guard -- found in review: every click after the
  // first silently passed force=true, so the 409 warning could never fire
  // and a double-click meant a second full-price Vision call with zero
  // confirmation). Only ever set true after the analyst explicitly confirms
  // the re-run prompt below.
  // force is NEVER computed client-side from existing drafts (that defeated
  // the server's own re-run guard -- found in review: every click after the
  // first silently passed force=true, so the 409 warning could never fire
  // and a double-click meant a second full-price Vision call with zero
  // confirmation). Only ever set true after the analyst explicitly confirms
  // the re-run dialog below (confirmReRunExtract).
  async function runAutoExtract(force: boolean) {
    if (!currentImage) return;
    setAutoExtracting(true);
    setAutoExtractMessage("");
    setError("");
    try {
      const res = await fetch("/api/extract-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: project.id, image_id: currentImage.id, model: autoExtractModel, force }),
      });
      const body = await res.json();
      // Even on failure the server may have already charged for real
      // tokens (a response that came back truncated/unparseable still
      // cost money) -- keep the cost tracker honest either way.
      if (typeof body.global_total_cost_usd === "number") {
        setLiveCost(body.global_total_cost_usd);
        if (body.global_total_cost_usd >= body.cost_limit_usd) setCostExhausted(true);
      }
      trackCost(body);
      if (!res.ok) {
        if (body.cost_limit_reached) setCostExhausted(true);
        if (body.already_extracted && !force) {
          setConfirmReRunExtract(true);
          return;
        }
        throw new Error(body.error ?? "Auto-extract failed");
      }
      setProducts((prev) => [...prev, ...body.products]);
      setAutoExtractMessage(
        `Found ${body.products.length} product${body.products.length === 1 ? "" : "s"}${body.skipped_count ? `, skipped ${body.skipped_count} as illegible` : ""}${body.truncated ? " (model ran out of room and may have more to find -- consider re-running)" : ""} -- review in Finish Review.`
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Auto-extract failed");
    } finally {
      setAutoExtracting(false);
    }
  }

  function handleAutoExtractImage() {
    runAutoExtract(false);
  }

  // Pulls the running per-project total out of the same API responses that
  // already carry the global total (every cost-cap route now returns
  // project_total_cost_usd and, when blocked, cap_type) -- keeps the header's
  // per-project figure live without a separate fetch, and remembers which
  // cap tripped so the banner below can tell the analyst which one to ask
  // about, instead of only ever blaming the global cap.
  function trackCost(body: { project_total_cost_usd?: number; cap_type?: "project" | "global" }) {
    if (typeof body.project_total_cost_usd === "number") setLiveProjectCost(body.project_total_cost_usd);
    if (body.cap_type) setCostCapReason(body.cap_type);
  }

  function recordCall(modelUsed: string, usage: { input_tokens: number; output_tokens: number; cost_usd: number; latency_ms?: number }) {
    setCalls((prev) => [
      ...prev,
      {
        model: modelUsed,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cost_usd: usage.cost_usd,
        latency_ms: usage.latency_ms ?? 0,
        timestamp: new Date().toISOString(),
      },
    ]);
  }

  // Candidate board (Epic 4): auto-identify, then the analyst selects which
  // candidates to actually process -- see components/review/CandidateBoard.tsx.
  async function handleIdentifyCandidates() {
    if (!currentImage) return;
    setIdentifying(true);
    setError("");
    try {
      const res = await fetch("/api/identify-candidates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: project.id, image_id: currentImage.id, model: autoExtractModel }),
      });
      const body = await res.json();
      if (!res.ok) {
        trackCost(body);
        if (body.cost_limit_reached) setCostExhausted(true);
        throw new Error(body.error ?? "Identifying products failed");
      }
      if (typeof body.global_total_cost_usd === "number") {
        setLiveCost(body.global_total_cost_usd);
        if (body.global_total_cost_usd >= body.cost_limit_usd) setCostExhausted(true);
      }
      trackCost(body);
      if (body.model_used && body.usage) recordCall(body.model_used, body.usage);
      setProducts((prev) => [...prev, ...body.products]);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Identifying products failed");
    } finally {
      setIdentifying(false);
    }
  }

  function handleCandidateNotesChange(id: string, notes: string) {
    setProducts((prev) => prev.map((p) => (p.id === id ? { ...p, analyst_notes: notes } : p)));
  }

  function handleCandidateAdded(product: ProductRow) {
    setProducts((prev) => [...prev, product]);
  }

  function handleCandidateBoxChange(id: string, box: BoundingBox) {
    setProducts((prev) => prev.map((p) => (p.id === id ? { ...p, box_json: box } : p)));
  }

  // Edits a field on an already-processed candidate right from the board's
  // summary panel -- same PATCH route Finish Review uses (promotes draft to
  // confirmed on touch), so the analyst never has to leave this screen to
  // see or correct what the model pulled.
  function handleCandidateFieldEdit(id: string, key: string, value: string) {
    setProducts((prev) =>
      prev.map((p) =>
        p.id === id
          ? { ...p, fields: { ...p.fields, [key]: value }, field_sources: { ...p.field_sources, [key]: "analyst" }, status: "confirmed" }
          : p
      )
    );
    fetch(`/api/products/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value }),
    }).catch(() => setError("Failed to save the edit -- try again."));
  }

  // Copies one field's value across every other already-processed candidate
  // on the current image in one action (e.g. "Country of Store Check" is
  // almost always identical for every product in one shelf photo) -- a real
  // undo matters here specifically because it's a multi-row mutation, unlike
  // a single-field edit which is already low-risk and visibly reversible by
  // just typing over it again.
  function handleBulkFieldApply(ids: string[], key: string, value: string) {
    if (ids.length === 0) return;
    const previous = ids.map((id) => ({ id, prevValue: products.find((p) => p.id === id)?.fields[key] ?? null }));
    for (const id of ids) handleCandidateFieldEdit(id, key, value);
    toast.success(`Applied to ${ids.length} product${ids.length === 1 ? "" : "s"} on this image`, 6000, {
      label: "Undo",
      onClick: () => {
        for (const { id, prevValue } of previous) handleCandidateFieldEdit(id, key, prevValue ?? "");
      },
    });
  }

  // Removing a candidate is destructive (and, before this, had zero undo
  // anywhere in the review workspace) -- so the DELETE itself is deferred: the
  // row disappears from the UI immediately, but the actual API call only
  // fires after the toast's grace period, unless Undo cancels the timer
  // first. If undone, the DB row was never touched at all.
  const pendingDeleteTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  function handleRemoveCandidate(id: string) {
    const removed = products.find((p) => p.id === id);
    if (!removed) return;
    setProducts((prev) => prev.filter((p) => p.id !== id));
    setSelectedOrder((prev) => prev.filter((x) => x !== id));
    const timer = setTimeout(() => {
      delete pendingDeleteTimers.current[id];
      fetch(`/api/products/${id}`, { method: "DELETE" }).catch(() => {
        setProducts((prev) => [...prev, removed]);
        setError("Failed to remove the candidate -- it has been restored.");
      });
    }, 6000);
    pendingDeleteTimers.current[id] = timer;
    toast.info(`Removed "${removed.candidate_name ?? "candidate"}"`, 6000, {
      label: "Undo",
      onClick: () => {
        const t = pendingDeleteTimers.current[id];
        if (t) {
          clearTimeout(t);
          delete pendingDeleteTimers.current[id];
        }
        setProducts((prev) => [...prev, removed]);
      },
    });
  }

  // Selection + processing are lifted up here (not owned by CandidateBoard)
  // for two reasons: they must survive switching images -- CandidateBoard
  // remounts per image (key={currentImage.id}) and would otherwise lose
  // both -- and processing is genuinely global, not scoped to "whichever
  // image is on screen": the analyst can mark candidates across several
  // images, then run one batch over all of them, same as the original
  // "mark everything, then batch process" workflow.
  const [selectedOrder, setSelectedOrder] = useState<string[]>([]);
  const [candidateItemStatus, setCandidateItemStatus] = useState<Record<string, CandidateItemStatus>>({});
  const [candidateProcessing, setCandidateProcessing] = useState(false);
  const selectedCandidateIds = useMemo(() => new Set(selectedOrder), [selectedOrder]);
  const selectionIndex = useMemo(() => new Map(selectedOrder.map((id, i) => [id, i + 1])), [selectedOrder]);

  function handleToggleCandidateSelect(id: string) {
    setSelectedOrder((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  const CANDIDATE_CONCURRENCY = 3;
  async function handleProcessSelectedCandidates() {
    const ids = [...selectedOrder];
    if (ids.length === 0) return;
    setCandidateProcessing(true);
    setError("");
    setCandidateItemStatus((prev) => {
      const next = { ...prev };
      for (const id of ids) next[id] = "pending";
      return next;
    });

    // capHit only stops the NEXT item each worker would pick up -- it can't
    // retroactively cancel a call already in flight when the cap trips (the
    // server bills on receipt, so a client-side abort wouldn't un-spend it
    // anyway). Worst case, up to CANDIDATE_CONCURRENCY-1 calls that were
    // already dispatched complete after the cap is detected -- bounded and
    // accepted, not a bug to chase further.
    let cursor = 0;
    let capHit = false;
    let succeededCount = 0;
    let failedCount = 0;
    async function runNext(): Promise<void> {
      while (true) {
        const i = cursor;
        cursor += 1;
        if (i >= ids.length || capHit) return;
        const id = ids[i];
        setCandidateItemStatus((prev) => ({ ...prev, [id]: "running" }));
        try {
          const res = await fetch(`/api/products/${id}/extract-candidate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: autoExtractModel }),
          });
          const body = await res.json();
          if (typeof body.global_total_cost_usd === "number") {
            setLiveCost(body.global_total_cost_usd);
            if (body.global_total_cost_usd >= body.cost_limit_usd) setCostExhausted(true);
          }
          trackCost(body);
          if (!res.ok) {
            if (body.cost_limit_reached) {
              capHit = true;
              setCostExhausted(true);
            }
            failedCount += 1;
            setCandidateItemStatus((prev) => ({ ...prev, [id]: "failed" }));
            continue;
          }
          if (body.usage && body.product?.model_used) recordCall(body.product.model_used, body.usage);
          succeededCount += 1;
          setCandidateItemStatus((prev) => ({ ...prev, [id]: "succeeded" }));
          setProducts((prev) => prev.map((p) => (p.id === id ? body.product : p)));
        } catch {
          failedCount += 1;
          setCandidateItemStatus((prev) => ({ ...prev, [id]: "failed" }));
        }
      }
    }
    await Promise.all(Array.from({ length: CANDIDATE_CONCURRENCY }, runNext));
    if (capHit) setError("Cost cap reached mid-batch -- remaining items were not processed.");
    setSelectedOrder([]);
    setCandidateProcessing(false);
    // notify() also fires a real browser Notification if the analyst opted
    // in AND this tab is hidden -- the whole point of surfacing this for a
    // batch specifically, since this is the one action in the app genuinely
    // long-running enough to plausibly switch away from mid-run.
    toast.notify(
      "Batch processing finished",
      `${succeededCount} processed${failedCount > 0 ? `, ${failedCount} failed` : ""}${capHit ? " -- cost cap reached" : ""}`,
      failedCount > 0 || capHit ? "error" : "success"
    );
  }

  async function callExtractApi(blob: Blob, notes?: string) {
    const formData = new FormData();
    formData.append("project_id", project.id);
    formData.append("model", model);
    formData.append("crop", blob, "crop.jpg");
    if (notes?.trim()) formData.append("analyst_notes", notes.trim());
    const res = await fetch("/api/extract", { method: "POST", body: formData });
    const body = await res.json();
    if (!res.ok) {
      trackCost(body);
      if (body.cost_limit_reached) setCostExhausted(true);
      // Tag the error rather than relying on the batch runner matching the
      // server's exact message text (that string drifted once already --
      // the real text is "Global cost cap reached...", not "Cost limit
      // reached...", so the old check silently never fired).
      throw Object.assign(new Error(body.error ?? "Extraction failed"), { costLimitReached: !!body.cost_limit_reached });
    }
    if (typeof body.global_total_cost_usd === "number") {
      setLiveCost(body.global_total_cost_usd);
      if (body.global_total_cost_usd >= body.cost_limit_usd) setCostExhausted(true);
    }
    trackCost(body);
    if (body.usage) {
      setCalls((prev) => [
        ...prev,
        {
          model: body.model_used,
          input_tokens: body.usage.input_tokens,
          output_tokens: body.usage.output_tokens,
          cost_usd: body.usage.cost_usd,
          latency_ms: body.usage.latency_ms,
          timestamp: new Date().toISOString(),
        },
      ]);
    }
    return body as { fields: Record<string, unknown>; model_used: string };
  }

  // The model doesn't reliably output every field as a JSON string -- a
  // percentage or yes/no can come back as a bare number/boolean (0, false),
  // which is falsy in JS and trips every truthy "is this filled" check
  // downstream (FieldForm's missing-field indicator, product labels, etc.),
  // wrongly treating a legitimate "0%" or "No" as not-yet-filled.
  function normalizeFields(raw: Record<string, unknown>): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(raw)) {
      out[k] = v == null || v === "" ? null : String(v);
    }
    return out;
  }

  async function handleExtract(blob: Blob, box: BoundingBox, notes: string) {
    if (!currentImage) return;
    setExtracting(true);
    setError("");
    setCropBlob(blob);
    setEditingProductId(null);
    setPendingBox(box);
    try {
      const body = await callExtractApi(blob, notes);
      const { in_scope, confidence_score, reason, ...rest } = body.fields;
      setMeta({ in_scope: !!in_scope, confidence_score: (confidence_score as number) ?? null, reason: (reason as string) ?? null });
      setFields(normalizeFields(rest));
      setEditedKeys(new Set());
      setModelUsed(body.model_used);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Extraction failed");
    } finally {
      setExtracting(false);
    }
  }

  function handleDiscard() {
    resetForm();
  }

  function handleAddToQueue(blob: Blob, box: BoundingBox, notes: string) {
    if (!currentImage) return;
    setQueue((prev) => [
      ...prev,
      { id: crypto.randomUUID(), blob, box, imageId: currentImage.id, imageName: currentImage.file_name, notes },
    ]);
  }

  function handleRemoveFromQueue(id: string) {
    setQueue((prev) => prev.filter((q) => q.id !== id));
  }

  // Loads one batch result into the same top-level fields/meta/cropBlob
  // state a live single extraction uses -- so the existing FieldForm and
  // handleConfirm work unchanged, and the main image follows along with
  // whichever result is currently under review.
  function loadBatchItem(list: BatchResult[], index: number) {
    const item = list[index];
    if (!item) {
      setBatchResults([]);
      setBatchReviewIndex(-1);
      resetForm();
      return;
    }
    setCurrentImageId(item.imageId);
    setFields(item.fields);
    setMeta(item.meta);
    setModelUsed(item.modelUsed);
    setCropBlob(item.cropBlob);
    setPendingBox(item.box);
    setEditingProductId(null);
    setEditedKeys(new Set());
    setBatchReviewIndex(index);
  }

  async function handleRunQueue() {
    if (queue.length === 0) return;
    setBatchRunning(true);
    setBatchMessage("");
    setError("");
    const items = [...queue];
    const CONCURRENCY = 3;
    const results: (BatchResult | null)[] = new Array(items.length).fill(null);
    let cursor = 0;
    let capHit = false;
    let doneCount = 0;

    async function runNext(): Promise<void> {
      while (true) {
        const i = cursor;
        cursor += 1;
        if (i >= items.length || capHit) return;
        const item = items[i];
        try {
          const result = await callExtractApi(item.blob, item.notes);
          const { in_scope, confidence_score, reason, ...rest } = result.fields;
          results[i] = {
            id: item.id,
            imageId: item.imageId,
            imageName: item.imageName,
            cropBlob: item.blob,
            box: item.box,
            fields: normalizeFields(rest),
            meta: { in_scope: !!in_scope, confidence_score: (confidence_score as number) ?? null, reason: (reason as string) ?? null },
            modelUsed: result.model_used,
          };
        } catch (err: unknown) {
          if (err instanceof Error && (err as Error & { costLimitReached?: boolean }).costLimitReached) capHit = true;
        } finally {
          doneCount += 1;
          setBatchProgress({ done: doneCount, total: items.length });
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, runNext));

    const succeeded = results.filter((r): r is BatchResult => r !== null);
    const failedCount = items.length - succeeded.length;
    if (failedCount > 0) {
      setBatchMessage(
        capHit
          ? `Stopped early: cost cap reached. ${succeeded.length} of ${items.length} extracted.`
          : `${failedCount} of ${items.length} items failed to extract and were skipped.`
      );
    }

    setQueue([]);
    setBatchRunning(false);
    setBatchProgress(null);

    if (succeeded.length > 0) {
      setBatchResults(succeeded);
      loadBatchItem(succeeded, 0);
    }
  }

  async function handleConfirm() {
    if (!currentImage || !cropBlob) return;
    setConfirming(true);
    try {
      const formData = new FormData();
      formData.append("project_id", project.id);
      formData.append("image_id", currentImage.id);
      formData.append("model_used", modelUsed ?? "unknown");
      formData.append("fields", JSON.stringify(fields));
      formData.append("edited_keys", JSON.stringify(Array.from(editedKeys)));
      if (pendingBox) formData.append("box_json", JSON.stringify(pendingBox));
      formData.append("crop", cropBlob, "crop.jpg");
      const res = await fetch("/api/products", { method: "POST", body: formData });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Save failed");

      setProducts((prev) => [...prev, body.product]);
      setImages((prev) => prev.map((i) => (i.id === currentImage.id ? { ...i, is_reviewed: true } : i)));

      if (inBatchReview) {
        loadBatchItem(batchResults, batchReviewIndex + 1);
      } else {
        resetForm();
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setConfirming(false);
    }
  }

  function handleSkipBatchItem() {
    if (!inBatchReview) return;
    loadBatchItem(batchResults, batchReviewIndex + 1);
  }

  // Clicking a product already confirmed on this image loads it back into
  // the same field form for editing, and highlights where it was cropped
  // from so the analyst can see exactly what they're looking at.
  function handleSelectConfirmed(p: ProductRow) {
    if (extracting || confirming || batchRunning || inBatchReview) return;
    setEditingProductId(p.id);
    setFields(p.fields);
    setMeta(null);
    setModelUsed(p.model_used);
    setCropBlob(null);
    setPendingBox(p.box_json);
    setEditedKeys(
      new Set(Object.keys(p.field_sources).filter((k) => p.field_sources[k] === "analyst"))
    );
    setError("");
  }

  function handleCancelEdit() {
    resetForm();
  }

  async function handleSaveEdit() {
    if (!editingProductId) return;
    setConfirming(true);
    try {
      const res = await fetch(`/api/products/${editingProductId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields, edited_keys: Array.from(editedKeys) }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Save failed");
      setProducts((prev) => prev.map((p) => (p.id === editingProductId ? body.product : p)));
      resetForm();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setConfirming(false);
    }
  }

  return (
    <div className="h-screen flex flex-col bg-background">
      <TopNav
        crumbs={[
          { label: project.name, href: `/projects/${project.id}` },
          { label: store.name, href: `/projects/${project.id}` },
          { label: "Review" },
        ]}
      >
        <p className="text-[10px] text-muted whitespace-nowrap">
          {products.filter((p) => p.status === "confirmed").length} confirmed
          {products.some((p) => p.status === "draft") && `, ${products.filter((p) => p.status === "draft").length} drafts awaiting review`}
          {" · "}
          {images.filter((i) => i.is_reviewed).length}/{images.length} images reviewed
        </p>
        {selectedOrder.length > 0 && (
          <p className="text-[10px] font-semibold text-teal whitespace-nowrap">
            {selectedOrder.length} selected for processing
          </p>
        )}
        <CostTracker calls={calls} />
        {hasProjectLimit && (
          <p className={`text-[10px] whitespace-nowrap ${costCapReason === "project" ? "text-red font-semibold" : "text-muted"}`}>
            ${liveProjectCost.toFixed(2)} / ${project.cost_limit_usd.toFixed(2)} this project
          </p>
        )}
        <p className={`text-[10px] whitespace-nowrap ${costExhausted ? "text-red font-semibold" : "text-muted"}`}>
          ${liveCost.toFixed(2)} / ${GLOBAL_COST_LIMIT_USD.toFixed(2)} total cap (all projects)
        </p>
        <Link
          href={`/projects/${project.id}/stores/${store.id}/finish`}
          className="px-3 py-1.5 rounded-lg bg-navy text-white text-xs font-semibold cursor-pointer hover:bg-[#0D2D55] transition-colors whitespace-nowrap"
        >
          Finish Review →
        </Link>
      </TopNav>

      <div className="flex items-center justify-between px-5 py-2 border-b border-border bg-surface flex-shrink-0">
        <div className="flex items-center gap-2">
          <button
            onClick={() => goToOffset(-1)}
            disabled={currentIndex <= 0 || navLocked}
            className="flex items-center gap-1 text-xs font-semibold text-navy cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed hover:underline"
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Prev
          </button>
          <span className="text-[10px] text-muted">
            {currentIndex + 1} / {orderedImages.length}
          </span>
          <button
            onClick={() => goToOffset(1)}
            disabled={currentIndex === -1 || currentIndex >= orderedImages.length - 1 || navLocked}
            className="flex items-center gap-1 text-xs font-semibold text-navy cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed hover:underline"
          >
            Next <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
        {currentImage && (
          <div className="flex items-center gap-2">
            {autoExtractMessage && <p className="text-[10px] text-muted max-w-xs truncate">{autoExtractMessage}</p>}
            <select
              value={autoExtractModel}
              onChange={(e) => setAutoExtractModel(e.target.value as ExtractionModel)}
              disabled={autoExtracting || navLocked}
              className="text-[10px] border border-border rounded px-1.5 py-1 cursor-pointer bg-white disabled:opacity-60"
            >
              <option value="claude-haiku">Haiku</option>
              <option value="claude-sonnet">Sonnet</option>
              <option value="claude-opus">Opus</option>
            </select>
            <button
              onClick={() => handleAutoExtractImage()}
              disabled={autoExtracting || navLocked || costExhausted}
              title="Read the whole image in one call and get a draft row per product -- faster than boxing each one, review happens in Finish Review"
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#3D5A80] text-white text-[11px] font-semibold cursor-pointer hover:bg-[#2E4766] disabled:opacity-60 transition-colors"
            >
              {autoExtracting ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
              {autoExtracting ? "Reading whole image…" : "Auto-Extract Whole Image"}
            </button>
          </div>
        )}
        {allReviewed && (
          <span className="flex items-center gap-1.5 text-xs font-semibold text-[#1ABC9C]">
            <PartyPopper className="h-3.5 w-3.5" /> All images reviewed — ready for Finish Review
          </span>
        )}
      </div>

      {costExhausted && (
        <div className="flex items-center gap-2 px-5 py-2 bg-[#FADBD8] border-b border-[#C0392B] flex-shrink-0">
          <AlertCircle className="h-4 w-4 text-red flex-shrink-0" />
          <p className="text-xs text-[#922B21]">
            {costCapReason === "project"
              ? `This project's $${project.cost_limit_usd.toFixed(2)} budget is used up — extraction is paused for this project.`
              : `Global cost cap ($${GLOBAL_COST_LIMIT_USD.toFixed(2)}, across every project) reached — extraction is paused.`}{" "}
            You can still edit and confirm anything already extracted.
          </p>
        </div>
      )}

      {queue.length > 0 && (
        <div className="border-b border-border bg-[#EBF5FB] px-5 py-2.5 flex-shrink-0">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-navy">
              Queue: {queue.length} item{queue.length === 1 ? "" : "s"} staged for batch extraction
              {batchProgress && ` — running ${batchProgress.done}/${batchProgress.total}`}
            </p>
            <div className="flex items-center gap-3">
              <button
                onClick={handleRunQueue}
                disabled={batchRunning || costExhausted}
                className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-navy text-white text-xs font-semibold cursor-pointer hover:bg-[#0D2D55] disabled:opacity-60 transition-colors"
              >
                <Play className="h-3 w-3" /> {batchRunning ? "Running…" : `Run All (${queue.length})`}
              </button>
              {!batchRunning && (
                <button onClick={() => setQueue([])} className="text-xs text-muted hover:text-red cursor-pointer">
                  Clear
                </button>
              )}
            </div>
          </div>
          {batchMessage && <p className="text-[10px] text-[#B7791F] mt-1">{batchMessage}</p>}
          <div className="flex flex-wrap gap-1.5 mt-2">
            {queue.map((q) => (
              <span
                key={q.id}
                className="flex items-center gap-1 text-[10px] bg-white border border-border rounded-full px-2 py-0.5"
              >
                {q.imageName}
                {!batchRunning && (
                  <button onClick={() => handleRemoveFromQueue(q.id)} className="text-muted hover:text-red cursor-pointer">
                    <X className="h-2.5 w-2.5" />
                  </button>
                )}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        {/* Left sidebar */}
        <div className="w-56 border-r border-border bg-surface overflow-y-auto flex-shrink-0">
          {Object.entries(grouped).map(([type, imgs]) => (
            <div key={type} className="px-3 py-2">
              <p className="text-[10px] font-bold text-muted uppercase tracking-widest mb-1.5 px-1">
                {TYPE_LABEL[type] ?? "Unclassified"}
              </p>
              {imgs.map((img) => {
                const imgProducts = products.filter((p) => p.image_id === img.id);
                const confirmedCount = imgProducts.filter((p) => p.status === "confirmed").length;
                const draftCount = imgProducts.filter((p) => p.status === "draft").length;
                const selectedPendingCount = imgProducts.filter(
                  (p) => p.status === "candidate" && selectedCandidateIds.has(p.id)
                ).length;
                return (
                  <button
                    key={img.id}
                    onClick={() => selectImage(img.id)}
                    disabled={navLocked}
                    className={`w-full flex items-center justify-between text-left px-2 py-1.5 rounded-lg text-xs cursor-pointer mb-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                      img.id === currentImageId ? "bg-navy text-white" : "hover:bg-background text-text"
                    }`}
                  >
                    <span className="truncate">{img.file_name}</span>
                    <span className="flex items-center gap-1 flex-shrink-0 ml-1">
                      {selectedPendingCount > 0 && (
                        <span className="text-[9px] font-semibold px-1 rounded-full bg-teal text-white" title="Selected for processing on this image">
                          {selectedPendingCount}
                        </span>
                      )}
                      {draftCount > 0 && (
                        <span className="text-[9px] font-semibold px-1 rounded-full bg-[#3D5A80] text-white" title="Auto-extracted drafts awaiting review">
                          {draftCount}
                        </span>
                      )}
                      {confirmedCount > 0 && <span className="text-[9px] opacity-80">{confirmedCount}</span>}
                      {img.is_reviewed && <CheckCircle2 className="h-3 w-3 text-teal flex-shrink-0" />}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Center + right: candidate board for shelf images (auto-identify,
            select, annotate, batch-process -- Epic 4), the original
            box-draw-one-product flow for everything else (storefront/aisle
            overview shots don't have "candidates" to identify). */}
        {currentImage && currentImage.image_type === "shelf" ? (
          <CandidateBoard
            key={currentImage.id}
            projectId={project.id}
            imageUrl={publicUrl(currentImage.storage_path)}
            imageId={currentImage.id}
            candidates={currentImageProducts}
            schema={project.schema_json}
            model={autoExtractModel}
            identifying={identifying}
            onIdentify={handleIdentifyCandidates}
            onNotesChange={handleCandidateNotesChange}
            onCandidateAdded={handleCandidateAdded}
            onBoxChange={handleCandidateBoxChange}
            onFieldEdit={handleCandidateFieldEdit}
            onBulkFieldApply={handleBulkFieldApply}
            onRemoveCandidate={handleRemoveCandidate}
            selectedIds={selectedCandidateIds}
            selectionIndex={selectionIndex}
            onToggleSelect={handleToggleCandidateSelect}
            itemStatus={candidateItemStatus}
            processing={candidateProcessing}
            onProcessSelected={handleProcessSelectedCandidates}
            costExhausted={costExhausted}
            finishHref={`/projects/${project.id}/stores/${store.id}/finish`}
            disabled={navLocked}
          />
        ) : currentImage ? (
          <>
            <BoxDrawTool
              key={currentImage.id}
              imageUrl={publicUrl(currentImage.storage_path)}
              model={model}
              onModelChange={setModel}
              onExtract={handleExtract}
              notes={boxDrawNotes}
              onNotesChange={setBoxDrawNotes}
              extracting={extracting}
              extractDisabled={costExhausted || inBatchReview || confirming || skipping || batchRunning || queue.length > 0 || autoExtracting}
              onSkip={handleSkip}
              skipping={skipping}
              skipDisabled={navLocked}
              onQueue={handleAddToQueue}
              queueDisabled={extracting || confirming || skipping || batchRunning || inBatchReview || costExhausted || autoExtracting}
              highlightBox={pendingBox}
            />
            <div className="w-96 border-l border-border bg-surface flex flex-col flex-shrink-0">
          {error && <p className="text-xs text-red px-4 pt-3">{error}</p>}
          {inBatchReview && (
            <div className="flex items-center justify-between px-4 py-2 bg-[#EBF5FB] border-b border-border flex-shrink-0">
              <p className="text-xs font-semibold text-navy">
                Reviewing {batchReviewIndex + 1} of {batchResults.length} — from {batchResults[batchReviewIndex]?.imageName}
              </p>
              <button
                onClick={handleSkipBatchItem}
                disabled={confirming}
                className="flex items-center gap-1 text-[10px] font-semibold text-muted hover:text-red cursor-pointer disabled:opacity-60"
                title="Discard this result without saving it"
              >
                <SkipForward className="h-3 w-3" /> Skip (do not save)
              </button>
            </div>
          )}
          {editingProductId && (
            <div className="flex items-center px-4 py-2 bg-[#FDEBD0] border-b border-border flex-shrink-0">
              <p className="text-xs font-semibold text-[#9C640C]">Editing a confirmed product — its crop is highlighted on the image</p>
            </div>
          )}
          <FieldForm
            schema={project.schema_json}
            fields={fields}
            meta={meta}
            modelUsed={modelUsed}
            onFieldsChange={(f, e) => {
              setFields(f);
              setEditedKeys(e);
            }}
            onConfirm={editingProductId ? handleSaveEdit : handleConfirm}
            confirming={confirming}
            confirmLabel={editingProductId ? "Save Changes" : "Confirm & Add Product"}
            onSecondary={editingProductId ? handleCancelEdit : inBatchReview ? undefined : handleDiscard}
            secondaryLabel={editingProductId ? "Cancel" : "Clear"}
          />
          {currentProducts.length > 0 && (
            <div className="border-t border-border px-4 py-2 flex-shrink-0 max-h-32 overflow-y-auto">
              <p className="text-[10px] font-bold text-muted uppercase tracking-widest mb-1">
                Confirmed on this image ({currentProducts.length})
              </p>
              {currentProducts.map((p) => (
                <div
                  key={p.id}
                  onClick={() => handleSelectConfirmed(p)}
                  className={`flex items-center justify-between gap-2 py-1 px-1.5 -mx-1.5 rounded cursor-pointer transition-colors ${
                    p.id === editingProductId ? "bg-[#FDEBD0]" : "hover:bg-background"
                  }`}
                >
                  <p className="text-[10px] text-text truncate">{productLabel(p)}</p>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRemoveProduct(p.id);
                    }}
                    className="text-muted hover:text-red cursor-pointer flex-shrink-0"
                    title="Remove"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-muted">No images</div>
        )}
      </div>

      <ConfirmDialog
        open={confirmReRunExtract}
        onClose={() => {
          setConfirmReRunExtract(false);
          setAutoExtractMessage("Skipped -- already auto-extracted once.");
        }}
        onConfirm={() => {
          setConfirmReRunExtract(false);
          runAutoExtract(true);
        }}
        title="Run auto-extract again?"
        description="This image was already auto-extracted. Running it again adds more drafts on top of the existing ones and calls the paid model again."
        confirmLabel="Run Again"
      />
    </div>
  );
}
