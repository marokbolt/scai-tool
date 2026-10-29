"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles, RefreshCw, Play, Check, X as XIcon, AlertCircle, SquarePlus, ArrowRight, Copy, Trash2 } from "lucide-react";
import type { ProductRow, BoundingBox, SchemaColumn } from "@/lib/types";
import type { ExtractionModel } from "./BoxDrawTool";
import { estimateCandidateExtractionCost, estimateIdentificationCost } from "@/lib/pricing";

export type CandidateItemStatus = "idle" | "pending" | "running" | "succeeded" | "failed";

interface Props {
  projectId: string;
  imageUrl: string;
  imageId: string;
  candidates: ProductRow[];
  schema: SchemaColumn[];
  model: ExtractionModel;
  identifying: boolean;
  onIdentify: () => void;
  onNotesChange: (id: string, notes: string) => void;
  onCandidateAdded: (product: ProductRow) => void;
  onBoxChange: (id: string, box: BoundingBox) => void;
  onFieldEdit: (id: string, key: string, value: string) => void;
  onBulkFieldApply: (ids: string[], key: string, value: string) => void;
  onRemoveCandidate: (id: string) => void;
  selectedIds: Set<string>;
  selectionIndex: Map<string, number>;
  onToggleSelect: (id: string) => void;
  itemStatus: Record<string, CandidateItemStatus>;
  processing: boolean;
  onProcessSelected: () => void;
  costExhausted: boolean;
  finishHref: string;
  disabled: boolean;
}

// Same three-tier confidence legend FinishWorkspace uses, mapped onto the
// existing Excel-export color tokens -- a product's confidence reads the
// same way everywhere in the app, not as a one-off color pick here.
function confidenceTier(score: number | null): "high" | "low" | "missing" | null {
  if (score == null) return null;
  if (score >= 0.8) return "high";
  if (score >= 0.6) return "low";
  return "missing";
}
const CONFIDENCE_BORDER: Record<"high" | "low" | "missing", string> = {
  high: "border-state-ai-high-text bg-state-ai-high-fill/20",
  low: "border-state-low-conf-text bg-state-low-conf-fill/20",
  missing: "border-state-missing-text bg-state-missing-fill/20",
};
const CONFIDENCE_BADGE: Record<"high" | "low" | "missing", string> = {
  high: "bg-state-ai-high-text",
  low: "bg-state-low-conf-text",
  missing: "bg-state-missing-text",
};

const HANDLES = ["nw", "ne", "sw", "se"] as const;
type Handle = (typeof HANDLES)[number];

type DragState =
  | { type: "move"; id: string; startBox: BoundingBox; startClientX: number; startClientY: number; moved: boolean }
  | { type: "resize"; id: string; handle: Handle; startBox: BoundingBox; startClientX: number; startClientY: number; moved: boolean }
  | { type: "draw"; startClientX: number; startClientY: number; startBox: BoundingBox; moved: boolean };

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

