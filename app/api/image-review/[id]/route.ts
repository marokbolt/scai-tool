import { NextRequest, NextResponse } from "next/server";
import { updateImage } from "@/lib/db";

// Marks an image reviewed without a confirmed product -- for storefront/aisle
// shots or any image with nothing in scope to box.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = (await req.json()) as { is_reviewed: boolean };
    const image = await updateImage(id, { is_reviewed: body.is_reviewed });
    if (!image) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ image });
  } catch (err: unknown) {
    console.error("PATCH /api/image-review/[id] failed:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to update image" }, { status: 500 });
  }
}
