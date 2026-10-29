"use client";

import { useEffect, useState } from "react";
import type { SchemaColumn } from "@/lib/types";
import { Bot, User, AlertCircle, Scissors } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";

interface Props {
  schema: SchemaColumn[];
  fields: Record<string, string | null>;
  meta: { in_scope: boolean; confidence_score: number | null; reason: string | null } | null;
  modelUsed: string | null;
  onFieldsChange: (fields: Record<string, string | null>, editedKeys: Set<string>) => void;
  onConfirm: () => void;
  confirming: boolean;
  confirmLabel?: string;
  savingLabel?: string;
  onSecondary?: () => void;
  secondaryLabel?: string;
}

export function FieldForm({
  schema,
  fields,
  meta,
  modelUsed,
  onFieldsChange,
  onConfirm,
  confirming,
  confirmLabel = "Confirm & Add Product",
  savingLabel = "Saving…",
  onSecondary,
  secondaryLabel = "Clear",
}: Props) {
  const [local, setLocal] = useState(fields);
  const [edited, setEdited] = useState<Set<string>>(new Set());
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useEffect(() => {
    setLocal(fields);
    setEdited(new Set());
  }, [fields]);

  function handleChange(key: string, value: string) {
    const next = { ...local, [key]: value };
    const nextEdited = new Set(edited);
    nextEdited.add(key);
    setLocal(next);
    setEdited(nextEdited);
    onFieldsChange(next, nextEdited);
  }

  // "Clear" discards an extracted-but-unsaved result (a real paid Vision
  // call already happened for it) and "Cancel" discards in-progress edits to
  // a confirmed product that were never saved -- both genuinely destroy work
  // with zero prior protection, so gate them behind a confirm whenever
  // there's actually something in the form to lose. The two labels mean
  // different things though: "Cancel" edits an already-populated product, so
  // `local` being non-empty is the normal resting state and tells us
  // nothing -- only `edited.size > 0` means there are unsaved changes to
  // lose. "Clear" discards a just-extracted, never-saved result, where
  // `local` only has values because of that extraction, so its presence
  // alone is exactly what would be lost.
  function handleSecondaryClick() {
    const hasContent = secondaryLabel === "Cancel" ? edited.size > 0 : Object.values(local).some((v) => v) || edited.size > 0;
    if (hasContent && onSecondary) {
      setConfirmDiscard(true);
    } else {
      onSecondary?.();
    }
  }

  if (Object.keys(fields).length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <EmptyState icon={Scissors} title="Nothing selected yet" description='Draw a box around a product and click "Extract" to see its fields here.' />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          {meta?.in_scope ? (
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-state-added-fill text-state-added-text">In Scope</span>
          ) : (
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-state-missing-fill text-state-missing-text">Out of Scope</span>
          )}
          {meta?.confidence_score != null && (
            <span className="text-xs text-muted">{Math.round(meta.confidence_score * 100)}% confidence</span>
          )}
        </div>
        <span className="text-xs text-muted font-mono">{modelUsed}</span>
      </div>

      {meta?.reason && (
        <p className="text-xs text-state-missing-text px-4 py-2 flex items-start gap-1.5">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" /> {meta.reason}
        </p>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-2">
        {schema.map((col) => {
          const value = local[col.key];
          const isEdited = edited.has(col.key);
          return (
            <div key={col.key} className="flex items-start gap-2 py-2 border-b border-border-subtle last:border-0">
              <div className="w-32 flex-shrink-0 pt-1.5">
                <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide leading-snug">{col.header}</p>
              </div>
              <input
                value={value ?? ""}
                onChange={(e) => handleChange(col.key, e.target.value)}
                placeholder="—"
                className="flex-1 text-xs text-text border border-transparent hover:border-border focus:border-navy rounded px-1.5 py-1 focus:outline-none"
              />
              {/* Source is never color-only: each state also gets its own
                  icon shape (person/robot/warning), so the AI-vs-analyst-vs-
                  missing distinction survives grayscale and colorblind
                  viewing -- same as the Excel export's own legend has to. */}
              <span className="flex-shrink-0 pt-1.5" title={isEdited ? "Edited by analyst" : value ? "From AI extraction" : "Missing"}>
                {isEdited ? (
                  <User className="h-3 w-3 text-state-override-text" />
                ) : value ? (
                  <Bot className="h-3 w-3 text-state-ai-high-text" />
                ) : (
                  <AlertCircle className="h-3 w-3 text-state-missing-text" />
                )}
              </span>
            </div>
          );
        })}
      </div>

      <div className="px-4 py-3 border-t border-border flex-shrink-0 flex gap-2">
        {onSecondary && (
          <button
            onClick={handleSecondaryClick}
            disabled={confirming}
            className="flex-shrink-0 px-4 py-2 rounded-lg border border-border text-text text-sm font-semibold cursor-pointer hover:bg-background disabled:opacity-60 transition-colors"
          >
            {secondaryLabel}
          </button>
        )}
        <button
          onClick={onConfirm}
          disabled={confirming}
          className="flex-1 py-2 rounded-lg bg-navy text-white text-sm font-semibold cursor-pointer hover:bg-navy/90 disabled:opacity-60 transition-colors"
        >
          {confirming ? savingLabel : confirmLabel}
        </button>
      </div>

      <ConfirmDialog
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        onConfirm={() => {
          setConfirmDiscard(false);
          onSecondary?.();
        }}
        destructive
        title={`Discard ${secondaryLabel === "Cancel" ? "these changes" : "this result"}?`}
        description="Anything extracted or edited here that hasn't been saved will be lost."
        confirmLabel={`Yes, ${secondaryLabel}`}
      />
    </div>
  );
}
