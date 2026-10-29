// Validates the JSON every Claude call in this app is asked to return,
// before any of it is trusted downstream. Previously every call site did
// `JSON.parse(match[0]) as SomeType` -- a blind cast, not a check -- so a
// response missing a field, or with the wrong type for one, would silently
// write `undefined`/garbage into the DB and corrupt it silently (most
// seriously: the client-facing Excel export, built from whatever ingest's
// JSON.parse produced for the project's schema).
//
// Per-project dynamic fields (the schema_json-driven product fields) can't
// be validated here since their keys vary project to project -- those
// schemas use `.passthrough()` to accept them unexamined while still
// validating the fixed envelope fields every response must have.
import { z } from "zod";

export const IngestResultSchema = z.object({
  sheet_name: z.string().min(1),
  header_row: z.number().int().positive(),
  category: z.string().nullable(),
  segments_text: z.string().nullable(),
  raw_notes: z.string().nullable(),
  schema: z.array(z.object({ header: z.string(), key: z.string().min(1) })).min(1),
});

export const CandidateIdentificationResultSchema = z.object({
  candidates: z.array(
    z.object({
      name: z.string(),
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
  ),
});

// Single-crop extraction (lib/extraction-prompt.ts buildExtractionPrompt /
// buildCandidateExtractionPrompt) -- shared by /api/extract and
// /api/products/[id]/extract-candidate.
export const ExtractionResultSchema = z
  .object({
    in_scope: z.boolean(),
    confidence_score: z.number(),
    reason: z.string().nullable().optional(),
  })
  .passthrough();

export const WholeImageExtractionResultSchema = z.object({
  skipped_count: z.number().optional(),
  truncated: z.boolean().optional(),
  products: z.array(z.object({ confidence_score: z.number() }).passthrough()),
});

// Formats a zod error into one line suitable for an API error response --
// detailed enough to debug, not a raw stack of zod internals.
export function formatZodError(label: string, error: z.ZodError): string {
  const first = error.issues[0];
  const path = first?.path.join(".") || "(root)";
  return `${label}: ${first?.message ?? "invalid shape"} at "${path}"`;
}
