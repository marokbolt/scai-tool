// Dynamic-schema types -- unlike SCAI_v2, this prototype does not assume a
// fixed 22-column Water Enhancer schema. Every project's column list comes
// from its own uploaded Excel template, parsed in /api/ingest.

export type ImageType = "storefront" | "aisle" | "shelf" | "product_solo";

export type FieldSource = "ai" | "analyst" | "missing";

export interface SchemaColumn {
  key: string; // slugified, used as the JSON field key
  header: string; // original Excel header text
}

export type ProjectStatus = "draft" | "approved";

export interface Project {
  id: string;
  name: string;
  created_at: string;
  schema_json: SchemaColumn[];
  context_json: {
    category: string | null;
    segments_text: string | null;
    raw_notes: string | null;
    sheet_name: string | null; // exact name of the primary data-entry sheet in the original template
    header_row: number | null; // 1-indexed row where the real column headers live in that sheet
  };
  template_file_name: string;
  template_storage_path: string | null; // original uploaded .xlsx, kept byte-for-byte for export
  status: ProjectStatus; // final, end-of-audit approval -- distinct from schema_approved_at below
  approved_at: string | null;
  // The analyst must explicitly confirm the model's parsed understanding of
  // the Excel (schema/category/context) before any store/image work can
  // start -- separate checkpoint from the final audit approval above.
  schema_approved_at: string | null;
  total_cost_usd: number;
  cost_limit_usd: number;
}

// A project can span multiple physical stores sharing one schema -- each
// store has its own country/name and its own independent set of images and
// review progress.
export interface Store {
  id: string;
  project_id: string;
  country: string;
  name: string;
  created_at: string;
}

export interface ProjectImage {
  id: string;
  project_id: string;
  store_id: string;
  file_name: string;
  storage_path: string; // relative path under data/uploads/{project_id}/
  image_type: ImageType | null;
  is_reviewed: boolean;
  created_at: string;
}

export interface BoundingBox {
  x: number; // percentage of image width, 0-100
  y: number; // percentage of image height, 0-100
  width: number;
  height: number;
}

// 'candidate' = identified on the review board (name + approx position only,
// no fields yet) -- the analyst selects which candidates to actually process.
// 'draft' = fields extracted (either from a processed candidate or whole-
// image auto-extraction), not yet looked at by a human -- must never reach
// dedup/export. 'confirmed' = either came through the box-draw-one-product
// flow (which already requires a human look before saving) or a draft the
// analyst explicitly accepted.
export type ProductStatus = "candidate" | "draft" | "confirmed";
export type ProductSource = "box_draw" | "whole_image" | "candidate_board";

export interface ProductRow {
  id: string;
  project_id: string;
  image_id: string;
  crop_storage_path: string;
  box_json: BoundingBox | null; // where this crop was drawn on the source image, for highlighting on review/edit
  fields: Record<string, string | null>; // keyed by SchemaColumn.key
  field_sources: Record<string, FieldSource>;
  model_used: string;
  status: ProductStatus;
  source: ProductSource;
  confidence_score: number | null; // self-reported by whole-image extraction; null for box_draw rows
  candidate_name: string | null; // model-given display name while status is 'candidate', before any field extraction
  analyst_notes: string | null; // freeform research the analyst attaches before processing a candidate
  duplicate_of: string | null;
  duplicate_confidence: number | null;
  created_at: string;
}

export interface DbShape {
  projects: Project[];
  images: ProjectImage[];
  products: ProductRow[];
}
