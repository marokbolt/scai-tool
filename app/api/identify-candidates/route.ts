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
import { buildCandidateIdentificationPrompt } from "@/lib/extraction-prompt";
import { CandidateIdentificationResultSchema, formatZodError } from "@/lib/llm-schemas";
import { runClaudeCandidateIdentification, CLAUDE_EXTRACTION_MODELS, type ClaudeExtractionTier } from "@/lib/claude";
import { computeCost, checkCostCaps, GLOBAL_COST_LIMIT_USD } from "@/lib/pricing";
import type { ProductRow, FieldSource } from "@/lib/types";

// Auto-runs when an analyst opens an image for the first time: identifies
// every candidate product (name + approximate click-target position, no
// field extraction yet -- cheap and fast) so the review board has something
// to show immediately. The analyst then selects which candidates to actually
// process (POST /api/products/bulk-extract), which is the only step that
// does the expensive full-field extraction.
export async function POST(req: NextRequest) {
  const { project_id, image_id, model } = (await req.json()) as {
    project_id: string;
    image_id: string;
    model?: string;
  };

  const project = await getProject(project_id);
  if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });
  const image = await getImage(image_id);
  if (!image || image.project_id !== project_id) {
    return NextResponse.json({ error: "image not found" }, { status: 404 });
  }

  const existing = await listProductsByImage(image_id);
  if (existing.length > 0) {
    // Already identified (or has real rows from another flow) -- never
    // silently re-bill for the same image.
    return NextResponse.json({ products: [], already_identified: true });
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
  const prompt = buildCandidateIdentificationPrompt(project);
  const tier = (model && model in CLAUDE_EXTRACTION_MODELS ? model : "claude-sonnet") as ClaudeExtractionTier;

  try {
    const { text, model: modelUsed, input_tokens, output_tokens } = await runClaudeCandidateIdentification(
      base64,
      "image/jpeg",
      prompt,
      tier
    );
    const cost_usd = computeCost(modelUsed, input_tokens, output_tokens);
    const newProjectTotal = await incrementProjectCost(project_id, cost_usd);

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return NextResponse.json(
        {
          error: "Model did not return parseable JSON",
          project_total_cost_usd: newProjectTotal,
          global_total_cost_usd: globalTotal + cost_usd,
          cost_limit_usd: GLOBAL_COST_LIMIT_USD,
          project_cost_limit_usd: project.cost_limit_usd,
        },
        { status: 502 }
      );
    }
    const parsed = CandidateIdentificationResultSchema.safeParse(JSON.parse(match[0]));
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: formatZodError("Model response had an unexpected shape", parsed.error),
          project_total_cost_usd: newProjectTotal,
          global_total_cost_usd: globalTotal + cost_usd,
          cost_limit_usd: GLOBAL_COST_LIMIT_USD,
          project_cost_limit_usd: project.cost_limit_usd,
        },
        { status: 502 }
      );
    }
    const result = parsed.data;

    const emptyFields: Record<string, string | null> = {};
    const emptyFieldSources: Record<string, FieldSource> = {};
    for (const col of project.schema_json) {
      emptyFields[col.key] = null;
      emptyFieldSources[col.key] = "missing";
    }

    const rows: ProductRow[] = (result.candidates ?? []).map((c) => ({
      id: randomUUID(),
      project_id,
      image_id,
      crop_storage_path: "",
      box_json: { x: c.x, y: c.y, width: c.width, height: c.height },
      fields: emptyFields,
      field_sources: emptyFieldSources,
      model_used: modelUsed,
      status: "candidate",
      source: "candidate_board",
      confidence_score: null,
      candidate_name: c.name,
      analyst_notes: null,
      duplicate_of: null,
      duplicate_confidence: null,
      created_at: new Date().toISOString(),
    }));

    const inserted = rows.length > 0 ? await addProducts(rows) : [];

    return NextResponse.json({
      products: inserted,
      model_used: modelUsed,
      usage: { input_tokens, output_tokens, cost_usd },
      project_total_cost_usd: newProjectTotal,
      global_total_cost_usd: globalTotal + cost_usd,
      cost_limit_usd: GLOBAL_COST_LIMIT_USD,
      project_cost_limit_usd: project.cost_limit_usd,
    });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Candidate identification failed" }, { status: 500 });
  }
}
