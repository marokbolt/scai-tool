-- StoreAudit database schema -- run this once, in full, against a fresh
-- Supabase project's SQL Editor (Dashboard -> SQL Editor -> New query ->
-- paste this whole file -> Run). It creates every table, column, index,
-- and function the app needs. Safe to re-run (everything is
-- `if not exists` / `or replace`).
--
-- This is the consolidated, current-state schema -- the original prototype
-- was built incrementally via a series of one-off migration scripts against
-- one specific Supabase project, so this file exists to give a fresh
-- project the same end state in one step instead of replaying that history.

create extension if not exists pgcrypto; -- for gen_random_uuid()

-- ── projects ────────────────────────────────────────────────────────────
-- One audit project = one uploaded client Excel template + its parsed
-- schema/category/context understanding, shared across every store under it.
create table if not exists projects (
  id uuid primary key,
  name text not null,
  created_at timestamptz not null default now(),

  -- Parsed from the uploaded Excel template on ingest.
  schema_json jsonb not null default '[]',      -- ordered [{key, header}, ...] column list
  context_json jsonb not null default '{}',     -- {category, segments_text, raw_notes, sheet_name, header_row}
  template_file_name text,
  template_storage_path text,                   -- original .xlsx kept byte-for-byte in Storage, for export

  -- Two independent approval checkpoints -- do not conflate them:
  status text not null default 'draft',         -- final, end-of-audit approval
  approved_at timestamptz,
  schema_approved_at timestamptz,                -- analyst confirmed the parsed schema; gates creating stores/images

  -- Cost governance -- enforced server-side before every paid model call.
  total_cost_usd numeric not null default 0,
  cost_limit_usd numeric not null default 10
);

-- ── stores ──────────────────────────────────────────────────────────────
-- A project can span multiple physical stores, each with its own images
-- and independent review progress.
create table if not exists stores (
  id uuid primary key,
  project_id uuid not null references projects(id) on delete cascade,
  country text not null default '',
  name text not null default '',
  created_at timestamptz not null default now()
);

-- ── project_images ──────────────────────────────────────────────────────
create table if not exists project_images (
  id uuid primary key,
  project_id uuid not null references projects(id) on delete cascade,
  store_id uuid references stores(id),
  file_name text not null,
  storage_path text not null,                   -- path inside the project-files Storage bucket
  image_type text,                               -- storefront | aisle | shelf | product_solo (auto-classified)
  is_reviewed boolean not null default false,
  created_at timestamptz not null default now()
);

-- ── products ────────────────────────────────────────────────────────────
-- Every row is one identified/extracted product, regardless of which of the
-- three ingestion paths produced it (see `source`).
create table if not exists products (
  id uuid primary key,
  project_id uuid not null references projects(id) on delete cascade,
  image_id uuid references project_images(id) on delete set null,
  crop_storage_path text,
  box_json jsonb,                                -- {x, y, width, height} as % of image, where this was drawn/identified

  fields jsonb not null default '{}',            -- keyed by schema_json[].key
  field_sources jsonb not null default '{}',     -- same keys -> "ai" | "analyst" | "missing"
  model_used text,

  -- candidate: identified on the review board, name + approx position only, no fields yet.
  -- draft: fields extracted, not yet looked at by a human -- must never reach dedup/export.
  -- confirmed: human-reviewed (box-draw flow, or an accepted draft).
  status text not null default 'confirmed',
  source text not null default 'box_draw',       -- box_draw | whole_image | candidate_board
  candidate_name text,                           -- model-given display name while status = 'candidate'
  confidence_score numeric,                      -- self-reported by whole-image/candidate extraction
  analyst_notes text,                            -- freeform analyst hint attached before processing a candidate

  duplicate_of uuid references products(id) on delete set null,
  duplicate_confidence real,

  created_at timestamptz not null default now()
);

create index if not exists idx_project_images_project_id on project_images(project_id);
create index if not exists idx_project_images_store_id on project_images(store_id);
create index if not exists idx_products_project_id on products(project_id);
create index if not exists idx_products_image_id on products(image_id);

-- ── cost tracking ───────────────────────────────────────────────────────
-- Atomic increment via .rpc() -- avoids a read-modify-write race when
-- concurrent extraction calls are in flight for the same project.
create or replace function increment_project_cost(pid uuid, amount numeric)
returns numeric as $$
declare
  new_total numeric;
begin
  update projects set total_cost_usd = total_cost_usd + amount
  where id = pid
  returning total_cost_usd into new_total;
  return new_total;
end;
$$ language plpgsql;

-- ── Storage ─────────────────────────────────────────────────────────────
-- A public Storage bucket is also required (shelf photos, crops, and the
-- original uploaded Excel template all live here). Buckets can't be created
-- from plain SQL -- create it from Dashboard -> Storage -> New bucket, name
-- it exactly `project-files`, and mark it Public. (`npm run db:setup`, see
-- the main README, does this for you via the Supabase JS client instead.)
