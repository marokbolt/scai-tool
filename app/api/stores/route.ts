import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getProject, listStores, createStore } from "@/lib/db";
import type { Store } from "@/lib/types";

export async function GET(req: NextRequest) {
  try {
    const projectId = req.nextUrl.searchParams.get("project_id") ?? "";
    const stores = await listStores(projectId);
    return NextResponse.json({ stores });
  } catch (err: unknown) {
    console.error("GET /api/stores failed:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to load stores" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { project_id, country, name } = (await req.json()) as {
      project_id: string;
      country: string;
      name: string;
    };

    const project = await getProject(project_id);
    if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });
    // Server-enforced, not just hidden in the UI -- the analyst must approve
    // the model's parsed schema before any store/image work can start.
    if (!project.schema_approved_at) {
      return NextResponse.json(
        { error: "Approve the parsed Excel schema before adding a store." },
        { status: 403 }
      );
    }
    if (!name?.trim()) {
      return NextResponse.json({ error: "Store name is required." }, { status: 400 });
    }

    const store: Store = {
      id: randomUUID(),
      project_id,
      // Strip CR/LF at the source, not just where it's later used (export's
      // Content-Disposition filename) -- this free-text field has no other
      // reason to ever contain a newline.
      country: country?.trim().replace(/[\r\n]/g, "") ?? "",
      name: name.trim().replace(/[\r\n]/g, ""),
      created_at: new Date().toISOString(),
    };
    await createStore(store);
    return NextResponse.json({ store });
  } catch (err: unknown) {
    console.error("POST /api/stores failed:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to create store" }, { status: 500 });
  }
}
