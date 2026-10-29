import { NextRequest, NextResponse } from "next/server";
import { createSignedUploadUrl } from "@/lib/storage";

// Every real caller only ever builds a path shaped like
// `${projectId}/${randomUUID()}${ext}` (see the upload page) -- this bucket
// is public and `createSignedUploadUrl` mints with `upsert: true`, so with no
// shape check a caller could target (and overwrite) any existing object at
// any path in the bucket, including another project's files. Not exploitable
// today (no external callers, trusted internal use only) but cheap to close.
const SAFE_STORAGE_PATH = /^[a-zA-Z0-9-]+\/[a-zA-Z0-9._-]+$/;

// Tiny request/response, no binary data -- mints a token the browser uses
// to upload a file directly to Supabase Storage.
export async function POST(req: NextRequest) {
  try {
    const { storagePath } = (await req.json()) as { storagePath: string };
    if (!storagePath) return NextResponse.json({ error: "storagePath is required" }, { status: 400 });
    if (!SAFE_STORAGE_PATH.test(storagePath)) {
      return NextResponse.json({ error: "storagePath has an unexpected shape" }, { status: 400 });
    }
    const { signedUrl, token } = await createSignedUploadUrl(storagePath);
    return NextResponse.json({ signedUrl, token });
  } catch (err: unknown) {
    console.error("POST /api/upload-url failed:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to create upload URL" }, { status: 500 });
  }
}