// Select/deselect + dim is the CVAT "dual opacity" mechanic (research: unselected
// shapes ~15-20% opacity, selected ~60-100% + thicker border, 150-200ms
// transition) -- documented, directly implementable, not a vague "make others
// fade" guess. Resize/move/draw below exist because the model's own position is
// a click-target estimate, not a measurement -- the analyst tightens it or adds
// what the model missed before spending money processing it.
export function CandidateBoard({
  projectId,
  imageUrl,
  imageId,
  candidates,
  schema,
  model,
  identifying,
  onIdentify,
  onNotesChange,
  onCandidateAdded,
  onBoxChange,
  onFieldEdit,
  onBulkFieldApply,
  onRemoveCandidate,
  selectedIds,
  selectionIndex,
  onToggleSelect,
  itemStatus,
  processing,
  onProcessSelected,
  costExhausted,
  finishHref,
  disabled,
}: Props) {
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [notesDraft, setNotesDraft] = useState("");
  const [error, setError] = useState("");
  const [drawMode, setDrawMode] = useState(false);
  // The in-progress drag/resize/draw gesture lives in a REF, not state.
  // Found by hand-testing: React 18 Strict Mode (dev only) double-invokes a
  // setState functional updater, and the first version of this put the
  // pointerup side effects (API calls, select-toggling) inside one -- so a
  // single click fired toggleSelect twice (select, then immediately
  // deselect again), which looked like clicking silently did nothing. A ref
  // isn't subject to that double-invoke, and the only thing that needs to
  // trigger a re-render during a drag is the live box preview, which is
  // already its own state.
  const dragRef = useRef<DragState | null>(null);
  const [liveBox, setLiveBox] = useState<BoundingBox | null>(null);
  // Mirrors liveBox purely so handlePointerUp (attached imperatively, not
  // re-created per render) can read its final value without closing over a
  // stale one.
  const liveBoxRef = useRef<BoundingBox | null>(null);
  liveBoxRef.current = liveBox;
  const [addingCrop, setAddingCrop] = useState(false);
  const notesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Candidates/callbacks change across renders; handlePointerUp is attached
  // imperatively (not via a useEffect keyed on a dependency array) so it
  // must read the latest values through a ref instead of closing over
  // possibly-stale ones from whenever the drag started.
  const latestRef = useRef({ candidates, onBoxChange, onCandidateAdded, projectId, imageId });
  latestRef.current = { candidates, onBoxChange, onCandidateAdded, projectId, imageId };

  const pendingCandidates = candidates.filter((c) => c.status === "candidate");
  const lowConfidenceCount = candidates.filter(
    (c) => c.status !== "candidate" && confidenceTier(c.confidence_score) !== "high" && confidenceTier(c.confidence_score) !== null
  ).length;
  const hasSelection = selectedIds.size > 0;
  const identifyCostEstimate = estimateIdentificationCost(model);
  const processEstimate = estimateCandidateExtractionCost(model, selectedIds.size);
  const focused = candidates.find((c) => c.id === focusedId) ?? null;

  useEffect(() => {
    // New image -- reset local interaction state only. Selection and
    // processing status are lifted up to ReviewWorkspace and are
    // intentionally global, so they must survive switching images.
    setFocusedId(null);
    setError("");
    setDrawMode(false);
    endDrag();
    setLiveBox(null);
  }, [imageId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (focused) setNotesDraft(focused.analyst_notes ?? "");
  }, [focused?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard-driven review -- named as a target pattern in this app's own
  // UX research (Epic 2.3) but never actually wired in until now. Disabled
  // while typing in the notes textarea or a field input so shortcuts don't
  // fight with normal text entry; Escape still works there (blurs first).
  useEffect(() => {
    function isTypingTarget(el: Element | null) {
      return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        (document.activeElement as HTMLElement | null)?.blur?.();
        setFocusedId(null);
        return;
      }
      if (isTypingTarget(document.activeElement) || processing || disabled) return;
      if (e.key === " " && focused && focused.status === "candidate") {
        e.preventDefault();
        onToggleSelect(focused.id);
      } else if (e.key === "Enter" && selectedIds.size > 0 && !costExhausted) {
        e.preventDefault();
        onProcessSelected();
      } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        if (candidates.length === 0) return;
        e.preventDefault();
        const currentIndex = focusedId ? candidates.findIndex((c) => c.id === focusedId) : -1;
        const delta = e.key === "ArrowRight" ? 1 : -1;
        const nextIndex = currentIndex === -1 ? 0 : (currentIndex + delta + candidates.length) % candidates.length;
        setFocusedId(candidates[nextIndex].id);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [focused, focusedId, candidates, selectedIds, processing, disabled, costExhausted, onToggleSelect, onProcessSelected]);

  function toggleSelect(c: ProductRow) {
    if (c.status !== "candidate" || processing) return;
    setFocusedId(c.id);
    onToggleSelect(c.id);
  }

  function pctFromClient(clientX: number, clientY: number) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: ((clientX - rect.left) / rect.width) * 100, y: ((clientY - rect.top) / rect.height) * 100 };
  }

  function endDrag() {
    dragRef.current = null;
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
  }

  // Drag math lives in percentage-of-image units throughout (the same units
  // box_json is already stored in), so no pixel<->percent conversion drift
  // between what's dragged and what's saved. Mutates dragRef.current.moved
  // directly -- it's a plain ref object, not React state, so there's nothing
  // wrong with updating it in place.
  function handlePointerMove(e: PointerEvent) {
    const current = dragRef.current;
    if (!current) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const dxPct = ((e.clientX - current.startClientX) / rect.width) * 100;
    const dyPct = ((e.clientY - current.startClientY) / rect.height) * 100;
    if (Math.abs(dxPct) > 1 || Math.abs(dyPct) > 1) current.moved = true;

    if (current.type === "move") {
      const { startBox } = current;
      setLiveBox({
        x: clamp(startBox.x + dxPct, 0, 100 - startBox.width),
        y: clamp(startBox.y + dyPct, 0, 100 - startBox.height),
        width: startBox.width,
        height: startBox.height,
      });
      return;
    }
    if (current.type === "resize") {
      const { startBox, handle } = current;
      let { x, y, width, height } = startBox;
      if (handle.includes("w")) {
        x = clamp(startBox.x + dxPct, 0, startBox.x + startBox.width - 2);
        width = startBox.x + startBox.width - x;
      } else {
        width = clamp(startBox.width + dxPct, 2, 100 - startBox.x);
      }
      if (handle.includes("n")) {
        y = clamp(startBox.y + dyPct, 0, startBox.y + startBox.height - 2);
        height = startBox.y + startBox.height - y;
      } else {
        height = clamp(startBox.height + dyPct, 2, 100 - startBox.y);
      }
      setLiveBox({ x, y, width, height });
      return;
    }
    // draw
    const now = pctFromClient(e.clientX, e.clientY);
    const startPct = pctFromClient(current.startClientX, current.startClientY);
    setLiveBox({
      x: clamp(Math.min(startPct.x, now.x), 0, 100),
      y: clamp(Math.min(startPct.y, now.y), 0, 100),
      width: Math.abs(now.x - startPct.x),
      height: Math.abs(now.y - startPct.y),
    });
  }

  async function handlePointerUp() {
    const current = dragRef.current;
    const box = liveBoxRef.current;
    endDrag();
    setLiveBox(null);
    if (!current) return;
    const { candidates: latestCandidates, onBoxChange: latestOnBoxChange, onCandidateAdded: latestOnAdded, projectId: pid, imageId: iid } = latestRef.current;

    if (current.type === "draw") {
      if (current.moved && box && box.width > 1.5 && box.height > 1.5) {
        setDrawMode(false);
        setAddingCrop(true);
        try {
          const res = await fetch("/api/products/manual-candidate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ project_id: pid, image_id: iid, box_json: box }),
          });
          const body = await res.json();
          if (!res.ok) throw new Error(body.error ?? "Could not add crop");
          latestOnAdded(body.product);
          setFocusedId(body.product.id);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Could not add crop");
        } finally {
          setAddingCrop(false);
        }
      } else {
        // A fast/short flick-drag can land under the 1% move threshold or
        // the 1.5%-box-size floor -- previously this silently did nothing
        // (draw mode turned off, no feedback), which looked like the click
        // was simply ignored. Stay in draw mode and say why, instead of
        // forcing a re-click of "Add Crop" to try again.
        setError("That drag was too small to register -- try a larger, slower drag.");
      }
      return;
    }
    if (!current.moved) {
      const c = latestCandidates.find((cand) => cand.id === current.id);
      if (c) toggleSelect(c);
      return;
    }
    if (box) {
      latestOnBoxChange(current.id, box);
      fetch(`/api/products/${current.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ box_json: box }),
      }).catch(() => setError("Failed to save the adjusted box -- try again."));
    }
  }

  function beginDrag(state: DragState) {
    dragRef.current = state;
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
  }

  function startMove(e: React.PointerEvent, c: ProductRow) {
    if (c.status !== "candidate" || processing || disabled || !c.box_json) return;
    e.preventDefault();
    e.stopPropagation();
    setFocusedId(c.id);
    beginDrag({ type: "move", id: c.id, startBox: c.box_json, startClientX: e.clientX, startClientY: e.clientY, moved: false });
  }

  function startResize(e: React.PointerEvent, c: ProductRow, handle: Handle) {
    if (processing || disabled || !c.box_json) return;
    e.preventDefault();
    e.stopPropagation();
    beginDrag({ type: "resize", id: c.id, handle, startBox: c.box_json, startClientX: e.clientX, startClientY: e.clientY, moved: false });
  }

  function startDraw(e: React.PointerEvent) {
    if (!drawMode || processing || disabled) return;
    e.preventDefault();
    setError("");
    beginDrag({ type: "draw", startClientX: e.clientX, startClientY: e.clientY, startBox: { x: 0, y: 0, width: 0, height: 0 }, moved: false });
  }

  function handleNotesChange(value: string) {
    setNotesDraft(value);
    if (!focusedId) return;
    if (notesTimer.current) clearTimeout(notesTimer.current);
    notesTimer.current = setTimeout(() => {
      onNotesChange(focusedId, value);
      fetch(`/api/products/${focusedId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ analyst_notes: value }),
      }).catch(() => setError("Failed to save note -- try again."));
    }, 500);
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-[#0d1117]">
      <div className="flex items-center justify-between px-4 py-2 bg-surface border-b border-border-subtle flex-shrink-0 gap-3">
        <p className="text-xs text-text-secondary flex items-center gap-2">
          <span>
            {pendingCandidates.length > 0
              ? `${pendingCandidates.length} candidate${pendingCandidates.length === 1 ? "" : "s"} identified -- click to select, drag to adjust, then process`
              : candidates.length > 0
                ? "All candidates on this image have been processed."
                : "No candidates identified yet on this image."}
          </span>
          {lowConfidenceCount > 0 && (
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-state-low-conf-fill text-state-low-conf-text">
              {lowConfidenceCount} need{lowConfidenceCount === 1 ? "s" : ""} a closer look
            </span>
          )}
        </p>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => setDrawMode((v) => !v)}
            disabled={processing || disabled || addingCrop}
            title="Draw a box around a product the model missed"
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer disabled:opacity-60 transition-colors duration-150 ${
              drawMode ? "bg-teal text-white hover:bg-[#17A589]" : "border border-border text-navy hover:bg-background"
            }`}
          >
            {addingCrop ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <SquarePlus className="h-3.5 w-3.5" />}
            {drawMode ? "Click and drag on the image…" : "Add Crop"}
          </button>
          <button
            onClick={onIdentify}
            disabled={identifying || disabled || costExhausted}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#3D5A80] text-white text-xs font-semibold cursor-pointer hover:bg-[#2E4766] disabled:opacity-60 transition-colors duration-150"
          >
            {identifying ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            {identifying ? "Identifying products…" : "Identify Products"}
          </button>
          {identifyCostEstimate !== null && (
            <span className="text-[10px] text-muted" title="Rough estimate, not a measured figure -- see lib/pricing.ts">
              ~${identifyCostEstimate.toFixed(3)} est.
            </span>
          )}
        </div>
      </div>

      {error && (
        <p className="text-xs text-state-missing-text px-4 py-2 bg-state-missing-fill flex-shrink-0">{error}</p>
      )}

      <div className="flex-1 overflow-auto flex items-center justify-center p-4 relative">
        <div
          ref={containerRef}
          onPointerDown={startDraw}
          className={`relative max-h-[65vh] inline-block ${drawMode ? "cursor-crosshair" : ""}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageUrl} alt="Shelf" crossOrigin="anonymous" className="max-h-[65vh] block pointer-events-none" draggable={false} />
          {candidates.map((c) => {
            if (!c.box_json) return null;
            const activeDrag = dragRef.current;
            const isDraggingThis = activeDrag && "id" in activeDrag && activeDrag.id === c.id && liveBox;
            const box = isDraggingThis ? liveBox! : (c.box_json as BoundingBox);
            const isSelected = selectedIds.has(c.id);
            const selectionNumber = selectionIndex.get(c.id);
            const isFocused = focusedId === c.id;
            const status = itemStatus[c.id] ?? "idle";
            const isCandidate = c.status === "candidate";
            const dimmed = hasSelection && !isSelected && isCandidate;
            const tier = confidenceTier(c.confidence_score);
            return (
              <div
                key={c.id}
                onPointerDown={(e) => (c.status === "candidate" ? startMove(e, c) : setFocusedId(c.id))}
                title={c.candidate_name ?? "Product"}
                className={`absolute border-2 rounded transition-all duration-150 ${
                  !isCandidate
                    ? tier
                      ? CONFIDENCE_BORDER[tier]
                      : "border-state-added-text bg-state-added-fill/20"
                    : isSelected
                      ? "border-teal bg-teal/10 cursor-move"
                      : "border-white/70 bg-white/5 hover:border-teal hover:bg-teal/10 cursor-pointer"
                }`}
                style={{
                  left: `${box.x}%`,
                  top: `${box.y}%`,
                  width: `${box.width}%`,
                  height: `${box.height}%`,
                  opacity: dimmed ? 0.18 : 1,
                  transition: isDraggingThis ? "none" : undefined,
                }}
              >
                {isSelected && selectionNumber !== undefined && (
                  <span className="absolute -top-2 -left-2 h-5 w-5 flex items-center justify-center bg-teal text-white text-[11px] font-bold rounded-full border-2 border-white shadow">
                    {selectionNumber}
                  </span>
                )}
                {status === "running" && (
                  <span className="absolute -top-2 -right-2 bg-navy rounded-full p-0.5">
                    <RefreshCw className="h-3 w-3 text-white animate-spin" />
                  </span>
                )}
                {/* Confidence badge is persistent (derived from saved data, not
                    this session's ephemeral itemStatus), so a product that was
                    processed in an earlier session still shows it -- this is
                    the main at-a-glance triage signal, not just a "done" tick. */}
                {status !== "running" && tier && (
                  <span
                    className={`absolute -top-2 -right-2 h-5 min-w-5 px-1 flex items-center justify-center rounded-full text-[10px] font-bold text-white shadow ${CONFIDENCE_BADGE[tier]}`}
                    title={`${Math.round((c.confidence_score ?? 0) * 100)}% confidence`}
                  >
                    {Math.round((c.confidence_score ?? 0) * 100)}%
                  </span>
                )}
                {status === "succeeded" && !tier && (
                  <span className="absolute -top-2 -right-2 bg-teal rounded-full p-0.5">
                    <Check className="h-3 w-3 text-white" />
                  </span>
                )}
                {status === "failed" && (
                  <span className="absolute -top-2 -right-2 bg-red rounded-full p-0.5">
                    <XIcon className="h-3 w-3 text-white" />
                  </span>
                )}
                {isFocused && isCandidate && !processing && !disabled && (
                  <>
                    {HANDLES.map((h) => (
                      <span
                        key={h}
                        onPointerDown={(e) => startResize(e, c, h)}
                        className="absolute h-2.5 w-2.5 bg-white border-2 border-teal rounded-sm cursor-pointer"
                        style={{
                          left: h.includes("w") ? -5 : undefined,
                          right: h.includes("e") ? -5 : undefined,
                          top: h.includes("n") ? -5 : undefined,
                          bottom: h.includes("s") ? -5 : undefined,
                          cursor: h === "nw" || h === "se" ? "nwse-resize" : "nesw-resize",
                        }}
                      />
                    ))}
                  </>
                )}
              </div>
            );
          })}
          {dragRef.current?.type === "draw" && liveBox && (
            <div
              className="absolute border-2 border-dashed border-teal bg-teal/10 pointer-events-none"
              style={{ left: `${liveBox.x}%`, top: `${liveBox.y}%`, width: `${liveBox.width}%`, height: `${liveBox.height}%` }}
            />
          )}
        </div>
      </div>

      <div className="flex items-center justify-between px-4 py-3 bg-surface border-t border-border-subtle flex-shrink-0">
        <p className="text-[11px] text-muted">
          {hasSelection ? `${selectedIds.size} selected across this store for processing` : "Click products to select them"}
        </p>
        <div className="flex items-center gap-3">
          {hasSelection && processEstimate !== null && (
            <span className="text-[11px] text-muted" title="Rough estimate, not a measured figure -- see lib/pricing.ts">
              ~${processEstimate.toFixed(2)} est. for {selectedIds.size} item
              {selectedIds.size === 1 ? "" : "s"}
            </span>
          )}
          <button
            onClick={onProcessSelected}
            disabled={!hasSelection || processing || disabled || costExhausted}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-navy text-white text-xs font-semibold cursor-pointer hover:bg-[#0D2D55] disabled:opacity-60 transition-colors duration-150"
          >
            {processing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            {processing ? "Processing…" : `Process Selected (${selectedIds.size})`}
          </button>
        </div>
      </div>

      {/* Right panel -- notes form for an unprocessed candidate (Notion
          suggested-edit pattern: each item is its own resolvable unit), or
          a live summary of what the model pulled once it's processed, so
          the analyst never has to leave this screen just to see the result. */}
      {focused && focused.status === "candidate" && (
        <div className="absolute right-0 top-12 bottom-16 w-80 bg-surface border-l border-border-subtle shadow-lg p-4 overflow-y-auto">
          <div className="flex items-start justify-between gap-2 mb-1">
            <p className="text-xs font-semibold text-text">{focused.candidate_name}</p>
            <button
              onClick={() => {
                onRemoveCandidate(focused.id);
                setFocusedId(null);
              }}
              disabled={processing || disabled}
              title="Remove this candidate (undoable for a few seconds)"
              className="flex-shrink-0 text-muted hover:text-state-missing-text cursor-pointer disabled:opacity-40 transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <p className="text-[11px] text-muted mb-3">
            Drag the box edges to tighten it, drag the middle to move it. Add anything you already know below -- price you saw, flavour, pack size, research from elsewhere. This gets fed to the model as a hint.
          </p>
          <textarea
            value={notesDraft}
            onChange={(e) => handleNotesChange(e.target.value)}
            placeholder="e.g. orange juice, 500ml, saw it for $30 on a competitor site…"
            rows={8}
            className="w-full text-xs leading-relaxed border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-navy/20 focus:border-navy transition-colors resize-y"
          />
          {itemStatus[focused.id] === "failed" && (
            <p className="text-[11px] text-state-missing-text mt-2 flex items-center gap-1">
              <AlertCircle className="h-3 w-3" /> Processing failed -- try again.
            </p>
          )}
        </div>
      )}

      {focused && focused.status !== "candidate" && (
        <div className="absolute right-0 top-12 bottom-16 w-80 bg-surface border-l border-border-subtle shadow-lg p-4 overflow-y-auto">
          <div className="flex items-center gap-2 mb-1">
            <p className="text-xs font-semibold text-text">{focused.candidate_name}</p>
            {(() => {
              const tier = confidenceTier(focused.confidence_score);
              if (!tier) return null;
              return (
                <span className={`text-[10px] font-bold text-white px-1.5 py-0.5 rounded-full ${CONFIDENCE_BADGE[tier]}`}>
                  {Math.round((focused.confidence_score ?? 0) * 100)}%
                </span>
              );
            })()}
          </div>
          {itemStatus[focused.id] === "running" ? (
            <div className="flex items-center gap-2 text-xs text-muted py-8 justify-center">
              <RefreshCw className="h-4 w-4 animate-spin" /> Extracting fields…
            </div>
          ) : (
            <>
              <p className="text-[11px] text-muted mb-3">
                {schema.filter((col) => focused.fields[col.key]).length} of {schema.length} fields found. Click a value to correct it.
              </p>
              <div className="space-y-2">
                {schema.map((col) => {
                  const value = focused.fields[col.key];
                  const source = focused.field_sources[col.key];
                  const fillClass =
                    source === "missing"
                      ? "bg-state-missing-fill border-state-missing-text/30"
                      : source === "analyst"
                        ? "bg-state-override-fill border-state-override-text/30"
                        : "bg-state-ai-high-fill border-transparent";
                  const otherProcessedCount = candidates.filter((c) => c.id !== focused.id && c.status !== "candidate").length;
                  return (
                    <div key={col.key}>
                      <p className="text-[10px] uppercase tracking-wide text-muted mb-0.5">{col.header}</p>
                      <div className="flex items-center gap-1">
                        <input
                          value={value ?? ""}
                          placeholder="—"
                          onChange={(e) => onFieldEdit(focused.id, col.key, e.target.value)}
                          className={`flex-1 w-full px-2 py-1 rounded border text-xs text-text focus:outline-none focus:ring-2 focus:ring-navy/20 ${fillClass}`}
                        />
                        {otherProcessedCount > 0 && (
                          <button
                            onClick={() => {
                              const otherIds = candidates
                                .filter((c) => c.id !== focused.id && c.status !== "candidate")
                                .map((c) => c.id);
                              onBulkFieldApply(otherIds, col.key, value ?? "");
                            }}
                            disabled={!value}
                            title={`Apply this value to the other ${otherProcessedCount} processed product${otherProcessedCount === 1 ? "" : "s"} on this image`}
                            className="flex-shrink-0 text-muted hover:text-navy cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed p-1 transition-colors"
                          >
                            <Copy className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              <a
                href={finishHref}
                className="mt-4 flex items-center justify-center gap-1.5 text-xs font-semibold text-navy hover:underline cursor-pointer"
              >
                Show more in Finish Review <ArrowRight className="h-3.5 w-3.5" />
              </a>
            </>
          )}
          {itemStatus[focused.id] === "failed" && (
            <p className="text-[11px] text-state-missing-text mt-2 flex items-center gap-1">
              <AlertCircle className="h-3 w-3" /> Processing failed -- try again.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
