import type { Project, BoundingBox } from "./types";

// Built once per project from the schema/context captured at ingest time
// (lib/claude.ts buildIngestPrompt), then reused for every single-crop
// extraction call. This is the "system prompt that goes with each crop" --
// it did not exist until now; ingest only produced the raw ingredients.
export function buildExtractionPrompt(project: Project, analystNotes?: string | null): string {
  const columnsBlock = project.schema_json
    .map((c) => `- "${c.key}": ${c.header}`)
    .join("\n");

  return `You are an expert retail store auditor. You are shown ONE cropped photo of a single product, hand-boxed by a human analyst from a shelf photo. Your only job is to fill in the structured fields for this one product.

CATEGORY: ${project.context_json.category ?? "unspecified"}

CATEGORY / SEGMENT DEFINITIONS (use these to judge scope and choose enum-like values):
${project.context_json.segments_text ?? "(none provided)"}

TEMPLATE NOTES:
${project.context_json.raw_notes ?? "(none)"}
${
  analystNotes?.trim()
    ? `\nANALYST'S OWN RESEARCH NOTES ON THIS SPECIFIC PRODUCT (treat as a strong hint, not gospel -- still read the image yourself, but trust the analyst over your own guess for facts they clearly researched, like a price they looked up elsewhere):\n${analystNotes.trim()}\n`
    : ""
}
FIELDS TO FILL (use exactly these JSON keys):
${columnsBlock}

INSTRUCTIONS:
1. First decide "in_scope": true if this crop shows a real product belonging to the category above, false if it's something else (a different category, a price tag with no product, a bottle cap, a shelf edge, etc).
2. If in_scope is false, still return the JSON object with all fields null except in_scope and a short "reason" field explaining why.
3. If in_scope is true, fill every field you can read directly from the image first.
4. Read labels in any language visible.
5. You have a web_search tool. Use it ONLY to look up stable, store-independent facts you could not read from the image -- things like the manufacturer/parent company, or the country where the product is manufactured, once you've identified the brand and product from the image. These are facts that don't change store to store or day to day, so it's safe to search for them.
6. NEVER use web_search for price, promotional details, shelf count, or anything else specific to this store visit on this day -- those must come from the image alone or the analyst's notes above. If a field like that isn't visible and the analyst didn't note it, set it to null. Do not estimate or guess a plausible-sounding value for it.
7. For any other field that is neither visible in the image, in the analyst's notes, nor a stable fact worth searching for, set it to null rather than guessing.
8. Give an honest "confidence_score" from 0 to 1 for how clearly you could read this product.

Respond ONLY with this JSON object, no markdown fences, no commentary:
{
  "in_scope": true,
  "confidence_score": 0.9,
  "reason": null,
  ${project.schema_json.map((c) => `"${c.key}": null`).join(",\n  ")}
}`;
}

export interface ExtractionResult {
  in_scope: boolean;
  confidence_score: number;
  reason: string | null;
  [key: string]: unknown;
}

// The box-draw flow above asks for one product from one human-cropped image.
// This asks for every distinct product on an UNCROPPED whole shelf photo in
// one call -- validated by hand against real shelf photos (see
// scripts/validate-whole-image-extraction.mjs) before this was wired into
// the app: whole-image reads returned specific, position-grounded products
// ("orange-capped RTD tea bottle, fourth shelf, centre-right"), not
// hallucinated grid patterns, and explicitly skipped what it couldn't read
// rather than guessing. Results land as 'draft' rows for the analyst to
// bulk-review, not auto-confirmed.
export function buildWholeImageExtractionPrompt(project: Project): string {
  const columnsBlock = project.schema_json.map((c) => `- "${c.key}": ${c.header}`).join("\n");

  return `You are an expert retail store auditor. You are shown ONE WHOLE shelf photo (not a single-product crop) from a real store visit. Identify EVERY distinct product visible and fill in the structured fields for each one.

CATEGORY: ${project.context_json.category ?? "unspecified"}

CATEGORY / SEGMENT DEFINITIONS (use these to judge scope and choose enum-like values):
${project.context_json.segments_text ?? "(none provided)"}

TEMPLATE NOTES:
${project.context_json.raw_notes ?? "(none)"}

FIELDS TO FILL per product (use exactly these JSON keys):
${columnsBlock}

INSTRUCTIONS:
1. Scan the whole photo carefully, left to right, top to bottom, shelf by shelf. List every DISTINCT product/SKU you can identify -- if the same product appears multiple times (multiple facings), list it ONCE and note the count in whichever field captures shelf count.
2. For each product, fill every field you can read directly from the image.
3. Read labels in any language visible.
4. You have a web_search tool. Use it SPARINGLY and ONLY for stable, store-independent facts you could not read from the image (manufacturer/parent company, country of manufacture) once you've identified the brand from the image. Never use it for price, promotions, or shelf count.
5. If a field isn't visible for a product, set it to null rather than guessing. Do not fabricate prices, pack sizes, or counts you cannot actually read.
6. Give an honest "confidence_score" (0-1) per product for how clearly you could read it.
7. It is fine and expected to leave out products that are too small, blurry, or distant to read reliably -- do not guess just to fill a row. Note how many such illegible items you skipped in "skipped_count".

