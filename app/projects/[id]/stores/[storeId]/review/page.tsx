import { notFound } from "next/navigation";
import { getProject, getStore, listImagesByStore, listProductsByStore, getGlobalTotalCost } from "@/lib/db";
import { ReviewWorkspace } from "@/components/review/ReviewWorkspace";

export const dynamic = "force-dynamic";

export default async function ReviewPage({ params }: { params: Promise<{ id: string; storeId: string }> }) {
  const { id, storeId } = await params;
  const [project, store] = await Promise.all([getProject(id), getStore(storeId)]);
  if (!project || !store || store.project_id !== id) notFound();
  const [images, products, globalCost] = await Promise.all([
    listImagesByStore(storeId),
    listProductsByStore(storeId),
    getGlobalTotalCost(),
  ]);

  return (
    <ReviewWorkspace
      project={project}
      store={store}
      initialImages={images}
      initialProducts={products}
      initialGlobalCost={globalCost}
    />
  );
}
