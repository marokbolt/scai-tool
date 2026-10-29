import { NextRequest, NextResponse } from "next/server";
import { getProject, incrementProjectCost, getGlobalTotalCost } from "@/lib/db";
import { buildExtractionPrompt } from "@/lib/extraction-prompt";
import { runClaudeExtraction, CLAUDE_EXTRACTION_MODELS, type ClaudeExtractionTier } from "@/lib/claude";
import { runOpenRouterExtraction } from "@/lib/openrouter";
import { computeCost, checkCostCaps, GLOBAL_COST_LIMIT_USD } from "@/lib/pricing";
import { ExtractionResultSchema, formatZodError } from "@/lib/llm-schemas";

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const projectId = String(formData.get("project_id") ?? "");
  const model = String(formData.get("model") ?? "claude-haiku"); // "claude-haiku" | "claude-sonnet" | "claude-opus" | "openrouter"
  const crop = formData.get("crop") as File | null;
  const analystNotes = formData.get("analyst_notes") as string | null;

  if (!crop) {
    return NextResponse.json({ error: "crop image is required" }, { status: 400 });
  }
  const project = await getProject(projectId);
  if (!project) {
    return NextResponse.json({ error: "project not found" }, { status: 404 });
  }
  // Two layered spend caps, checked against a fresh read each call: this
  // project's own budget, and the hard ceiling across EVERY project in this
  // deployment (so creating a new project to test something else never
  // resets the shared budget). Under real concurrency a handful of calls
  // launched in the same instant can each pass this check before any of
  // their increments land -- worst case overshoot is bounded by
  // (concurrency limit x per-call cost), a few cents to ~$1 here, an
  // accepted tradeoff against needing distributed locking for a
  // single-analyst trial.
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

  const buffer = Buffer.from(await crop.arrayBuffer());
  const base64 = buffer.toString("base64");
  const mediaType = crop.type || "image/jpeg";
  const prompt = buildExtractionPrompt(project, analystNotes);

  const startedAt = Date.now();
  try {
    const { text, model: modelUsed, input_tokens, output_tokens } =
      model === "openrouter"
        ? await runOpenRouterExtraction(base64, mediaType, prompt)
        : await runClaudeExtraction(
            base64,
            mediaType,
            prompt,
            (model in CLAUDE_EXTRACTION_MODELS ? model : "claude-haiku") as ClaudeExtractionTier
          );
    const latency_ms = Date.now() - startedAt;
    const cost_usd = computeCost(modelUsed, input_tokens, output_tokens);
    const newProjectTotal = await incrementProjectCost(projectId, cost_usd);

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      // The call already succeeded and was billed above (incrementProjectCost
      // already ran) -- the cost fields must still go out here too, or the
      // client's cost tracker silently under-reports real spend on this path.
      return NextResponse.json(
        {
          error: "Model did not return parseable JSON",
          raw: text,
          project_total_cost_usd: newProjectTotal,
          global_total_cost_usd: globalTotal + cost_usd,
          cost_limit_usd: GLOBAL_COST_LIMIT_USD,
          project_cost_limit_usd: project.cost_limit_usd,
        },
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
          project_cost_limit_usd: project.cost_limit_usd,
        },
        { status: 502 }
      );
    }
    const fields = parsed.data;
    return NextResponse.json({
      fields,
      model_used: modelUsed,
      usage: { input_tokens, output_tokens, latency_ms, cost_usd },
      project_total_cost_usd: newProjectTotal,
      global_total_cost_usd: globalTotal + cost_usd,
      cost_limit_usd: GLOBAL_COST_LIMIT_USD,
      project_cost_limit_usd: project.cost_limit_usd,
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Extraction failed" },
      { status: 500 }
    );
  }
}
