import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { addProduct, listProducts, updateImage } from "@/lib/db";
import { uploadFile } from "@/lib/storage";
import type { ProductRow, FieldSource, BoundingBox } from "@/lib/types";

export async function GET(req: NextRequest) {
  try {
    const projectId = req.nextUrl.searchParams.get("project_id") ?? "";
    const products = await listProducts(projectId);
    return NextResponse.json({ products });
  } catch (err: unknown) {
    console.error("GET /api/products failed:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to load products" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const projectId = String(formData.get("project_id") ?? "");
    const imageId = String(formData.get("image_id") ?? "");
    const modelUsed = String(formData.get("model_used") ?? "unknown");
    const fieldsRaw = String(formData.get("fields") ?? "{}");
    const editedKeysRaw = String(formData.get("edited_keys") ?? "[]");
    const boxRaw = formData.get("box_json");
    const crop = formData.get("crop") as File | null;

    const fields = JSON.parse(fieldsRaw) as Record<string, string | null>;
    const editedKeys = new Set<string>(JSON.parse(editedKeysRaw));
    const box = boxRaw ? (JSON.parse(String(boxRaw)) as BoundingBox) : null;

    let cropStoragePath = "";
    if (crop) {
      const buffer = Buffer.from(await crop.arrayBuffer());
      cropStoragePath = `${projectId}/crop_${randomUUID()}.jpg`;
      await uploadFile(cropStoragePath, buffer, "image/jpeg");
    }

    const fieldSources: Record<string, FieldSource> = {};
    Object.keys(fields).forEach((k) => {
      fieldSources[k] = editedKeys.has(k) ? "analyst" : fields[k] == null ? "missing" : "ai";
    });

    const product: ProductRow = {
      id: randomUUID(),
      project_id: projectId,
      image_id: imageId,
      crop_storage_path: cropStoragePath,
      box_json: box,
      fields,
      field_sources: fieldSources,
      model_used: modelUsed,
      status: "confirmed",
      source: "box_draw",
      confidence_score: null,
      candidate_name: null,
      analyst_notes: null,
      duplicate_of: null,
      duplicate_confidence: null,
      created_at: new Date().toISOString(),
    };
    await addProduct(product);
    await updateImage(imageId, { is_reviewed: true });

    return NextResponse.json({ product });
  } catch (err: unknown) {
    console.error("POST /api/products failed:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to save product" }, { status: 500 });
  }
}