Respond ONLY with this JSON object, no markdown fences, no commentary:
{
  "skipped_count": 0,
  "products": [
    {
      "confidence_score": 0.9,
      ${project.schema_json.map((c) => `"${c.key}": null`).join(",\n      ")}
    }
  ]
}`;
}

export interface WholeImageExtractionResult {
  skipped_count: number;
  products: ({ confidence_score: number } & Record<string, unknown>)[];
}

// Cheaper, lighter-weight pass for the candidate review board: identify
// WHAT and roughly WHERE each product is, with no field extraction yet --
// that happens later, per-candidate, only for what the analyst actually
// selects (lib/claude.ts runClaudeExtraction with buildExtractionPrompt).
// Validated by hand (scripts/validate-candidate-positions.mjs) that asking
// for approximate position as a byproduct of already-grounded identification
// -- not as a standalone "find boxes" task, which fabricates grid patterns --
// produces varied, spatially sensible regions good enough to click on.
export function buildCandidateIdentificationPrompt(project: Project): string {
  return `You are an expert retail store auditor looking at a whole shelf photo. Identify every distinct product you can clearly see -- if the same product appears multiple times (multiple facings), list it once.

CATEGORY: ${project.context_json.category ?? "unspecified"}

CATEGORY / SEGMENT DEFINITIONS (use these to judge what's actually in scope):
${project.context_json.segments_text ?? "(none provided)"}

For each product, give a short identifying name (brand + product if visible, otherwise a plain description like "yellow-label bottle, second shelf"), and its APPROXIMATE location as a percentage box (x, y = top-left corner, width, height -- all 0-100). This does not need to be pixel-perfect -- it only needs to roughly cover where the product sits, since an analyst will click on it to select it, not measure it. If you genuinely cannot tell where something is, omit it rather than guessing wildly. Do not invent evenly-spaced products that aren't really there -- only list what you can actually see.

Respond ONLY with this JSON, no markdown fences, no commentary:
{
  "candidates": [
    { "name": "string, brief", "x": 0, "y": 0, "width": 0, "height": 0 }
  ]
}`;
}

export interface CandidateIdentificationResult {
  candidates: { name: string; x: number; y: number; width: number; height: number }[];
}

// Extracts full fields for ONE candidate the board already identified --
// deliberately reuses the SAME whole image (no server-side cropping needed,
// no new image-processing dependency) with a positional pointer to which
// product to focus on, rather than a pre-cropped blob. This also means every
// candidate on one image shares identical image bytes across calls, which is
// what makes prompt caching (Epic 5) possible in the first place.
export function buildCandidateExtractionPrompt(
  project: Project,
  candidateName: string,
  box: BoundingBox,
  analystNotes?: string | null
): string {
  const columnsBlock = project.schema_json.map((c) => `- "${c.key}": ${c.header}`).join("\n");

  return `You are an expert retail store auditor. You are shown a WHOLE shelf photo. One specific product on it has already been identified: "${candidateName}", located at approximately x=${box.x.toFixed(0)}%, y=${box.y.toFixed(0)}%, width=${box.width.toFixed(0)}%, height=${box.height.toFixed(0)}% of the image (percentages from the top-left corner). Focus ONLY on that one product and fill in its structured fields -- ignore every other product visible in the photo.

CATEGORY: ${project.context_json.category ?? "unspecified"}

CATEGORY / SEGMENT DEFINITIONS (use these to judge scope and choose enum-like values):
${project.context_json.segments_text ?? "(none provided)"}

TEMPLATE NOTES:
${project.context_json.raw_notes ?? "(none)"}
${
  analystNotes?.trim()
    ? `\nANALYST'S OWN RESEARCH NOTES ON THIS SPECIFIC PRODUCT (treat as a strong hint, not gospel -- still read the image yourself, but trust the analyst over your own guess for facts they clearly researched, like a price they looked up elsewhere):\n${analystNotes.trim()}\n`
    : ""
}
FIELDS TO FILL (use exactly these JSON keys):
${columnsBlock}

INSTRUCTIONS:
1. First decide "in_scope": true if the identified product belongs to the category above, false otherwise.
2. If in_scope is false, still return the JSON object with all fields null except in_scope and a short "reason".
3. If in_scope is true, fill every field you can read directly from the image for THIS product only.
4. Read labels in any language visible.
5. You have a web_search tool. Use it ONLY for stable, store-independent facts you could not read from the image (manufacturer/parent company, country of manufacture) once you've identified the brand. Never for price, promotions, or shelf count -- those come from the image or the analyst's notes above, or stay null.
6. For any field neither visible, noted by the analyst, nor a stable fact worth searching for, set it to null rather than guessing.
7. Give an honest "confidence_score" (0-1) for how clearly you could read this specific product.

Respond ONLY with this JSON object, no markdown fences, no commentary:
{
  "in_scope": true,
  "confidence_score": 0.9,
  "reason": null,
  ${project.schema_json.map((c) => `"${c.key}": null`).join(",\n  ")}
}`;
}
