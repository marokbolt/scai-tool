"use client";
import { createClient } from "@supabase/supabase-js";

const BUCKET = "project-files";

let _client: ReturnType<typeof createClient> | null = null;

function browserClient() {
  if (!_client) {
    _client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
  }
  return _client;
}

// Uploads directly from the browser to Supabase Storage using a signed
// upload token (minted server-side, never a raw credential) -- this is
// what lets large photo sets bypass Vercel's serverless function body
// size limit entirely.
export async function uploadDirect(storagePath: string, token: string, file: File): Promise<void> {
  const { error } = await browserClient().storage.from(BUCKET).uploadToSignedUrl(storagePath, token, file);
  if (error) throw error;
}
