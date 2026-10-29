"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { RefreshCw, Upload, FileSpreadsheet } from "lucide-react";
import { TopNav } from "@/components/nav/TopNav";
import { useToast } from "@/components/ui/Toast";

// Step 1 of the project flow: Excel only. Images now belong to a STORE, not
// a project directly (a project can span multiple stores), so photo upload
// moved to /projects/[id]/stores/new after the analyst approves the parsed
// schema -- see app/projects/[id]/page.tsx for that approval checkpoint.
export default function NewProjectPage() {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState("");
  const [excel, setExcel] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!excel) {
      setError("An Excel template is required.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const formData = new FormData();
      formData.append("name", name || excel.name);
      formData.append("excel", excel);
      const res = await fetch("/api/ingest", { method: "POST", body: formData });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Reading the Excel template failed");
      }
      const { project } = await res.json();
      toast.success(`"${project.name}" parsed — review the schema below.`);
      router.push(`/projects/${project.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <TopNav crumbs={[{ label: "New Project" }]} />
      <main className="px-8 py-10">
        <div className="max-w-xl mx-auto">
          <div className="bg-surface border border-border-subtle rounded-2xl shadow-sm p-8">
            <div className="flex items-center gap-3 mb-1">
              <div className="h-10 w-10 rounded-xl bg-state-ai-high-fill flex items-center justify-center flex-shrink-0">
                <FileSpreadsheet className="h-5 w-5 text-state-ai-high-text" />
              </div>
              <h1 className="text-lg font-semibold text-text">New Project</h1>
            </div>
            <p className="text-sm text-text-secondary mb-6 ml-[52px]">
              Upload the client&apos;s Excel template. We&apos;ll parse its columns and
              category rules, then you&apos;ll review that understanding before adding
              any stores or photos.
            </p>

            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wide mb-1.5">
                  Project Name
                </label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. RTD Tea — Southeast Asia Audit"
                  className="w-full text-sm border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-navy/20 focus:border-navy transition-colors"
                />
                <p className="text-xs text-muted mt-1">Optional — defaults to the Excel filename.</p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wide mb-1.5">
                  Excel Template (blank or filled)
                </label>
                <label className="flex items-center gap-3 border border-dashed border-border rounded-lg px-4 py-6 cursor-pointer hover:border-navy/40 hover:bg-background transition-colors">
                  <Upload className="h-5 w-5 text-muted flex-shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm text-text truncate">{excel ? excel.name : "Click to choose a .xlsx or .xls file"}</p>
                    <p className="text-xs text-muted">Accepted: .xlsx, .xls</p>
                  </div>
                  <input
                    type="file"
                    accept=".xlsx,.xls"
                    onChange={(e) => setExcel(e.target.files?.[0] ?? null)}
                    className="hidden"
                  />
                </label>
              </div>

              {error && <p className="text-xs text-state-missing-text">{error}</p>}

              <button
                type="submit"
                disabled={submitting || !excel}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-navy text-white text-sm font-semibold cursor-pointer hover:bg-navy/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {submitting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
                {submitting ? "Reading Excel template…" : "Parse Template & Continue"}
              </button>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}
