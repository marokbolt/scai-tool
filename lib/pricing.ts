// Real per-million-token pricing, verified 2026-09-22 (claude.com/pricing;
// OpenRouter /api/v1/models). Not guessed -- Opus figure cross-checked
// against the earlier pipeline-prototype scripts and matches exactly.
export const PRICING_PER_MILLION: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
  "claude-sonnet-4-6": { input: 2.0, output: 10.0 },
  "claude-opus-4-6": { input: 5.0, output: 25.0 },
  "google/gemini-2.5-flash": { input: 0.3, output: 2.5 },
};

// Hard ceiling across the WHOLE deployment, not per-project -- creating a
// second project to test something else must not reset the budget.
export const GLOBAL_COST_LIMIT_USD = 10;

export function computeCost(model: string, inputTokens: number, outputTokens: number): number {
  const rate = PRICING_PER_MILLION[model];
  if (!rate) return 0;
  return (inputTokens / 1e6) * rate.input + (outputTokens / 1e6) * rate.output;
}

export interface CallRecord {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  latency_ms: number;
  timestamp: string;
}

// ── Per-project budget, layered on top of GLOBAL_COST_LIMIT_USD ────────────
// A second, project-scoped ceiling. The global cap above must never be
// removed or relaxed by this -- a project is blocked the moment EITHER its
// own budget or the shared global budget is used up.
//
// A project with cost_limit_usd falsy, null, or exactly 0 is treated as "no
// project-specific limit configured" (falls back to the global cap alone)
// rather than as a real $0 cap that would block every call -- every project
// created through /api/ingest today sets cost_limit_usd: 10, but older rows
// predating that field, or ones created some other way, could still land
// here with 0/null/undefined. A NEGATIVE value, by contrast, can only be bad
// data (nothing in this app ever writes one) -- treated as fail-safe
// "already over budget" rather than silently falling back to the global cap.
export interface CostCapSubject {
  total_cost_usd: number;
  cost_limit_usd: number;
}

export type CostCapResult =
  | { blocked: false }
  | { blocked: true; cap: "project" | "global"; message: string };

export function checkCostCaps(project: CostCapSubject, globalTotal: number): CostCapResult {
  if (project.cost_limit_usd < 0) {
    return {
      blocked: true,
      cap: "project",
      message: `This project has an invalid (negative) budget configured and is paused until that's corrected.`,
    };
  }
  const hasProjectLimit = project.cost_limit_usd > 0;
  if (hasProjectLimit && project.total_cost_usd >= project.cost_limit_usd) {
    return {
      blocked: true,
      cap: "project",
      message: `This project's $${project.cost_limit_usd.toFixed(2)} budget is used up ($${project.total_cost_usd.toFixed(2)} spent). Extraction is paused for this project -- ask for its budget to be raised to continue.`,
    };
  }
  if (globalTotal >= GLOBAL_COST_LIMIT_USD) {
    return {
      blocked: true,
      cap: "global",
      message: `The shared $${GLOBAL_COST_LIMIT_USD.toFixed(2)} safety cap across all projects is reached ($${globalTotal.toFixed(2)} spent). Extraction is paused everywhere.`,
    };
  }
  return { blocked: false };
}

// ── Pre-batch cost estimates (Epic 5) ───────────────────────────────────────
// APPROXIMATIONS, not measured figures -- there is no persisted per-call log
// to sample a real average from (lib/db.ts only keeps running totals, not
// individual CallRecord rows; CallRecord above only ever lives in client
// memory for the session's CostTracker popover). Derived instead from:
//  - Anthropic's own image-tokenizing rule of thumb, tokens ~= (w*h)/750,
//    and the fact that the API auto-downsamples anything above ~1568px on
//    the long edge before tokenizing -- so a typical shelf photo, however
//    large the original, lands around that same ceiling once billed.
//  - The actual prompt text built in lib/extraction-prompt.ts: the
//    per-candidate/per-crop prompts repeat the project's ~30-46 column list
//    twice (once as "FIELDS TO FILL", once in the trailing JSON skeleton)
//    plus several paragraphs of instructions; the identification prompt is
//    much shorter (no per-column repetition).
// Treat these as a "should I think twice about this batch" nudge in the UI,
// never as a billing-accurate number.
const TYPICAL_IMAGE_TOKENS = 1600; // ~1568x1176 shelf photo at the API's auto-downsample ceiling
const TYPICAL_CANDIDATE_EXTRACTION_PROMPT_TOKENS = 1200; // schema repeated twice + instructions, ~30-46 fields
const TYPICAL_CANDIDATE_EXTRACTION_OUTPUT_TOKENS = 500; // a filled ~30-46 field JSON object
const TYPICAL_IDENTIFICATION_PROMPT_TOKENS = 300; // no per-column repetition
const TYPICAL_IDENTIFICATION_OUTPUT_TOKENS = 800; // a dense shelf can list 15-30 short {name,x,y,w,h} objects

// Mirrors CLAUDE_EXTRACTION_MODELS in lib/claude.ts (not imported directly --
// that module also constructs the server-only Anthropic client, and must
// never end up in a client bundle; CandidateBoard/ReviewWorkspace are client
// components that need this tier->model_id mapping purely for the cost
// estimate display). Keep in sync by hand if lib/claude.ts changes.
export const EXTRACTION_TIER_MODELS: Record<string, string> = {
  "claude-haiku": "claude-haiku-4-5",
  "claude-sonnet": "claude-sonnet-4-6",
  "claude-opus": "claude-opus-4-6",
};

function resolveModelId(model: string): string {
  return EXTRACTION_TIER_MODELS[model] ?? model;
}

// Both estimate functions return null (not 0) for a model with no known
// pricing -- "claude-sonnet"/etc. always resolve via EXTRACTION_TIER_MODELS,
// but the shared ExtractionModel type (lib/claude.ts, reused by
// BoxDrawTool's dropdown) also allows "openrouter", which has no entry here.
// Not reachable today (ReviewWorkspace's own model select only ever offers
// the three Claude tiers), but a silent "$0.000 est." for an unpriced model
// would read as "this is free," which is actively wrong, not just vague --
// callers should hide the estimate entirely when this returns null, never
// treat null as 0.

// Estimated cost of processing `count` selected candidates through the
// per-candidate field-extraction call (POST /api/products/[id]/extract-candidate).
export function estimateCandidateExtractionCost(model: string, count: number): number | null {
  const modelId = resolveModelId(model);
  if (!PRICING_PER_MILLION[modelId]) return null;
  const perItem = computeCost(
    modelId,
    TYPICAL_IMAGE_TOKENS + TYPICAL_CANDIDATE_EXTRACTION_PROMPT_TOKENS,
    TYPICAL_CANDIDATE_EXTRACTION_OUTPUT_TOKENS
  );
  return perItem * Math.max(0, count);
}

// Estimated cost of one candidate-identification call (POST /api/identify-candidates).
export function estimateIdentificationCost(model: string): number | null {
  const modelId = resolveModelId(model);
  if (!PRICING_PER_MILLION[modelId]) return null;
  return computeCost(modelId, TYPICAL_IMAGE_TOKENS + TYPICAL_IDENTIFICATION_PROMPT_TOKENS, TYPICAL_IDENTIFICATION_OUTPUT_TOKENS);
}
