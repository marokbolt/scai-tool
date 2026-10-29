import { NextRequest, NextResponse } from "next/server";
import { updateProject } from "@/lib/db";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const project = await updateProject(id, { status: "approved", approved_at: new Date().toISOString() });
    if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ project });
  } catch (err: unknown) {
    console.error("POST /api/projects/[id]/approve failed:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to approve project" }, { status: 500 });
  }
}
