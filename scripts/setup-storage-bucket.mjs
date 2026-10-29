// Creates the `project-files` Storage bucket the app expects, if it doesn't
// already exist. Tables/functions come from supabase/schema.sql (run that
// in the Supabase SQL Editor first) -- this script only handles Storage,
// since a bucket can't be created from plain SQL.
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

const BUCKET = "project-files";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local first."
    );
  }

  const supabase = createClient(url, key);
  const { data: buckets, error: listError } = await supabase.storage.listBuckets();
  if (listError) throw listError;

  if (buckets.find((b) => b.name === BUCKET)) {
    console.log(`Storage bucket already exists: ${BUCKET}`);
    return;
  }

  const { error } = await supabase.storage.createBucket(BUCKET, { public: true });
  if (error) throw error;
  console.log(`Created storage bucket: ${BUCKET}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
