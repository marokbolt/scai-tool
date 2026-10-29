import Link from "next/link";
import { Home, ChevronRight } from "lucide-react";

export interface Crumb {
  label: string;
  href?: string;
}

interface Props {
  crumbs: Crumb[];
  children?: React.ReactNode; // right-aligned page-specific actions
}

export function TopNav({ crumbs, children }: Props) {
  return (
    <div className="flex items-center justify-between px-5 py-2.5 border-b border-border bg-surface flex-shrink-0">
      <div className="flex items-center gap-1.5 text-xs min-w-0">
        <Link
          href="/"
          className="flex items-center gap-1 text-navy font-semibold cursor-pointer hover:underline flex-shrink-0"
        >
          <Home className="h-3.5 w-3.5" />
          Home
        </Link>
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1.5 min-w-0">
            <ChevronRight className="h-3 w-3 text-muted flex-shrink-0" />
            {c.href ? (
              <Link href={c.href} className="text-muted hover:text-navy hover:underline cursor-pointer truncate">
                {c.label}
              </Link>
            ) : (
              <span className="text-text font-semibold truncate">{c.label}</span>
            )}
          </span>
        ))}
      </div>
      {children && <div className="flex items-center gap-3 flex-shrink-0">{children}</div>}
    </div>
  );
}
