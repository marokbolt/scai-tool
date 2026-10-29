"use client";

import Link from "next/link";
import type { LucideIcon } from "lucide-react";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  actionLabel?: string;
  /** Use either onAction (button) or actionHref (Link) -- not both. */
  onAction?: () => void;
  actionHref?: string;
  className?: string;
}

/** Icon + message + optional single action, for "no X yet" sections. Every
 * list/async-loaded section in this app's scope should render this (or
 * Skeleton while loading) instead of a bare/missing blank state. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  onAction,
  actionHref,
  className = "",
}: EmptyStateProps) {
  return (
    <div
      className={`border border-dashed border-border rounded-2xl py-14 px-6 text-center flex flex-col items-center gap-3 ${className}`}
    >
      <div className="h-11 w-11 rounded-xl bg-background flex items-center justify-center">
        <Icon className="h-5 w-5 text-muted" />
      </div>
      <div className="space-y-1 max-w-sm">
        <p className="text-sm font-semibold text-text">{title}</p>
        {description && <p className="text-xs text-text-secondary">{description}</p>}
      </div>
      {actionLabel &&
        (actionHref ? (
          <Link
            href={actionHref}
            className="mt-1 flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-navy text-white text-xs font-semibold cursor-pointer hover:bg-navy/90 transition-colors"
          >
            {actionLabel}
          </Link>
        ) : (
          <button
            type="button"
            onClick={onAction}
            className="mt-1 flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-navy text-white text-xs font-semibold cursor-pointer hover:bg-navy/90 transition-colors"
          >
            {actionLabel}
          </button>
        ))}
    </div>
  );
}
