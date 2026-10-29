import Anthropic from "@anthropic-ai/sdk";
import { IngestResultSchema, formatZodError } from "./llm-schemas";

let _client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY!,
      timeout: 90 * 1000,
      maxRetries: 2,
    });
  }
  return _client;
}

export const INGEST_MODEL = "claude-opus-4-6"; // structural reasoning over a whole template, worth the higher tier once per project
export const CLASSIFY_MODEL = "claude-haiku-4-5"; // one-word-ish tag per image, cheapest tier

// Claude tiers in the Epic 1 model bake-off -- Haiku alone under-reasoned and
// never used web_search (confirmed by hand-testing), so all three tiers are
// offered side by side rather than guessing which one is "cheapest but best."
export const CLAUDE_EXTRACTION_MODELS = {
  "claude-haiku": "claude-haiku-4-5",
  "claude-sonnet": "claude-sonnet-4-6",
  "claude-opus": "claude-opus-4-6",
} as const;
export type ClaudeExtractionTier = keyof typeof CLAUDE_EXTRACTION_MODELS;

export function buildIngestPrompt(sheetsDump: string): string {
  return `You are setting up a retail store audit project from a client-supplied Excel template. Below is a dump of every sheet in the uploaded workbook (sheet name, then up to the first 40 rows of raw cell values, row-indexed).

Your job: figure out the structure of the PRIMARY data-entry sheet (the one analysts fill in with one row per product) and any category/segment definitions found elsewhere in the workbook (often a separate "Category Definitions" or similar sheet, or a general-background sheet).

WORKBOOK DUMP:
${sheetsDump}

INSTRUCTIONS:
1. Identify which sheet is the primary per-product data-entry sheet, and which row in it is the real header row (client templates often have title/instruction rows above the real header — e.g. header on row 2, or row 13).
2. Report that sheet's EXACT name (matching the "### Sheet:" label above, case and spacing included) as "sheet_name", and that header row's 1-indexed row number as "header_row" -- these will be used to write approved rows back into this exact sheet in the original file later, so they must be exact.
3. Extract the ordered list of column headers from that header row, skipping any completely empty columns.
4. For each header, produce a short slug "key" (lowercase, underscores, no special characters) to use as a JSON field name.
5. If any sheet contains category or segment definitions (naming which brands/products belong to which segment), summarize that as plain text in "segments_text" -- this is important context for later product classification, so include real examples/brand names it gives, not just segment names.
6. Identify the overall product category being audited (e.g. "Water Enhancer", "RTD Tea") if stated or inferable.
7. Note anything else useful for an AI extracting product data against this template in "raw_notes" (e.g. currency, market, unusual field meanings).

Respond ONLY with this JSON, no markdown fences, no commentary:
{
  "sheet_name": string,
  "header_row": number,
  "category": string or null,
  "segments_text": string or null,
  "raw_notes": string or null,
  "schema": [{ "header": string, "key": string }]
}`;
}

export interface IngestResult {
  sheet_name: string;
  header_row: number;
  category: string | null;
  segments_text: string | null;
  raw_notes: string | null;
  schema: { header: string; key: string }[];
}

