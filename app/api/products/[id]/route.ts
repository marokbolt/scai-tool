import { NextRequest, NextResponse } from "next/server";
import { updateProduct, deleteProduct, getProduct } from "@/lib/db";
import type { FieldSource, ProductStatus, BoundingBox } from "@/lib/types";

// PATCH: edit field values on the final table (always marks touched keys as analyst-sourced),
// or flip a draft row's status once the analyst accepts it.
// Accepts: a single { key, value } (Finish table's inline cell edits), a bulk
// { fields, edited_keys } (review workspace's "edit a confirmed product"
// panel), or { status } alone (accepting a whole-image-extracted draft as-is).
interface StatusBody {
  status: ProductStatus;
}
interface BulkFieldsBody {
  fields: Record<string, string | null>;
  edited_keys: string[];
}
interface SingleFieldBody {
  key: string;
  value: string;
}
interface NotesBody {
  analyst_notes: string;
}
interface BoxBody {
  box_json: BoundingBox;
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = (await req.json()) as Partial<StatusBody & BulkFieldsBody & SingleFieldBody & NotesBody & BoxBody>;

    const existing = await getProduct(id);
    if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

    // Resize/reposition a candidate's approximate box -- the model's own
    // position is a click-target estimate, not a measurement, so the analyst
    // can tighten it before processing.
    if (body.box_json && body.fields === undefined && body.key === undefined && body.status === undefined) {
      const updated = await updateProduct(id, { box_json: body.box_json });
      return NextResponse.json({ product: updated });
    }

    if (body.analyst_notes !== undefined && body.fields === undefined && body.key === undefined && body.status === undefined) {
      const updated = await updateProduct(id, { analyst_notes: body.analyst_notes });
      return NextResponse.json({ product: updated });
    }

    if (body.status && body.fields === undefined && body.key === undefined) {
      const updated = await updateProduct(id, { status: body.status });
      return NextResponse.json({ product: updated });
    }

    let fields: Record<string, string | null>;
    const fieldSources: Record<string, FieldSource> = { ...existing.field_sources };
    let status: ProductStatus = existing.status;

    if (body.fields) {
      fields = { ...existing.fields, ...body.fields };
      for (const k of body.edited_keys ?? []) fieldSources[k] = "analyst";
    } else if (body.key) {
      fields = { ...existing.fields, [body.key]: body.value ?? null };
      fieldSources[body.key] = "analyst";
    } else {
      return NextResponse.json({ error: "invalid request body" }, { status: 400 });
    }
    // Editing a draft and saving is itself the human review -- promote it.
    if (status === "draft") status = "confirmed";

    const updated = await updateProduct(id, { fields, field_sources: fieldSources, status });
    return NextResponse.json({ product: updated });
  } catch (err: unknown) {
    console.error("PATCH /api/products/[id] failed:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to save product" }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await deleteProduct(id);
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    console.error("DELETE /api/products/[id] failed:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to delete product" }, { status: 500 });
  }
}
