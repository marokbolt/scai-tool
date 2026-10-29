import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import {
  getProject,
  getImage,
  listProductsByImage,
  addProducts,
  incrementProjectCost,
  getGlobalTotalCost,
} from "@/lib/db";
import { downloadFile } from "@/lib/storage";
import { buildWholeImageExtractionPrompt, type WholeImageExtractionResult } from "@/lib/extraction-prompt";
import { runClaudeWholeImageExtraction, CLAUDE_EXTRACTION_MODELS, type ClaudeExtractionTier } from "@/lib/claude";
import { computeCost, checkCostCaps, GLOBAL_COST_LIMIT_USD } from "@/lib/pricing";
import { WholeImageExtractionResultSchema, formatZodError } from "@/lib/llm-schemas";
import { ZodError } from "zod";
import type { ProductRow, FieldSource } from "@/lib/types";

// A dense real shelf can produce 30-60+ products at ~40+ fields each, which
// can still outrun even a generous max_tokens budget (confirmed by hand
// testing). Rather than discard a response that's already been paid for the
// moment it's cut off mid-object, recover every COMPLETE product that
// appeared before the cutoff: find the last fully-closed product object
// (the last "}," before whatever broke), cut there, and close the array/
// object ourselves. Only a response truncated inside its very first product
// (nothing complete to recover) still surfaces as a hard failure.
function parseWholeImageResult(text: string): { result: WholeImageExtractionResult; truncated: boolean } {
  const match = text.match(/\{[\s\S]*\}/);
  const raw = match ? match[0] : text;
  let parsedJson: unknown;
  let truncated = false;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    const lastCompleteObjEnd = raw.lastIndexOf("},");
    if (lastCompleteObjEnd === -1) {
      throw new Error("Model did not return parseable JSON, and no complete product could be salvaged from a truncated response");
    }
    const salvaged = raw.slice(0, lastCompleteObjEnd + 1) + "]}";
    parsedJson = JSON.parse(salvaged); // lets a genuine JSON.parse failure here propagate uncaught, same as before
    truncated = true;
  }
  // Validated, not just cast -- checked as its own step (not folded into the
  // JSON.parse try/catch above) so a validly-parsed-but-wrong-shaped response
  // fails as a clear shape error instead of being mistaken for truncation and
  // triggering a nonsensical salvage attempt on already-valid JSON text.
  const result = WholeImageExtractionResultSchema.parse(parsedJson) as WholeImageExtractionResult;
  return { result, truncated };
}

// Auto-extracts every product from a WHOLE shelf photo in one call, instead
// of requiring the analyst to box each one by hand -- validated against real
// shelf photos first (scripts/validate-whole-image-extraction.mjs) before
// being wired in here. Results land as 'draft' rows the analyst bulk-reviews
// in Finish Review (accept/edit/reject), never auto-confirmed and never
// exported until a human has looked at them.
export async function POST(req: NextRequest) {
  const { project_id, image_id, model, force } = (await req.json()) as {
    project_id: string;
    image_id: string;
    model?: string;
    force?: boolean;
  };

  const project = await getProject(project_id);
  if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });
  const image = await getImage(image_id);
  if (!image || image.project_id !== project_id) {
    return NextResponse.json({ error: "image not found" }, { status: 404 });
  }

  if (!force) {
    const existing = await listProductsByImage(image_id);
    if (existing.some((p) => p.source === "whole_image")) {
      return NextResponse.json(
        { error: "This image already has auto-extracted drafts. Pass force to re-run and add more.", already_extracted: true },
        { status: 409 }
      );
    }
  }

  const globalTotal = await getGlobalTotalCost();
  const capCheck = checkCostCaps(project, globalTotal);
  if (capCheck.blocked) {
    return NextResponse.json(
      {
        error: capCheck.message,
        cost_limit_reached: true,
        cap_type: capCheck.cap,
        project_total_cost_usd: project.total_cost_usd,
        global_total_cost_usd: globalTotal,
        cost_limit_usd: GLOBAL_COST_LIMIT_USD,
        project_cost_limit_usd: project.cost_limit_usd,
      },
      { status: 402 }
    );
  }

  const buffer = await downloadFile(image.storage_path);
  const base64 = buffer.toString("base64");
  const mediaType = "image/jpeg";
  const prompt = buildWholeImageExtractionPrompt(project);
  const tier = (model && model in CLAUDE_EXTRACTION_MODELS ? model : "claude-sonnet") as ClaudeExtractionTier;

  try {
    const { text, model: modelUsed, input_tokens, output_tokens } = await runClaudeWholeImageExtraction(
      base64,
      mediaType,
      prompt,
      tier
    );
    const cost_usd = computeCost(modelUsed, input_tokens, output_tokens);
    const newProjectTotal = await incrementProjectCost(project_id, cost_usd);

    let result: WholeImageExtractionResult;
    let truncated: boolean;
    try {
      ({ result, truncated } = parseWholeImageResult(text));
    } catch (parseErr) {
      // Cost was already incurred (real tokens were generated) regardless of
      // whether we could parse anything usable out of them -- still report
      // it so the client's cost tracker/cap stay accurate.
      const message =
        parseErr instanceof ZodError
          ? formatZodError("Model response had an unexpected shape", parseErr)
          : parseErr instanceof Error
            ? parseErr.message
            : "Model did not return parseable JSON";
      return NextResponse.json(
        {
          error: message,
          raw: text.slice(0, 2000),
          project_total_cost_usd: newProjectTotal,
          global_total_cost_usd: globalTotal + cost_usd,
          cost_limit_usd: GLOBAL_COST_LIMIT_USD,
          project_cost_limit_usd: project.cost_limit_usd,
        },
        { status: 502 }
      );
    }

    const rows: ProductRow[] = result.products.map((p) => {
      const { confidence_score, ...rest } = p;
      const fields: Record<string, string | null> = {};
      const fieldSources: Record<string, FieldSource> = {};
      for (const col of project.schema_json) {
        const raw = rest[col.key];
        // The model doesn't reliably output every field as a JSON string --
        // a percentage or a yes/no can come back as a bare number/boolean
        // (0, false). Left as-is, those are falsy in JS and every truthy
        // check downstream (FieldForm's missing-field indicator, etc.)
        // wrongly treats a legitimate "0%" or "No" as not-yet-filled.
        const value = raw == null || raw === "" ? null : String(raw);
        fields[col.key] = value;
        fieldSources[col.key] = value == null ? "missing" : "ai";
      }
      return {
        id: randomUUID(),
        project_id,
        image_id,
        crop_storage_path: "",
        box_json: null,
        fields,
        field_sources: fieldSources,
        model_used: modelUsed,
        status: "draft",
        source: "whole_image",
        confidence_score: typeof confidence_score === "number" ? confidence_score : null,
        candidate_name: null,
        analyst_notes: null,
        duplicate_of: null,
        duplicate_confidence: null,
        created_at: new Date().toISOString(),
      };
    });

    const inserted = rows.length > 0 ? await addProducts(rows) : [];

    return NextResponse.json({
      products: inserted,
      skipped_count: result.skipped_count,
      truncated,
      model_used: modelUsed,
      usage: { input_tokens, output_tokens, cost_usd },
      project_total_cost_usd: newProjectTotal,
      global_total_cost_usd: globalTotal + cost_usd,
      cost_limit_usd: GLOBAL_COST_LIMIT_USD,
      project_cost_limit_usd: project.cost_limit_usd,
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Whole-image extraction failed" },
      { status: 500 }
    );
  }
}