export async function runIngest(
  sheetsDump: string
): Promise<{ result: IngestResult; model: string; input_tokens: number; output_tokens: number }> {
  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: INGEST_MODEL,
    max_tokens: 4096,
    messages: [{ role: "user", content: buildIngestPrompt(sheetsDump) }],
  });
  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Ingest response was not parseable JSON: ${text.slice(0, 200)}`);
  // A malformed/incomplete shape here would otherwise corrupt a whole
  // project's schema silently -- validated before anything downstream
  // (store creation, every extraction prompt, the Excel export) trusts it.
  const parsed = IngestResultSchema.safeParse(JSON.parse(match[0]));
  if (!parsed.success) {
    throw new Error(formatZodError("Ingest response had an unexpected shape", parsed.error));
  }
  return {
    result: parsed.data as IngestResult,
    model: response.model,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
  };
}

export async function runClaudeExtraction(
  base64: string,
  mediaType: string,
  prompt: string,
  tier: ClaudeExtractionTier = "claude-haiku"
): Promise<{ text: string; model: string; input_tokens: number; output_tokens: number }> {
  const client = getAnthropicClient();
  const model = CLAUDE_EXTRACTION_MODELS[tier];
  const response = await client.messages.create({
    model,
    max_tokens: 1536,
    // allowed_callers required for models (Haiku snapshots) that don't support
    // programmatic/parallel tool calling by default -- forces direct-only use.
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 2, allowed_callers: ["direct"] }],
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType as "image/jpeg" | "image/png", data: base64 } },
          { type: "text", text: prompt },
        ],
      },
    ],
  });
  // With web_search, the model may emit multiple text blocks interleaved with
  // tool_use/tool_result blocks -- concatenate all text blocks, not just the first.
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  return {
    text,
    model,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
  };
}

// Whole-image extraction can legitimately list 30-60+ products on a dense
// shelf at ~46 fields each -- confirmed by hand-testing that this blows past
// a few thousand output tokens, and the SDK requires streaming (not
// .create()) once a response might run past its non-streaming timeout
// estimate. web_search is capped lower than the single-crop path (3 vs 2 is
// already generous per-crop; a whole image could otherwise trigger dozens of
// lookups across every product it finds).
export async function runClaudeWholeImageExtraction(
  base64: string,
  mediaType: string,
  prompt: string,
  tier: ClaudeExtractionTier = "claude-sonnet"
): Promise<{ text: string; model: string; input_tokens: number; output_tokens: number }> {
  const client = getAnthropicClient();
  const model = CLAUDE_EXTRACTION_MODELS[tier];
  const stream = client.messages.stream({
    model,
    max_tokens: 48000,
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 3, allowed_callers: ["direct"] }],
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType as "image/jpeg" | "image/png", data: base64 } },
          { type: "text", text: prompt },
        ],
      },
    ],
  });
  const response = await stream.finalMessage();
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  return {
    text,
    model,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
  };
}

// Name + approximate position only, no field extraction -- the cheap, fast
// pass that populates the candidate review board. Tighter token budget than
// the full whole-image extraction since output is just short names and
// numbers, not 30-46 fields per product.
export async function runClaudeCandidateIdentification(
  base64: string,
  mediaType: string,
  prompt: string,
  tier: ClaudeExtractionTier = "claude-sonnet"
): Promise<{ text: string; model: string; input_tokens: number; output_tokens: number }> {
  const client = getAnthropicClient();
  const model = CLAUDE_EXTRACTION_MODELS[tier];
  const stream = client.messages.stream({
    model,
    max_tokens: 16000,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType as "image/jpeg" | "image/png", data: base64 } },
          { type: "text", text: prompt },
        ],
      },
    ],
  });
  const response = await stream.finalMessage();
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  return {
    text,
    model,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
  };
}

export async function classifyImage(
  base64: string,
  mediaType: string
): Promise<{ type: string; model: string; input_tokens: number; output_tokens: number }> {
  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: CLASSIFY_MODEL,
    max_tokens: 32,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType as "image/jpeg" | "image/png", data: base64 } },
          {
            type: "text",
            text: `Classify this retail audit photo as exactly one of: storefront, aisle, shelf, product_solo. storefront = outside of the store or its entrance sign. aisle = a wide shot showing multiple shelf sections or an aisle. shelf = a close/medium shot of one shelf section with products readable. product_solo = a close-up of a single product. Respond with ONLY the one lowercase word, nothing else.`,
          },
        ],
      },
    ],
  });
  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  const cleaned = text.trim().toLowerCase();
  const valid = ["storefront", "aisle", "shelf", "product_solo"];
  return {
    type: valid.includes(cleaned) ? cleaned : "shelf",
    model: response.model,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
  };
}
