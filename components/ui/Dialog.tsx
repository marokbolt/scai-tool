"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, X } from "lucide-react";

// Elements the focus trap below is allowed to land on. Kept intentionally
// simple (no third-party focus-trap dependency in this repo) -- good enough
// for the forms/buttons that actually appear inside this app's dialogs.
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  className?: string;
  /** false disables Escape-to-close and backdrop-click-to-close -- use while
   * an irreversible confirm action is actually in flight so it can't be
   * dismissed mid-request. */
  dismissible?: boolean;
}

let dialogIdCounter = 0;

export function Dialog({ open, onClose, title, children, className = "", dismissible = true }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const titleId = useRef(`dialog-title-${++dialogIdCounter}`).current;

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const toFocus = panel?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? panel;
    toFocus?.focus();

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (!dismissible) return;
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => el.offsetParent !== null
      );
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      // Return focus to whatever opened the dialog -- standard modal
      // behavior, matters a lot for keyboard-only use.
      previouslyFocused.current?.focus?.();
    };
  }, [open, onClose, dismissible]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-navy/40 animate-dialog-backdrop"
        onClick={dismissible ? onClose : undefined}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={`relative bg-surface border border-border-subtle rounded-2xl shadow-xl w-full max-w-md p-6 animate-dialog-panel focus:outline-none ${className}`}
      >
        {title && (
          <div className="flex items-start justify-between gap-3 mb-3">
            <h2 id={titleId} className="text-lg font-semibold text-text">
              {title}
            </h2>
            {dismissible && (
              <button
                onClick={onClose}
                aria-label="Close dialog"
                className="flex-shrink-0 text-muted hover:text-text cursor-pointer rounded p-1 -m-1 transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body
  );
}

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red styling + warning icon for delete-type / discard-type actions. */
  destructive?: boolean;
  /** True while onConfirm's request is in flight -- disables both buttons
   * and the dialog's own dismiss paths so a double-click can't double-fire
   * (and an irreversible action can't be escaped mid-request). */
  confirming?: boolean;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  confirming = false,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title={title} dismissible={!confirming}>
      <div className="flex items-start gap-3 mb-5">
        {destructive && (
          <div className="h-9 w-9 rounded-full bg-state-missing-fill flex items-center justify-center flex-shrink-0">
            <AlertTriangle className="h-4.5 w-4.5 text-state-missing-text" />
          </div>
        )}
        {description && <div className="text-sm text-text-secondary leading-relaxed pt-1">{description}</div>}
      </div>
      <div className="flex justify-end gap-2">
        <button
          onClick={onClose}
          disabled={confirming}
          className="px-4 py-2 rounded-lg border border-border text-text text-sm font-semibold cursor-pointer hover:bg-background disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          {cancelLabel}
        </button>
        <button
          onClick={() => void onConfirm()}
          disabled={confirming}
          className={`px-4 py-2 rounded-lg text-white text-sm font-semibold cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed transition-colors ${
            destructive ? "bg-state-missing-text hover:bg-state-missing-text/90" : "bg-navy hover:bg-navy/90"
          }`}
        >
          {confirming ? "Working…" : confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
