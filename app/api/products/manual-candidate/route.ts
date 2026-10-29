import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getProject, getImage, addProduct } from "@/lib/db";
import type { ProductRow, FieldSource, BoundingBox } from "@/lib/types";

// Lets the analyst add a candidate the model missed by drawing a box
// directly on the candidate board -- no AI call, just an insert, since the
// real identification happens later when this candidate is processed (the
// extraction call reads the whole image at this exact position, so an exact
// name isn't needed up front).
export async function POST(req: NextRequest) {
  try {
    const { project_id, image_id, box_json } = (await req.json()) as {
      project_id: string;
      image_id: string;
      box_json: BoundingBox;
    };

    const project = await getProject(project_id);
    if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });
    const image = await getImage(image_id);
    if (!image || image.project_id !== project_id) {
      return NextResponse.json({ error: "image not found" }, { status: 404 });
    }

    const fields: Record<string, string | null> = {};
    const fieldSources: Record<string, FieldSource> = {};
    for (const col of project.schema_json) {
      fields[col.key] = null;
      fieldSources[col.key] = "missing";
    }

    const product: ProductRow = {
      id: randomUUID(),
      project_id,
      image_id,
      crop_storage_path: "",
      box_json,
      fields,
      field_sources: fieldSources,
      model_used: "manual",
      status: "candidate",
      source: "candidate_board",
      confidence_score: null,
      candidate_name: "Manually added",
      analyst_notes: null,
      duplicate_of: null,
      duplicate_confidence: null,
      created_at: new Date().toISOString(),
    };
    const inserted = await addProduct(product);
    return NextResponse.json({ product: inserted });
  } catch (err: unknown) {
    console.error("POST /api/products/manual-candidate failed:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to add candidate" }, { status: 500 });
  }
}
