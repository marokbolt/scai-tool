"use client";

import { useRef, useState } from "react";
import ReactCrop, { type Crop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import { RefreshCw, Scissors, RotateCcw, SkipForward, ListPlus } from "lucide-react";
import type { BoundingBox } from "@/lib/types";

export type ExtractionModel = "claude-haiku" | "claude-sonnet" | "claude-opus" | "openrouter";

interface Props {
  imageUrl: string;
  model: ExtractionModel;
  onModelChange: (m: ExtractionModel) => void;
  onExtract: (cropBlob: Blob, box: BoundingBox, notes: string) => void;
  extracting: boolean;
  extractDisabled?: boolean;
  onSkip: () => void;
  skipping: boolean;
  skipDisabled?: boolean;
  onQueue: (cropBlob: Blob, box: BoundingBox, notes: string) => void;
  queueDisabled: boolean;
  highlightBox?: BoundingBox | null;
  notes: string;
  onNotesChange: (value: string) => void;
}

const DEFAULT_ADJUST = { brightness: 100, contrast: 100, sharpen: 0 };

export function BoxDrawTool({
  imageUrl,
  model,
  onModelChange,
  onExtract,
  extracting,
  extractDisabled = false,
  onSkip,
  skipping,
  skipDisabled = false,
  onQueue,
  queueDisabled,
  highlightBox = null,
  notes,
  onNotesChange,
}: Props) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [crop, setCrop] = useState<Crop>();
  const [adjust, setAdjust] = useState(DEFAULT_ADJUST);

  const filterCss = `brightness(${adjust.brightness}%) contrast(${adjust.contrast}%)`;

  // Sharpening (a convolution kernel) only applies to what's SENT to the model, via
  // the offscreen canvas below -- CSS filters can't do a sharpen kernel, so the
  // on-screen preview only shows brightness/contrast; sharpen is a send-time-only effect.
  function applySharpenKernel(ctx: CanvasRenderingContext2D, w: number, h: number, amount: number) {
    if (amount <= 0) return;
    const src = ctx.getImageData(0, 0, w, h);
    const dst = ctx.createImageData(w, h);
    const s = src.data;
    const d = dst.data;
    const k = amount / 100; // 0..1 strength
    const center = 1 + 4 * k;
    const edge = -k;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) {
          const get = (xx: number, yy: number) => {
            const cx = Math.min(w - 1, Math.max(0, xx));
            const cy = Math.min(h - 1, Math.max(0, yy));
            return s[(cy * w + cx) * 4 + c];
          };
          const val = center * get(x, y) + edge * (get(x - 1, y) + get(x + 1, y) + get(x, y - 1) + get(x, y + 1));
          d[i + c] = Math.min(255, Math.max(0, val));
        }
        d[i + 3] = s[i + 3];
      }
    }
    ctx.putImageData(dst, 0, 0);
  }

  async function getCropBlob(): Promise<Blob | null> {
    if (!crop || !imgRef.current) return null;
    const img = imgRef.current;
    const canvas = document.createElement("canvas");
    canvas.width = (crop.width / 100) * img.naturalWidth;
    canvas.height = (crop.height / 100) * img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.filter = filterCss;
    ctx.drawImage(
      img,
      (crop.x / 100) * img.naturalWidth,
      (crop.y / 100) * img.naturalHeight,
      canvas.width,
      canvas.height,
      0,
      0,
      canvas.width,
      canvas.height
    );
    ctx.filter = "none";
    applySharpenKernel(ctx, canvas.width, canvas.height, adjust.sharpen);
    return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
  }

  async function handleExtract() {
    if (!crop) return;
    const blob = await getCropBlob();
    if (blob) onExtract(blob, { x: crop.x, y: crop.y, width: crop.width, height: crop.height }, notes);
  }

  async function handleQueue() {
    if (!crop) return;
    const blob = await getCropBlob();
    if (blob) onQueue(blob, { x: crop.x, y: crop.y, width: crop.width, height: crop.height }, notes);
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-[#0d1117]">
      <div className="flex items-center gap-4 px-4 py-2 bg-surface border-b border-border flex-shrink-0 text-xs text-muted">
        <label className="flex items-center gap-1.5 flex-1">
          Brightness
          <input
            type="range"
            min={40}
            max={200}
            value={adjust.brightness}
            onChange={(e) => setAdjust((a) => ({ ...a, brightness: Number(e.target.value) }))}
            className="flex-1 cursor-pointer"
          />
        </label>
        <label className="flex items-center gap-1.5 flex-1">
          Contrast
          <input
            type="range"
            min={40}
            max={200}
            value={adjust.contrast}
            onChange={(e) => setAdjust((a) => ({ ...a, contrast: Number(e.target.value) }))}
            className="flex-1 cursor-pointer"
          />
        </label>
        <label className="flex items-center gap-1.5 flex-1">
          Sharpen
          <input
            type="range"
            min={0}
            max={100}
            value={adjust.sharpen}
            onChange={(e) => setAdjust((a) => ({ ...a, sharpen: Number(e.target.value) }))}
            className="flex-1 cursor-pointer"
          />
        </label>
        <button
          onClick={() => setAdjust(DEFAULT_ADJUST)}
          className="flex items-center gap-1 cursor-pointer hover:text-text"
          title="Reset adjustments"
        >
          <RotateCcw className="h-3 w-3" /> Reset
        </button>
      </div>

      {/* Parity with the candidate board's notes field -- same "hint, not
          gospel" framing, fed to the model the same way (buildExtractionPrompt's
          analystNotes param), so a box drawn here isn't a second-class path
          just because it predates the candidate board. */}
      <div className="px-4 py-2 bg-surface border-b border-border-subtle flex-shrink-0">
        <input
          value={notes}
          onChange={(e) => onNotesChange(e.target.value)}
          placeholder="Optional hint for the model -- price you saw, flavour, pack size, research from elsewhere…"
          className="w-full text-xs border border-border rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-navy/20 focus:border-navy transition-colors"
        />
      </div>

      <div className="flex-1 overflow-auto flex items-center justify-center p-4 relative">
        <ReactCrop crop={crop} onChange={(_, percentCrop) => setCrop(percentCrop)} className="max-w-full">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={imgRef}
            src={imageUrl}
            alt="Shelf"
            crossOrigin="anonymous"
            className="max-h-[65vh]"
            style={{ filter: filterCss }}
          />
          {highlightBox && (
            <div
              className="absolute border-2 border-teal bg-teal/10 pointer-events-none"
              style={{
                left: `${highlightBox.x}%`,
                top: `${highlightBox.y}%`,
                width: `${highlightBox.width}%`,
                height: `${highlightBox.height}%`,
              }}
              title="Currently selected product"
            />
          )}
        </ReactCrop>
      </div>

      <div className="flex items-center justify-between px-4 py-3 bg-surface border-t border-border flex-shrink-0">
        <select
          value={model}
          onChange={(e) => onModelChange(e.target.value as ExtractionModel)}
          className="text-xs border border-border rounded px-2 py-1.5 cursor-pointer bg-surface"
        >
          <option value="claude-haiku">Claude Haiku 4.5</option>
          <option value="claude-sonnet">Claude Sonnet 4.6</option>
          <option value="claude-opus">Claude Opus 4.6</option>
          <option value="openrouter">Gemini 2.5 Flash (OpenRouter)</option>
        </select>
        <div className="flex items-center gap-2">
          <button
            onClick={onSkip}
            disabled={skipping || skipDisabled}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-navy text-xs font-semibold cursor-pointer hover:bg-background disabled:opacity-60 transition-colors"
            title="No products to review on this image"
          >
            {skipping ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <SkipForward className="h-3.5 w-3.5" />}
            No Products — Skip
          </button>
          <button
            onClick={handleQueue}
            disabled={!crop || queueDisabled}
            title="Stage this box for batch extraction instead of extracting right now"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-navy text-xs font-semibold cursor-pointer hover:bg-background disabled:opacity-60 transition-colors"
          >
            <ListPlus className="h-3.5 w-3.5" /> Add to Queue
          </button>
          <button
            onClick={handleExtract}
            disabled={!crop || extracting || extractDisabled}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-navy text-white text-xs font-semibold cursor-pointer hover:bg-navy/90 disabled:opacity-60 transition-colors"
          >
            {extracting ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Scissors className="h-3.5 w-3.5" />}
            {extracting ? "Extracting…" : "Extract Now"}
          </button>
        </div>
      </div>
    </div>
  );
}
