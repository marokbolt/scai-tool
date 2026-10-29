import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { dumpWorkbook } from "@/lib/excel-dump";
import { runIngest } from "@/lib/claude";
import { createProject, getGlobalTotalCost } from "@/lib/db";
import { uploadFile } from "@/lib/storage";
import { computeCost, GLOBAL_COST_LIMIT_USD } from "@/lib/pricing";
import type { Project } from "@/lib/types";

// Excel-only now -- images upload directly to Storage from the browser
// (see /api/upload-url + /api/ingest-image) and never pass through this
// request body, since a real photo set is far larger than Vercel's
// serverless function body limit allows.
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const name = String(formData.get("name") ?? "Untitled Project");
    const excelFile = formData.get("excel") as File | null;

    if (!excelFile) {
      return NextResponse.json({ error: "Excel template is required" }, { status: 400 });
    }

    // No project exists yet for this call, so there's no per-project budget to
    // check -- only the shared global safety cap applies here. Checked before
    // spending anything, same as every other Claude call in the app.
    // Known, accepted race (same category as the candidate-batch worker pool's
    // documented capHit overshoot): two concurrent POST /api/ingest calls can
    // both read globalTotal under the cap before either's project row exists,
    // so both proceed. Bounded by how many concurrent new-project creations
    // happen at once (expected to be small for one internal team), and a real
    // fix needs a DB-level atomic check-and-reserve, not a client-side guard --
    // not worth that complexity for this prototype's scale.
    const globalTotal = await getGlobalTotalCost();
    if (globalTotal >= GLOBAL_COST_LIMIT_USD) {
      return NextResponse.json(
        { error: `The shared $${GLOBAL_COST_LIMIT_USD.toFixed(2)} safety cap across all projects is reached ($${globalTotal.toFixed(2)} spent). Extraction is paused everywhere.`, cost_limit_reached: true },
        { status: 402 }
      );
    }

    const projectId = randomUUID();

    const excelBuffer = Buffer.from(await excelFile.arrayBuffer());
    const dump = await dumpWorkbook(excelBuffer);
    const { result: ingestResult, model: ingestModel, input_tokens, output_tokens } = await runIngest(dump);
    const ingestCost = computeCost(ingestModel, input_tokens, output_tokens);

    // Keep the original file byte-for-byte -- export edits this copy in
    // place rather than rebuilding a workbook from scratch, so every other
    // sheet, style, and formula in the client's template survives untouched.
    const templateStoragePath = `${projectId}/template.xlsx`;
    await uploadFile(
      templateStoragePath,
      excelBuffer,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    const project: Project = {
      id: projectId,
      name,
      created_at: new Date().toISOString(),
      schema_json: ingestResult.schema,
      context_json: {
        category: ingestResult.category,
        segments_text: ingestResult.segments_text,
        raw_notes: ingestResult.raw_notes,
        sheet_name: ingestResult.sheet_name,
        header_row: ingestResult.header_row,
      },
      template_file_name: excelFile.name,
      template_storage_path: templateStoragePath,
      status: "draft",
      approved_at: null,
      schema_approved_at: null,
      // Counts the ingest call itself -- previously this call was never billed
      // or capped at all, letting it run for free and uncounted outside every
      // other cost-tracking path in the app.
      total_cost_usd: ingestCost,
      cost_limit_usd: 10,
    };
    await createProject(project);

    return NextResponse.json({ project, global_total_cost_usd: globalTotal + ingestCost, cost_limit_usd: GLOBAL_COST_LIMIT_USD });
  } catch (err: unknown) {
    console.error("POST /api/ingest failed:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to create project" }, { status: 500 });
  }
}
