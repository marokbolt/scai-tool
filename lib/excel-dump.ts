import ExcelJS from "exceljs";

// Dumps every sheet's first N rows as a readable text block for an LLM to
// interpret -- client templates vary too much (header on row 2 vs row 13,
// different sheet counts/names) to parse structurally in code, so we hand
// the raw shape to Claude instead of guessing a fixed layout.
export async function dumpWorkbook(buffer: Buffer, maxRowsPerSheet = 40): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);

  const parts: string[] = [];
  workbook.eachSheet((sheet) => {
    parts.push(`### Sheet: "${sheet.name}"`);
    const rowCount = Math.min(sheet.rowCount, maxRowsPerSheet);
    for (let r = 1; r <= rowCount; r++) {
      const row = sheet.getRow(r);
      const values = (row.values as ExcelJS.CellValue[]).slice(1); // index 0 is unused by ExcelJS
      const cells = values.map((v) => {
        if (v === null || v === undefined) return "";
        if (typeof v === "object" && "richText" in (v as object)) {
          return (v as { richText: { text: string }[] }).richText.map((t) => t.text).join("");
        }
        return String(v);
      });
      if (cells.some((c) => c.trim() !== "")) {
        parts.push(`row ${r}: [${cells.join(" | ")}]`);
      }
    }
    parts.push("");
  });
  return parts.join("\n");
}
