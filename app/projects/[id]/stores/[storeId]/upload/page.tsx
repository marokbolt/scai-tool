"use client";

import { useRouter, useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Bell, BellOff, BellRing, RefreshCw, Upload, ImagePlus } from "lucide-react";
import { TopNav } from "@/components/nav/TopNav";
import { uploadDirect } from "@/lib/supabase-browser";
import { useToast } from "@/components/ui/Toast";

const UPLOAD_CONCURRENCY = 4;

// Neither browsers (other than Safari) nor Claude's vision API can read HEIC/HEIF
// directly -- iPhone photos default to this format, so without converting them
// client-side first, "upload" would silently produce files nothing downstream
// can open. heic2any decodes via WASM in the browser; server code never changes.
function isHeic(file: File): boolean {
  const name = file.name.toLowerCase();
  return (
    file.type === "image/heic" ||
    file.type === "image/heif" ||
    name.endsWith(".heic") ||
    name.endsWith(".heif")
  );
}

async function convertIfHeic(file: File): Promise<File> {
  if (!isHeic(file)) return file;
  const heic2any = (await import("heic2any")).default;
  const result = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.9 });
  const blob = Array.isArray(result) ? result[0] : result;
  const newName = file.name.replace(/\.(heic|heif)$/i, ".jpg");
  return new File([blob], newName, { type: "image/jpeg" });
}

