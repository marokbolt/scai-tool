import { notFound } from "next/navigation";
import { getProject, listStores, listImagesByStore } from "@/lib/db";
import { ProjectHub } from "@/components/project/ProjectHub";

export const dynamic = "force-dynamic";

export default async function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) notFound();

  const stores = await listStores(id);
  const storesWithProgress = await Promise.all(
    stores.map(async (store) => {
      const images = await listImagesByStore(store.id);
      return {
        store,
        imageCount: images.length,
        reviewedCount: images.filter((i) => i.is_reviewed).length,
      };
    })
  );

  return <ProjectHub project={project} storesWithProgress={storesWithProgress} />;
}
