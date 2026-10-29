import { NextRequest, NextResponse } from "next/server";
import { listProducts, listProductsByStore, updateProduct } from "@/lib/db";

// Cheap, deterministic duplicate flagging -- no AI call. Token-set similarity
// across each product's combined field values catches "same brand + same
// description reworded slightly" without needing per-template field-name
// assumptions (schema varies project to project). Analyst makes the final
// call; nothing is auto-merged or deleted.
const SIMILARITY_THRESHOLD = 0.6;

function tokenSet(fields: Record<string, string | null>): Set<string> {
  const text = Object.values(fields)
    .filter((v): v is string => !!v)
    .join(" ")
    .toLowerCase();
  return new Set(text.split(/[^a-z0-9]+/).filter((t) => t.length > 1));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  a.forEach((t) => {
    if (b.has(t)) intersection++;
  });
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export async function POST(req: NextRequest) {
  try {
    // Scoped per store when given -- a project can span multiple physical
    // stores, and comparing products across different stores for "duplicates"
    // would flag genuinely distinct inventory as the same item.
    const { project_id, store_id } = (await req.json()) as { project_id: string; store_id?: string };
    const products = store_id ? await listProductsByStore(store_id) : await listProducts(project_id);

    const sets = products.map((p) => tokenSet(p.fields));
    const flagged: { id: string; duplicate_of: string; confidence: number }[] = [];

    for (let i = 0; i < products.length; i++) {
      if (products[i].duplicate_of) continue; // already resolved in a prior run
      for (let j = 0; j < i; j++) {
        const sim = jaccard(sets[i], sets[j]);
        if (sim >= SIMILARITY_THRESHOLD) {
          flagged.push({ id: products[i].id, duplicate_of: products[j].id, confidence: sim });
          break; // link to the first (earliest) match only
        }
      }
    }

    for (const f of flagged) {
      await updateProduct(f.id, { duplicate_of: f.duplicate_of, duplicate_confidence: f.confidence });
    }

    return NextResponse.json({ flagged_count: flagged.length, flagged });
  } catch (err: unknown) {
    console.error("POST /api/dedup failed:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Duplicate check failed" }, { status: 500 });
  }
}
