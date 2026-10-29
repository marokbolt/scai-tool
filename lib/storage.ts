import { createClient } from "@supabase/supabase-js";

const BUCKET = "project-files";

let _client: ReturnType<typeof createClient> | null = null;

function getServiceClient() {
  if (!_client) {
    _client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _client;
}

// Mirrors lib/db.ts's own unwrap() -- callers everywhere else in the app
// only ever see a plain Error with a message, never a raw Postgrest/Storage
// error object; this file was the one place that didn't follow that.
function throwIfError(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

// storagePath is the bucket-relative key, e.g. "{projectId}/{uuid}.jpg"
export async function uploadFile(storagePath: string, buffer: Buffer, contentType: string): Promise<void> {
  const client = getServiceClient();
  const { error } = await client.storage.from(BUCKET).upload(storagePath, buffer, { contentType, upsert: true });
  throwIfError(error);
}

// Signed upload URL so the browser can PUT large image files straight to
// Supabase Storage, bypassing our Next.js API route (and Vercel's ~4.5MB
// serverless function body limit) entirely. Only the tiny {path, token}
// pair round-trips through our server.
export async function createSignedUploadUrl(storagePath: string): Promise<{ signedUrl: string; token: string }> {
  const client = getServiceClient();
  const { data, error } = await client.storage.from(BUCKET).createSignedUploadUrl(storagePath, { upsert: true });
  throwIfError(error);
  return { signedUrl: data!.signedUrl, token: data!.token };
}

// Server-side fetch of an already-uploaded file, used to classify an image
// without ever routing its bytes through the ingest request body.
export async function downloadFile(storagePath: string): Promise<Buffer> {
  const client = getServiceClient();
  const { data, error } = await client.storage.from(BUCKET).download(storagePath);
  throwIfError(error);
  return Buffer.from(await data!.arrayBuffer());
}

// Bucket is public, so the URL can be built client-side too -- no secret needed,
// just NEXT_PUBLIC_SUPABASE_URL.
export function publicUrl(storagePath: string): string {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  return `${base}/storage/v1/object/public/${BUCKET}/${storagePath}`;
}
