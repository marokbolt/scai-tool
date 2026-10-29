import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { classifyImage } from "@/lib/claude";
import { addImage, getProject, getGlobalTotalCost, incrementProjectCost } from "@/lib/db";
import { downloadFile } from "@/lib/storage";
import { checkCostCaps, computeCost } from "@/lib/pricing";
import type { ProjectImage } from "@/lib/types";

// Called once per image AFTER the browser has already uploaded it directly
// to Storage -- this request carries only a path string, never the image
// bytes, so it stays well under any serverless body-size limit regardless
// of how large the photo or how many are in the batch.
export async function POST(req: NextRequest) {
  try {
    const { projectId, storeId, fileName, storagePath, mediaType } = (await req.json()) as {
      projectId: string;
      storeId: string;
      fileName: string;
      storagePath: string;
      mediaType: string;
    };

    // Classification is a nice-to-have tag, not critical path -- if the cost
    // cap is hit (or classification errors for any other reason), the image
    // still uploads untagged rather than failing the whole upload.
    let imageType: ProjectImage["image_type"] = null;
    try {
      const project = await getProject(projectId);
      const globalTotal = await getGlobalTotalCost();
      const capCheck = project ? checkCostCaps(project, globalTotal) : { blocked: false as const };
      if (!capCheck.blocked) {
        const buffer = await downloadFile(storagePath);
        const { type, model, input_tokens, output_tokens } = await classifyImage(buffer.toString("base64"), mediaType || "image/jpeg");
        await incrementProjectCost(projectId, computeCost(model, input_tokens, output_tokens));
        imageType = type as ProjectImage["image_type"];
      }
    } catch (classifyErr) {
      console.error("Image classification failed, uploading untagged:", classifyErr);
      imageType = null;
    }

    const image: ProjectImage = {
      id: randomUUID(),
      project_id: projectId,
      store_id: storeId,
      file_name: fileName,
      storage_path: storagePath,
      image_type: imageType,
      is_reviewed: false,
      created_at: new Date().toISOString(),
    };
    await addImage(image);
    return NextResponse.json({ image });
  } catch (err: unknown) {
    console.error("POST /api/ingest-image failed:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to save image" }, { status: 500 });
  }
}
