import { notFound } from "next/navigation";
import { getProject, getStore, listProductsByStore } from "@/lib/db";
import { FinishWorkspace } from "@/components/finish/FinishWorkspace";

export const dynamic = "force-dynamic";

export default async function FinishPage({ params }: { params: Promise<{ id: string; storeId: string }> }) {
  const { id, storeId } = await params;
  const [project, store] = await Promise.all([getProject(id), getStore(storeId)]);
  if (!project || !store || store.project_id !== id) notFound();
  const products = await listProductsByStore(storeId);

  return <FinishWorkspace project={project} store={store} initialProducts={products} />;
}
