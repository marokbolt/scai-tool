"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, Info, X, XCircle } from "lucide-react";

type ToastVariant = "success" | "error" | "info";

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastItem {
  id: string;
  variant: ToastVariant;
  message: string;
  duration: number;
  action?: ToastAction;
}

type NotificationPermissionState = NotificationPermission | "unsupported";

interface ToastContextValue {
  success: (message: string, duration?: number, action?: ToastAction) => void;
  error: (message: string, duration?: number, action?: ToastAction) => void;
  info: (message: string, duration?: number, action?: ToastAction) => void;
  /**
   * Shows a toast AND, if the browser Notification API is available,
   * permission was already granted, and the tab is currently hidden, also
   * fires a real OS-level Notification -- for a long-running background
   * task finishing while the analyst isn't looking at this tab.
   *
   * Covers: tab open but not focused. Does NOT cover: tab/browser fully
   * closed -- that needs a service worker + push subscription + backend,
   * which is out of scope here.
   */
  notify: (title: string, body?: string, variant?: ToastVariant) => void;
  /**
   * Requests Notification permission. Must only ever be called from inside
   * a real click handler (never on mount/page load) -- Chrome silently
   * ignores a requestPermission() call that isn't a direct result of a user
   * gesture, and doing it unprompted would also just be bad practice.
   */
  requestNotificationPermission: () => void;
  notificationPermission: NotificationPermissionState;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION = 5000;

const VARIANT_STYLE: Record<ToastVariant, { icon: typeof CheckCircle2; fill: string; text: string }> = {
  success: { icon: CheckCircle2, fill: "bg-state-added-fill", text: "text-state-added-text" },
  error: { icon: XCircle, fill: "bg-state-missing-fill", text: "text-state-missing-text" },
  info: { icon: Info, fill: "bg-state-web-fill", text: "text-state-web-text" },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermissionState>("default");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    if (typeof window === "undefined" || !("Notification" in window)) {
      setNotificationPermission("unsupported");
      return;
    }
    setNotificationPermission(Notification.permission);
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((variant: ToastVariant, message: string, duration = DEFAULT_DURATION, action?: ToastAction) => {
    const id = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, variant, message, duration, action }]);
  }, []);

  const requestNotificationPermission = useCallback(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    Notification.requestPermission().then(setNotificationPermission);
  }, []);

  const notify = useCallback(
    (title: string, body?: string, variant: ToastVariant = "info") => {
      push(variant, body ? `${title} — ${body}` : title, DEFAULT_DURATION);
      const tabHidden = typeof document !== "undefined" && document.hidden;
      if (tabHidden && typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
        new Notification(title, body ? { body } : undefined);
      }
    },
    [push]
  );

  const value: ToastContextValue = {
    success: (m, d, a) => push("success", m, d, a),
    error: (m, d, a) => push("error", m, d, a),
    info: (m, d, a) => push("info", m, d, a),
    notify,
    requestNotificationPermission,
    notificationPermission,
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      {mounted &&
        createPortal(
          <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)]" aria-live="polite">
            {toasts.map((t) => (
              <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
            ))}
          </div>,
          document.body
        )}
    </ToastContext.Provider>
  );
}

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, toast.duration);
    return () => clearTimeout(timer);
  }, [toast.duration, onDismiss]);

  const { icon: Icon, fill, text } = VARIANT_STYLE[toast.variant];

  return (
    <div
      role="status"
      className="relative overflow-hidden bg-surface border border-border-subtle rounded-xl shadow-lg px-4 py-3 pr-9 animate-toast-in"
    >
      <div className="flex items-start gap-2.5">
        <div className={`h-6 w-6 rounded-full flex items-center justify-center flex-shrink-0 ${fill}`}>
          <Icon className={`h-3.5 w-3.5 ${text}`} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-text leading-snug pt-0.5">{toast.message}</p>
          {toast.action && (
            <button
              onClick={() => {
                toast.action?.onClick();
                onDismiss();
              }}
              className="mt-1 text-xs font-semibold text-navy hover:underline cursor-pointer"
            >
              {toast.action.label}
            </button>
          )}
        </div>
      </div>
      <button
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="absolute top-2.5 right-2.5 text-muted hover:text-text cursor-pointer rounded p-0.5 transition-colors"
      >
        <X className="h-3.5 w-3.5" />
      </button>
      {/* Visible countdown, doubles as the non-color cue that this is about
          to auto-dismiss (on top of the timer itself). */}
      <div className="absolute bottom-0 left-0 h-0.5 w-full bg-border-subtle overflow-hidden" aria-hidden="true">
        <div className="h-full bg-navy/30 animate-toast-progress" style={{ animationDuration: `${toast.duration}ms` }} />
      </div>
    </div>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider (mounted once in app/layout.tsx)");
  return ctx;
}
