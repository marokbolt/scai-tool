import { NextRequest, NextResponse } from "next/server";
import { getProject, updateProject } from "@/lib/db";
import type { SchemaColumn } from "@/lib/types";

// The analyst can correct the model's parsed schema/category/context before
// locking it in -- this is a checkpoint distinct from the final audit
// approval (/api/projects/[id]/approve), gating whether stores/images can be
// added at all (enforced in /api/stores, not just hidden client-side).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as {
      schema_json?: SchemaColumn[];
      category?: string | null;
      segments_text?: string | null;
      raw_notes?: string | null;
    };

    const existing = await getProject(id);
    if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

    const patch: Partial<typeof existing> = { schema_approved_at: new Date().toISOString() };
    if (body.schema_json) patch.schema_json = body.schema_json;
    if (body.category !== undefined || body.segments_text !== undefined || body.raw_notes !== undefined) {
      patch.context_json = {
        ...existing.context_json,
        ...(body.category !== undefined ? { category: body.category } : {}),
        ...(body.segments_text !== undefined ? { segments_text: body.segments_text } : {}),
        ...(body.raw_notes !== undefined ? { raw_notes: body.raw_notes } : {}),
      };
    }

    const project = await updateProject(id, patch);
    return NextResponse.json({ project });
  } catch (err: unknown) {
    console.error("POST /api/projects/[id]/approve-schema failed:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to approve schema" }, { status: 500 });
  }
}
