# StoreAudit

A web app that speeds up retail store-shelf audits. An analyst uploads a
client's Excel audit template plus photos of a store's shelves; the app
uses Claude (Anthropic's AI) to read each photo and fill in the template's
columns — brand, product description, pack size, price, and so on — so the
analyst reviews and corrects AI-drafted rows instead of typing every field
by hand from scratch.

This README is written for someone opening this codebase for the first
time. It covers what the tool does, how to set it up from zero, how to use
it end to end, and what its real limitations are.

---

## Table of contents

- [What problem this solves](#what-problem-this-solves)
- [How it works, in one paragraph](#how-it-works-in-one-paragraph)
- [Stack](#stack)
- [Setup](#setup)
- [Using the app](#using-the-app)
- [Environment variables, in detail](#environment-variables-in-detail)
- [Database schema](#database-schema)
- [Architecture decisions worth knowing](#architecture-decisions-worth-knowing)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [Project structure](#project-structure)

---

## What problem this solves

A retail store audit means physically visiting a store, photographing every
product on a shelf in a given category, and filling out a client-provided
Excel template with one row per product: brand, description, pack size,
price, country of origin, and whatever other columns that specific client
cares about. Done by hand, turning a stack of shelf photos into a filled
template is slow, repetitive work — an analyst has to zoom into every
photo, read small label text, and type it all into the right columns in
the right format.

StoreAudit doesn't replace the analyst's judgment — it removes the typing.
The analyst still decides what counts as a product and whether the AI read
something correctly; the app's job is to turn "a photo of a shelf" into
"a plausible first draft of every column for every product on it," fast
enough that reviewing and correcting it is dramatically faster than
starting from a blank spreadsheet.

## How it works, in one paragraph

You upload a client's Excel template once per project; the app reads it
with Claude and figures out what columns exist and what sheet/row to write
answers back into later. You then create one or more stores under that
project and upload shelf photos to each. For each photo, you ask the app
to identify every visible product (Claude proposes a name and an
approximate on-image position for each one); you pick which of those
candidates are worth processing, optionally nudge or resize their
position, and the app fills in every template column for each one from a
cropped close-up of just that product. Every field is tagged with where it
came from (AI-extracted, human-corrected, or missing) and shown with a
confidence indicator, so low-confidence or missing fields are easy to spot
during review. Once every image in a store has been worked through, a
single "Finish Review" table lets you make final edits across the whole
store, flags likely duplicate rows, and exports everything by writing
directly into the original Excel template — not a new workbook — so none
of the client's own formatting, formulas, or other sheets are disturbed.

## Stack

- **Next.js 14** (App Router) + **TypeScript**, all in one app — there is
  no separate backend; `app/api/*` route handlers are the entire server
  side.
- **Supabase** — Postgres for data, Storage for photos/crops/the original
  Excel file. No other database or file storage is used.
- **Anthropic Claude** (Haiku, Sonnet, or Opus — selectable per call) does
  every AI step: parsing the uploaded Excel's schema, classifying image
  types, identifying candidate products, and extracting structured fields
  from a crop. An optional Gemini 2.5 Flash model (via OpenRouter) is
  available as an alternate extraction model.
- **ExcelJS** writes the export — it edits the client's own uploaded
  template in place rather than generating a new file.
- **Zod** validates every AI response before the app trusts it.

## Setup

### 1. Prerequisites

- Node.js 18 or newer
- A free [Supabase](https://supabase.com) account (one project is enough)
- An [Anthropic API key](https://console.anthropic.com) with some
  available credit — this is what actually costs money per extraction (see
  [cost caps](#architecture-decisions-worth-knowing) below for built-in
  spend limits)
- Optional: an [OpenRouter](https://openrouter.ai) API key, only if you
  want the Gemini extraction-model option. Everything else works without it.

### 2. Clone and install

```bash
git clone <this-repo-url> storeaudit
cd storeaudit
npm install
```

### 3. Create a Supabase project and set up the database

1. Create a new project at [supabase.com](https://supabase.com) (any
   region; pick one close to you).
2. In the Supabase dashboard, open **SQL Editor → New query**, paste in the
   entire contents of [`supabase/schema.sql`](supabase/schema.sql), and run
   it. This creates every table, index, and function the app needs. It's
   safe to re-run if you ever need to.
3. Go to **Project Settings → API** and note down:
   - **Project URL** (`NEXT_PUBLIC_SUPABASE_URL`)
   - **anon / public key** (`NEXT_PUBLIC_SUPABASE_ANON_KEY`)
   - **service_role key** (`SUPABASE_SERVICE_ROLE_KEY`) — keep this one
     secret, it bypasses all row-level security

### 4. Configure environment variables

```bash
cp .env.example .env.local
```

Fill in `.env.local` with the values above plus your Anthropic (and
optionally OpenRouter) API keys. See
[Environment variables, in detail](#environment-variables-in-detail) below
for what each one does.

### 5. Create the Storage bucket

The app needs one public Storage bucket, `project-files`, for uploaded
photos, crops, and the original Excel template. Create it automatically:

```bash
npm run db:setup
```

(Or create it manually in the Supabase dashboard: **Storage → New bucket**,
name it exactly `project-files`, mark it **Public**.)

### 6. Run it

```bash
npm run dev
```

Open [http://localhost:3100](http://localhost:3100) (this app runs on port
3100, not Next's default 3000 — see `package.json`).

### Before deploying anywhere

Always run a full production build before shipping a change, not just a
type-check:

```bash
npm run build
```

Next's production build also runs ESLint, which catches real issues (an
unused variable, an implicit `any`) that `tsc --noEmit` alone misses and
that will otherwise fail a real deployment.

---

## Using the app

### 1. Create a project

From the home page, click **New Project**, give it a name, and upload the
client's Excel audit template. Claude reads the file and works out:

- the ordered list of columns (and their exact header text)
- which sheet and header row the real data-entry table lives on (so export
  can write back to the exact right place later)
- the category/segment definitions and any other context in the template

You'll see what it parsed before anything else can happen — review it, and
if it looks right, **approve the schema**. This is a deliberate checkpoint:
nothing else (creating stores, uploading images) is allowed until you've
confirmed the app understood the template correctly, since every later
step depends on that understanding being right.

### 2. Create a store and upload photos

A project can cover more than one physical store (useful if you're
auditing the same category across several retailers or locations under one
client engagement). Inside the project, create a store, then upload the
shelf photos taken there. Each image is automatically classified by type
(storefront / aisle / shelf / product close-up) as it comes in.

### 3. Review workspace — the main screen

Open any uploaded image and you have two ways to turn it into product rows:

- **Identify Products (candidate board)** — the primary flow. Click
  "Identify Products" and Claude proposes every visible product on that
  photo, each with a name and an approximate bounding box (good enough to
  click on, not a precise outline). You then decide which candidates are
  actually worth processing — select individually, use keyboard shortcuts,
  or select everything and run a global batch across every image in the
  store at once. Before processing, you can resize or nudge a candidate's
  box, add a manual crop for anything the model missed entirely, or attach
  a short free-text hint (e.g. "this one was on sale, ignore the shelf
  tag") that steers the extraction without forcing an answer.
- **Draw a box (manual)** — the older, simpler flow, still useful for image
  types where there's just one subject (e.g. a close-up of a single
  product) or when you'd rather point at exactly one thing yourself: draw
  a box by hand and the app fills in every column for whatever's inside it.

Either way, once a candidate is processed you get a confidence indicator
and an editable summary of every field, right there in the review screen —
you never have to leave it to make a correction.

### 4. Finish Review

Once every image in a store has been worked through, go to **Finish
Review**. This is one big editable table across every product found in
that store:

- Edit any cell inline.
- Accept or reject any AI-drafted row.
- Run the duplicate-detection pass — a deterministic check (no AI call;
  it compares field values directly) that flags likely repeat rows, for
  example the same product photographed from two overlapping angles. You
  make the final call on anything it flags.

### 5. Export

Click Export. The app writes every approved row directly into the
**original uploaded template** — same sheet, same header row, same
formatting, every other sheet and formula untouched — rather than
generating a new workbook. Every cell is color-coded by where its value
came from (AI-extracted, analyst-corrected, or missing), matching the same
legend an analyst would already expect from a manually-produced audit file.

---

## Environment variables, in detail

See [`.env.example`](.env.example) for the full, copy-pasteable list. Summary:

| Variable | Required | Used for |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Every AI step: Excel schema parsing, image classification, candidate identification, field extraction (`lib/claude.ts`) |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Your Supabase project's URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Used client-side for direct browser-to-Storage uploads via signed URLs (`lib/supabase-browser.ts`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Server-side only (`lib/db.ts`, `lib/storage.ts`) — bypasses row-level security, never expose this to the browser or prefix it `NEXT_PUBLIC_` |
| `OPENROUTER_API_KEY` | No | Only needed for the optional Gemini 2.5 Flash extraction-model option (`lib/openrouter.ts`) |

---

## Database schema

Everything lives in [`supabase/schema.sql`](supabase/schema.sql) with
inline comments explaining each column; the short version:

- **`projects`** — one row per audit project. Holds the parsed Excel
  schema (`schema_json`), parsed category/context (`context_json`), the
  original template kept byte-for-byte in Storage, two independent
  approval checkpoints (`schema_approved_at` for the parsed-template
  confirmation, `approved_at`/`status` for the final audit sign-off), and
  cost tracking (`total_cost_usd`, `cost_limit_usd`, default $10).
- **`stores`** — a project can span multiple physical stores, each with
  independent images and review progress.
- **`project_images`** — one row per uploaded photo, with its
  auto-classified `image_type` and whether it's been fully reviewed.
- **`products`** — one row per identified/extracted product. `status`
  tracks where it is in the pipeline (`candidate` → `draft` → `confirmed`);
  `fields` + `field_sources` hold the actual column values and where each
  one came from; `box_json` records where on the source image it was
  found; `duplicate_of`/`duplicate_confidence` back the dedup pass.
- A Postgres function, `increment_project_cost`, atomically increments a
  project's running cost — called via `.rpc()` so concurrent extraction
  calls can't race each other into a wrong total.
- One public Storage bucket, `project-files`, holds everything binary:
  `{project_id}/{uuid}.ext` for photos and crops,
  `{project_id}/template.xlsx` for the original uploaded Excel.

## Architecture decisions worth knowing

- **Cost caps are real and server-enforced**, not just a number shown in
  the UI. Every paid call checks the project's running total against its
  cap first, and increments it atomically afterward. Under real
  concurrency, a few calls launched in the same instant can each pass the
  check before any one of them has posted its increment — an accepted,
  small, bounded overshoot (at most a few calls' worth of cost) rather
  than building distributed locking for what is a single-analyst tool.
- **Photos upload directly from the browser to Supabase Storage**, never
  through a Next.js API route. This is a direct fix for a real bug: a
  serverless hosting platform's request-body limit (commonly a few MB on
  free/hobby tiers) killed uploads of more than a couple of real photos
  when they went through the server first.
- **Candidate identification deliberately asks for approximate
  positions, not precise ones** — explicitly framed to the model as "for
  click-target purposes." A human confirms or adjusts every position
  before it's processed, so the app never depends on the AI's spatial
  accuracy being exact.
- **No authentication, by design.** This is built as a single-team
  internal tool: every project is visible to anyone with the URL, and
  there's no login. Data is still fully isolated per project/store at the
  database level, and cost caps are enforced per project — but there is no
  private workspace. Don't deploy this somewhere public without adding
  auth first if that matters for your use case.
- **Default extraction model is Claude Haiku** — the cheapest tier that
  still supports Claude's `web_search` tool (used as a fallback when a
  field like price or country of origin can't be read from the image
  itself). Sonnet, Opus, and Gemini remain selectable per call if Haiku
  proves too weak for a particular project's images.
- **Export edits the original file, not a fresh one.** Real client
  templates can carry hidden validation sheets, formulas, and formatting
  that a from-scratch rebuild would silently discard — export finds the
  first empty row after the template's own header (and after any
  pre-populated seed rows) and writes only there.

## Known limitations

These are real, current gaps — not fixed yet, and worth knowing before you
rely on this for anything beyond a single-analyst trial:

- **No automated tests.** The cost-cap logic and the Excel export's
  cell-styling logic are both pure functions and would be the
  highest-value first additions if you want to add coverage.
- **No store deletion** — there's no API or UI for it yet.
- **Bulk field correction is scoped to one image**, not the whole store —
  if the AI consistently mislabels something across every photo, you
  currently correct it once per image rather than everywhere at once.
- **No authentication or multi-tenant isolation** beyond per-project data
  scoping (see above) — fine for one internal analyst, not something to
  expose publicly as-is.
- **A very large Excel template could still exceed a serverless hosting
  platform's request-size limit** on the template-upload step — only the
  photo-upload path was moved off that limit, not the initial template
  upload. Not an issue for a typical few-MB template, a real risk for an
  unusually large one.
- **Finish Review's inline cell edit is optimistic** — it updates the
  screen immediately and saves in the background, with only a generic
  error banner (not a rollback) if the save actually fails.

## Troubleshooting

- **"Extract" does nothing, or fails silently.** If you're running this
  somewhere other than localhost and your photos are served from a
  different origin than the app itself, make sure any `<img>` element used
  to build a crop sets `crossOrigin="anonymous"` (already done in this
  codebase) — otherwise browsers silently block reading pixel data from a
  cross-origin image, often as an easy-to-miss unhandled promise
  rejection rather than a visible error.
- **A fix "isn't working" after you just made it.** Next.js's dev-mode
  Fast Refresh plus a lot of interaction in one browser tab can leave
  genuinely confusing stale state (a button stuck mid-action from an
  earlier failed attempt, old console errors resurfacing). Retest in a
  fresh browser tab before concluding a fix didn't take.
- **A model call 400s with something like "does not support programmatic
  tool calling."** Some Claude model snapshots require
  `allowed_callers: ["direct"]` to be set explicitly on the `web_search`
  tool definition — already handled in `lib/claude.ts`, but worth knowing
  if you add a new model option.
- **Supabase's "Direct connection" string only resolves over IPv6** on
  some networks, which can make a raw Postgres client (e.g. a one-off
  migration script using the `pg` package) silently hang or fail to
  connect. The app itself never needs a direct Postgres connection — it
  talks to Supabase entirely over HTTPS via `@supabase/supabase-js`
  (`lib/db.ts`, `lib/storage.ts`) — so this only matters if you write your
  own standalone scripts against the database. If you do, use Supabase's
  **session pooler** connection string instead of the direct one.

## Project structure

```
app/
  page.tsx                                    home — list of projects
  projects/new/page.tsx                       create a project, upload the Excel template
  projects/[id]/page.tsx                      project hub — approve schema, manage stores
  projects/[id]/stores/[storeId]/upload/      upload shelf photos to a store
  projects/[id]/stores/[storeId]/review/      the main review workspace
  projects/[id]/stores/[storeId]/finish/      Finish Review — final table + export
  api/                                        every server-side route (ingest, extract,
                                               identify-candidates, dedup, export, etc.)
components/
  review/            CandidateBoard, BoxDrawTool, ReviewWorkspace, FieldForm, CostTracker
  finish/            FinishWorkspace
  project/           ProjectHub
  nav/, ui/          shared chrome and primitives
lib/
  claude.ts          Anthropic SDK wrapper + every prompt template
  openrouter.ts       optional Gemini extraction path
  db.ts              all Supabase Postgres access
  storage.ts         all Supabase Storage access
  excel-dump.ts      the ExcelJS export logic (edits the original template in place)
  extraction-prompt.ts, llm-schemas.ts, pricing.ts, types.ts
supabase/
  schema.sql         run this once against a fresh Supabase project
scripts/
  setup-storage-bucket.mjs   creates the project-files bucket (npm run db:setup)
```
