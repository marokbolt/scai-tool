import { NextRequest, NextResponse } from "next/server";
import { bulkUpdateProductStatus, bulkDeleteProducts } from "@/lib/db";
import type { ProductStatus } from "@/lib/types";

// One request to accept or reject every draft row an analyst has just
// reviewed, instead of N sequential PATCH/DELETE calls per row.
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { ids: string[]; action: "accept" | "reject"; status?: ProductStatus };
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      return NextResponse.json({ error: "ids array is required" }, { status: 400 });
    }
    if (body.action === "reject") {
      await bulkDeleteProducts(body.ids);
    } else {
      await bulkUpdateProductStatus(body.ids, body.status ?? "confirmed");
    }
    return NextResponse.json({ ok: true, count: body.ids.length });
  } catch (err: unknown) {
    console.error("POST /api/products/bulk failed:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Bulk update failed" }, { status: 500 });
  }
}
