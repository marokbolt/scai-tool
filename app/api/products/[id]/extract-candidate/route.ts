import { NextRequest, NextResponse } from "next/server";
import { getProduct, getProject, getImage, updateProduct, incrementProjectCost, getGlobalTotalCost } from "@/lib/db";
import { downloadFile } from "@/lib/storage";
import { buildCandidateExtractionPrompt } from "@/lib/extraction-prompt";
import { runClaudeExtraction, CLAUDE_EXTRACTION_MODELS, type ClaudeExtractionTier } from "@/lib/claude";
import { computeCost, checkCostCaps, GLOBAL_COST_LIMIT_USD } from "@/lib/pricing";
import { ExtractionResultSchema, formatZodError } from "@/lib/llm-schemas";
import type { FieldSource } from "@/lib/types";

// Processes ONE selected candidate into a real, field-extracted 'draft' row.
// Called N times by the client (bounded-concurrency worker pool, same
// pattern as the existing box-draw batch queue) rather than one big
// server-side batch endpoint, so the UI gets genuine live per-item progress
// without needing streaming/SSE.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { model } = (await req.json().catch(() => ({}))) as { model?: string };

  const product = await getProduct(id);
  if (!product) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (product.status !== "candidate") {
    return NextResponse.json({ error: "This item has already been processed." }, { status: 409 });
  }
  if (!product.box_json) {
    return NextResponse.json({ error: "Candidate has no position to focus on." }, { status: 400 });
  }

  const project = await getProject(product.project_id);
  const image = await getImage(product.image_id);
  if (!project || !image) return NextResponse.json({ error: "project or image not found" }, { status: 404 });

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
  const prompt = buildCandidateExtractionPrompt(project, product.candidate_name ?? "this product", product.box_json, product.analyst_notes);
  const tier = (model && model in CLAUDE_EXTRACTION_MODELS ? model : "claude-sonnet") as ClaudeExtractionTier;

  try {
    const { text, model: modelUsed, input_tokens, output_tokens } = await runClaudeExtraction(base64, "image/jpeg", prompt, tier);
    const cost_usd = computeCost(modelUsed, input_tokens, output_tokens);
    const newProjectTotal = await incrementProjectCost(product.project_id, cost_usd);

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return NextResponse.json(
        { error: "Model did not return parseable JSON", project_total_cost_usd: newProjectTotal, global_total_cost_usd: globalTotal + cost_usd, cost_limit_usd: GLOBAL_COST_LIMIT_USD },
        { status: 502 }
      );
    }
    const parsed = ExtractionResultSchema.safeParse(JSON.parse(match[0]));
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: formatZodError("Model response had an unexpected shape", parsed.error),
          project_total_cost_usd: newProjectTotal,
          global_total_cost_usd: globalTotal + cost_usd,
          cost_limit_usd: GLOBAL_COST_LIMIT_USD,
        },
        { status: 502 }
      );
    }
    const raw = parsed.data as { confidence_score?: number } & Record<string, unknown>;
    const { confidence_score, in_scope: _in_scope, reason: _reason, ...rest } = raw;
    void _in_scope;
    void _reason;

    const fields: Record<string, string | null> = {};
    const fieldSources: Record<string, FieldSource> = {};
    for (const col of project.schema_json) {
      const v = rest[col.key];
      const value = v == null || v === "" ? null : String(v);
      fields[col.key] = value;
      fieldSources[col.key] = value == null ? "missing" : "ai";
    }

    const updated = await updateProduct(id, {
      fields,
      field_sources: fieldSources,
      status: "draft",
      model_used: modelUsed,
      confidence_score: typeof confidence_score === "number" ? confidence_score : null,
    });

    return NextResponse.json({
      product: updated,
      usage: { input_tokens, output_tokens, cost_usd },
      project_total_cost_usd: newProjectTotal,
      global_total_cost_usd: globalTotal + cost_usd,
      cost_limit_usd: GLOBAL_COST_LIMIT_USD,
      project_cost_limit_usd: project.cost_limit_usd,
    });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Extraction failed" }, { status: 500 });
  }
}
