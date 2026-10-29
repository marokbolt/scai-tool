import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { getProject, listProducts, listProductsByStore, getStore } from "@/lib/db";
import { downloadFile } from "@/lib/storage";
import type { Project, ProductRow, Store } from "@/lib/types";

const SOURCE_FILL: Record<string, string> = {
  ai: "D6EAF8", // light blue
  analyst: "FDEBD0", // light orange
  missing: "FADBD8", // light red
};

function sourceFillFor(product: ProductRow, key: string): ExcelJS.Fill {
  const source = product.field_sources[key] ?? (product.fields[key] ? "ai" : "missing");
  return { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + SOURCE_FILL[source] } };
}

// Preferred path: edit the client's own uploaded template in place, so
// every other sheet, style, colour, and formula survives untouched --
// only the target data-entry sheet gets new rows appended below whatever
// was already there (including a template's own pre-populated seed rows).
async function exportFromOriginalTemplate(project: Project, products: ProductRow[], store: Store | null): Promise<Buffer | null> {
  if (!project.template_storage_path || !project.context_json.sheet_name || !project.context_json.header_row) {
    return null;
  }

  const templateBuffer = await downloadFile(project.template_storage_path);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(templateBuffer as unknown as ExcelJS.Buffer);

  const sheet = workbook.getWorksheet(project.context_json.sheet_name);
  if (!sheet) return null; // sheet name mismatch -- fall back rather than corrupt the wrong sheet

  // "Tab name = store name" (per the client template convention) -- rename
  // the data-entry sheet to this store's name so a multi-store project's
  // per-store downloads are each correctly labeled, not stuck with the
  // template's generic original sheet name.
  if (store?.name) {
    sheet.name = store.name.replace(/[/\\?*[\]:]/g, "").slice(0, 31) || sheet.name;
  }

  const headerRow = project.context_json.header_row;
  const numCols = project.schema_json.length;

  // Find the first genuinely empty row after the header, scanning past any
  // rows the template itself pre-populated (e.g. GlobalData's seed brands) --
  // approved rows get appended after those, never overwriting them.
  let writeRow = headerRow + 1;
  while (true) {
    const row = sheet.getRow(writeRow);
    const hasData = Array.from({ length: numCols }, (_, i) => row.getCell(i + 1).value).some(
      (v) => v !== null && v !== undefined && v !== ""
    );
    if (!hasData) break;
    writeRow += 1;
  }

  for (const product of products) {
    const row = sheet.getRow(writeRow);
    project.schema_json.forEach((col, idx) => {
      const cell = row.getCell(idx + 1);
      cell.value = product.fields[col.key] ?? null;
      // Cells loaded from an existing workbook can share an underlying
      // style-index slot; assigning `cell.fill` directly mutates that
      // shared slot in place, so unrelated cells that happened to share
      // the template's original style end up all showing whichever fill
      // was written LAST (confirmed by reproduction -- every cell showed
      // the final loop iteration's colour, not its own). The fix is a new,
      // unshared style object per cell -- but it must be a SHALLOW COPY of
      // the cell's existing style (font/alignment/border/numFmt inherited
      // from the template's row/column), not a brand-new object with only
      // `fill` set, which was the bug in the previous version of this fix:
      // it silently discarded every other inherited style property on
      // every written cell (confirmed against exceljs's cell constructor --
      // `cell.style` is a plain object property, not a getter, so spreading
      // it here copies its current values without touching whatever other
      // cell may still reference the original object).
      cell.style = { ...cell.style, fill: sourceFillFor(product, col.key) };
    });
    row.commit();
    writeRow += 1;
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

// Fallback for projects created before template preservation existed (no
// template_storage_path on the row) -- rebuilds a plain single-sheet
// workbook so export still works, just without the original formatting.
async function exportRebuiltWorkbook(project: Project, products: ProductRow[], store: Store | null): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheetName = (store?.name || project.name).replace(/[/\\?*[\]:]/g, "").slice(0, 31) || "Products";
  const sheet = workbook.addWorksheet(sheetName, {
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1 },
  });
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.columns = project.schema_json.map((c) => ({ header: c.header, key: c.key, width: 22 }));

  const headerRow = sheet.getRow(1);
  headerRow.height = 26;
  headerRow.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0A2240" } };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10, name: "Calibri" };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  });

  products.forEach((product) => {
    const row = sheet.addRow(product.fields);
    row.height = 18;
    project.schema_json.forEach((col, idx) => {
      const cell = row.getCell(idx + 1);
      cell.fill = sourceFillFor(product, col.key);
      cell.font = { size: 10, name: "Calibri" };
      cell.alignment = { vertical: "middle", horizontal: "left" };
    });
  });

  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: project.schema_json.length } };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function GET(req: NextRequest) {
  try {
    const projectId = req.nextUrl.searchParams.get("project_id") ?? "";
    const storeId = req.nextUrl.searchParams.get("store_id");
    const project = await getProject(projectId);
    if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });
    const store = storeId ? await getStore(storeId) : null;

    const allProducts = storeId ? await listProductsByStore(storeId) : await listProducts(projectId);
    const products = allProducts.filter((p) => !p.duplicate_of && p.status === "confirmed");

    const buffer =
      (await exportFromOriginalTemplate(project, products, store)) ?? (await exportRebuiltWorkbook(project, products, store));
    const fileName = store?.name
      ? `${store.name.replace(/[/\\?*[\]:]/g, "")}_export.xlsx`
      : project.template_file_name || `${project.name}_export.xlsx`;
    // store.name is free-text analyst input (POST /api/stores only trims it) --
    // strip quotes AND CR/LF before it goes into a raw header value, so a
    // store name can't inject extra header lines into the response.
    const safeFileName = fileName.replace(/["\r\n]/g, "");

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${safeFileName}"`,
      },
    });
  } catch (err: unknown) {
    console.error("GET /api/export failed:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Export failed" }, { status: 500 });
  }
}
