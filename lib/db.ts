// Supabase-backed data layer. Same function signatures as the local
// JSON-file version it replaces, so no caller changed -- only this file.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Project, ProjectImage, ProductRow, Store } from "./types";

// No generated Database type for this prototype -- `any` schema keeps
// insert/update payloads typed as our own interfaces instead of `never`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _client: SupabaseClient<any, any, any> | null = null;

function db() {
  if (!_client) {
    _client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      {
        // Next.js patches the global fetch on the server and caches GET
        // requests by default (its Data Cache). Supabase-js hits the same
        // REST URL for identical queries (e.g. every getGlobalTotalCost()
        // call), so without this every read after the first one was served
        // a stale cached snapshot instead of the live row -- the "cost
        // isn't persisting" symptom, even though the DB itself was correct.
        global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }) },
      }
    );
  }
  return _client;
}

function unwrap<T>(result: { data: T | null; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  return result.data as T;
}

// ── projects ──────────────────────────────────────────────────────────────
export async function listProjects(): Promise<Project[]> {
  const res = await db().from("projects").select("*").order("created_at", { ascending: false });
  return unwrap(res) as unknown as Project[];
}

export async function getProject(id: string): Promise<Project | null> {
  const res = await db().from("projects").select("*").eq("id", id).maybeSingle();
  return unwrap(res) as unknown as Project | null;
}

// Sums spend across every project, not just one -- the cost cap is a single
// ceiling for the whole deployment, so creating a new project must not
// reset the budget. Small expected scale for this prototype, so summing in
// JS rather than a DB-side aggregate is fine.
export async function getGlobalTotalCost(): Promise<number> {
  const res = await db().from("projects").select("total_cost_usd");
  const rows = unwrap(res) as unknown as { total_cost_usd: number }[];
  return rows.reduce((sum, r) => sum + (r.total_cost_usd ?? 0), 0);
}

export async function createProject(project: Project): Promise<Project> {
  const res = await db().from("projects").insert(project).select().single();
  return unwrap(res) as unknown as Project;
}

export async function updateProject(id: string, patch: Partial<Project>): Promise<Project | null> {
  const res = await db().from("projects").update(patch).eq("id", id).select().maybeSingle();
  return unwrap(res) as unknown as Project | null;
}

// Atomic increment via a Postgres function (increment_project_cost) rather
// than read-modify-write, so concurrent extraction calls don't clobber each
// other's cost updates.
export async function incrementProjectCost(id: string, amount: number): Promise<number> {
  const res = await db().rpc("increment_project_cost", { pid: id, amount });
  return unwrap(res) as unknown as number;
}

// ── stores ────────────────────────────────────────────────────────────────
// A project can span multiple physical stores sharing one schema; each
// store has its own images and independent review progress.
export async function listStores(projectId: string): Promise<Store[]> {
  const res = await db()
    .from("stores")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });
  return unwrap(res) as unknown as Store[];
}

export async function getStore(id: string): Promise<Store | null> {
  const res = await db().from("stores").select("*").eq("id", id).maybeSingle();
  return unwrap(res) as unknown as Store | null;
}

export async function createStore(store: Store): Promise<Store> {
  const res = await db().from("stores").insert(store).select().single();
  return unwrap(res) as unknown as Store;
}

// ── images ────────────────────────────────────────────────────────────────
export async function listImages(projectId: string): Promise<ProjectImage[]> {
  const res = await db()
    .from("project_images")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });
  return unwrap(res) as unknown as ProjectImage[];
}

export async function listImagesByStore(storeId: string): Promise<ProjectImage[]> {
  const res = await db()
    .from("project_images")
    .select("*")
    .eq("store_id", storeId)
    .order("created_at", { ascending: true });
  return unwrap(res) as unknown as ProjectImage[];
}

export async function getImage(id: string): Promise<ProjectImage | null> {
  const res = await db().from("project_images").select("*").eq("id", id).maybeSingle();
  return unwrap(res) as unknown as ProjectImage | null;
}

export async function addImage(image: ProjectImage): Promise<ProjectImage> {
  const res = await db().from("project_images").insert(image).select().single();
  return unwrap(res) as unknown as ProjectImage;
}

export async function updateImage(id: string, patch: Partial<ProjectImage>): Promise<ProjectImage | null> {
  const res = await db().from("project_images").update(patch).eq("id", id).select().maybeSingle();
  return unwrap(res) as unknown as ProjectImage | null;
}

// ── products ──────────────────────────────────────────────────────────────
export async function listProducts(projectId: string): Promise<ProductRow[]> {
  const res = await db()
    .from("products")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });
  return unwrap(res) as unknown as ProductRow[];
}

// products has no store_id column of its own (it hangs off image_id) -- scope
// via that store's image ids rather than adding a denormalized column.
export async function listProductsByStore(storeId: string): Promise<ProductRow[]> {
  const images = await listImagesByStore(storeId);
  if (images.length === 0) return [];
  const res = await db()
    .from("products")
    .select("*")
    .in("image_id", images.map((i) => i.id))
    .order("created_at", { ascending: true });
  return unwrap(res) as unknown as ProductRow[];
}

export async function listProductsByImage(imageId: string): Promise<ProductRow[]> {
  const res = await db().from("products").select("*").eq("image_id", imageId);
  return unwrap(res) as unknown as ProductRow[];
}

export async function getProduct(id: string): Promise<ProductRow | null> {
  const res = await db().from("products").select("*").eq("id", id).maybeSingle();
  return unwrap(res) as unknown as ProductRow | null;
}

export async function addProduct(product: ProductRow): Promise<ProductRow> {
  const res = await db().from("products").insert(product).select().single();
  return unwrap(res) as unknown as ProductRow;
}

// Whole-image extraction can produce dozens of draft rows from one call --
// one insert instead of N round trips.
export async function addProducts(products: ProductRow[]): Promise<ProductRow[]> {
  const res = await db().from("products").insert(products).select();
  return unwrap(res) as unknown as ProductRow[];
}

export async function updateProduct(id: string, patch: Partial<ProductRow>): Promise<ProductRow | null> {
  const res = await db().from("products").update(patch).eq("id", id).select().maybeSingle();
  return unwrap(res) as unknown as ProductRow | null;
}

export async function deleteProduct(id: string): Promise<void> {
  const res = await db().from("products").delete().eq("id", id);
  if (res.error) throw new Error(res.error.message);
}

// Bulk accept/reject for whole-image draft rows -- avoids N round trips when
// an analyst accepts or rejects everything on an image at once.
export async function bulkUpdateProductStatus(ids: string[], status: string): Promise<void> {
  const res = await db().from("products").update({ status }).in("id", ids);
  if (res.error) throw new Error(res.error.message);
}

export async function bulkDeleteProducts(ids: string[]): Promise<void> {
  const res = await db().from("products").delete().in("id", ids);
  if (res.error) throw new Error(res.error.message);
}