export default function StoreUploadPage() {
  const router = useRouter();
  const params = useParams<{ id: string; storeId: string }>();
  const toast = useToast();
  const [images, setImages] = useState<File[]>([]);
  const [converting, setConverting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState("");

  // The upload batch is self-contained -- each photo persists via
  // /api/ingest-image independently of whether this component is still
  // mounted, same principle as ReviewWorkspace's candidate-processing batch
  // (components/review/ReviewWorkspace.tsx). Nothing here disables the
  // TopNav, so the analyst can already navigate away mid-upload; this ref
  // just makes sure that doing so can't throw a stale router.push at them
  // or warn about setting state on an unmounted page -- completion is
  // reported via toast/notify instead, which lives in the root layout and
  // survives the navigation.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  async function handleImagesSelected(fileList: FileList | null) {
    const files = Array.from(fileList ?? []);
    setError("");
    if (!files.some(isHeic)) {
      setImages(files);
      return;
    }
    setConverting(true);
    try {
      setImages(await Promise.all(files.map(convertIfHeic)));
    } catch {
      setError("Failed to convert one or more HEIC photos -- try exporting them as JPEG first.");
      setImages(files);
    } finally {
      setConverting(false);
    }
  }

  async function uploadOneImage(file: File) {
    const ext = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")) : ".jpg";
    const storagePath = `${params.id}/${crypto.randomUUID()}${ext}`;

    const urlRes = await fetch("/api/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ storagePath }),
    });
    if (!urlRes.ok) throw new Error(`Could not get an upload URL for ${file.name}`);
    const { token } = await urlRes.json();
    await uploadDirect(storagePath, token, file);

    const finalizeRes = await fetch("/api/ingest-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: params.id,
        storeId: params.storeId,
        fileName: file.name,
        storagePath,
        mediaType: file.type || "image/jpeg",
      }),
    });
    if (!finalizeRes.ok) throw new Error(`Uploaded but failed to classify ${file.name}`);
  }

  async function handleSubmit() {
    if (images.length === 0) {
      setError("Choose at least one photo.");
      return;
    }
    const total = images.length;
    setSubmitting(true);
    setError("");
    const failures: string[] = [];
    let done = 0;
    setProgress({ done: 0, total });

    let cursor = 0;
    const worker = async () => {
      while (cursor < images.length) {
        const file = images[cursor];
        cursor += 1;
        try {
          await uploadOneImage(file);
        } catch (err) {
          failures.push(err instanceof Error ? err.message : file.name);
        } finally {
          done += 1;
          if (isMountedRef.current) setProgress({ done, total });
        }
      }
    };
    await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, worker));

    if (failures.length > 0) {
      const message = `${failures.length} of ${total} photos failed: ${failures.slice(0, 3).join(", ")}${failures.length > 3 ? "…" : ""}`;
      if (isMountedRef.current) {
        setError(message);
        setSubmitting(false);
      } else {
        // Analyst already moved on -- this is the whole reason notify()
        // exists: surface it where they'll actually see it (toast if the
        // tab is still open, a real OS notification if it isn't focused).
        toast.notify("Upload finished with errors", message, "error");
      }
      return;
    }

    toast.notify("Upload complete", `${total} photo${total === 1 ? "" : "s"} uploaded successfully.`, "success");
    // Only auto-advance if the analyst is actually still on this screen --
    // forcing a navigation on someone who already left for somewhere else
    // would be worse than just leaving them there with the toast above.
    if (isMountedRef.current) {
      router.push(`/projects/${params.id}/stores/${params.storeId}/review`);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <TopNav crumbs={[{ label: "Project", href: `/projects/${params.id}` }, { label: "Upload Photos" }]} />
      <main className="px-8 py-10">
        <div className="max-w-xl mx-auto">
          <div className="bg-surface border border-border-subtle rounded-2xl shadow-sm p-8">
            <div className="flex items-center gap-3 mb-1">
              <div className="h-10 w-10 rounded-xl bg-state-ai-high-fill flex items-center justify-center flex-shrink-0">
                <ImagePlus className="h-5 w-5 text-state-ai-high-text" />
              </div>
              <h1 className="text-lg font-semibold text-text">Upload Shelf Photos</h1>
            </div>
            <p className="text-sm text-text-secondary mb-6 ml-[52px]">
              Add every photo from this store visit. HEIC/HEIF photos convert automatically.
            </p>

            <label className="flex items-center gap-3 border border-dashed border-border rounded-lg px-4 py-6 cursor-pointer hover:border-navy/40 hover:bg-background transition-colors mb-4">
              <Upload className="h-5 w-5 text-muted flex-shrink-0" />
              <div className="min-w-0">
                <p className="text-sm text-text">
                  {images.length > 0 ? `${images.length} photo${images.length === 1 ? "" : "s"} selected` : "Click to choose photos"}
                </p>
                <p className="text-xs text-muted">JPEG, PNG, HEIC/HEIF</p>
              </div>
              <input
                type="file"
                accept="image/*,.heic,.heif"
                multiple
                disabled={converting || submitting}
                onChange={(e) => handleImagesSelected(e.target.files)}
                className="hidden"
              />
            </label>

            {converting && (
              <p className="text-xs text-text-secondary mb-4 flex items-center gap-1.5">
                <RefreshCw className="h-3 w-3 animate-spin" /> Converting HEIC photos to JPEG…
              </p>
            )}

            {error && <p className="text-xs text-state-missing-text mb-4">{error}</p>}

            {images.length > 0 && toast.notificationPermission !== "unsupported" && (
              <button
                type="button"
                onClick={toast.requestNotificationPermission}
                disabled={toast.notificationPermission === "granted" || toast.notificationPermission === "denied"}
                className="w-full flex items-center justify-center gap-1.5 mb-3 px-3 py-1.5 rounded-lg border border-border text-xs font-semibold cursor-pointer hover:bg-background disabled:cursor-default transition-colors text-text-secondary"
                title={
                  toast.notificationPermission === "denied"
                    ? "Notifications are blocked for this site -- re-enable them in your browser's site settings to turn this back on"
                    : "Lets this tab tell you the upload finished even if you've switched to another tab -- it will never notify once the tab itself is closed"
                }
              >
                {toast.notificationPermission === "granted" ? (
                  <>
                    <BellRing className="h-3.5 w-3.5 text-state-added-text" /> Notified when this finishes
                  </>
                ) : toast.notificationPermission === "denied" ? (
                  <>
                    <BellOff className="h-3.5 w-3.5 text-muted" /> Notifications blocked -- enable in browser settings
                  </>
                ) : (
                  <>
                    <Bell className="h-3.5 w-3.5" /> Notify me if I switch tabs while this runs
                  </>
                )}
              </button>
            )}

            <button
              onClick={handleSubmit}
              disabled={submitting || converting || images.length === 0}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-navy text-white text-sm font-semibold cursor-pointer hover:bg-navy/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {submitting
                ? progress
                  ? `Uploading… (${progress.done}/${progress.total})`
                  : "Uploading…"
                : "Upload & Continue to Review"}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
