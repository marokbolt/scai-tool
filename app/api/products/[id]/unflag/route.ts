import { NextRequest, NextResponse } from "next/server";
import { updateProduct } from "@/lib/db";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const product = await updateProduct(id, { duplicate_of: null, duplicate_confidence: null });
    if (!product) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ product });
  } catch (err: unknown) {
    console.error("POST /api/products/[id]/unflag failed:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to unflag product" }, { status: 500 });
  }
}
