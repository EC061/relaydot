import { api } from "@/lib/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ modelId: string }> }
): Promise<Response> {
  const { modelId } = await context.params;
  return api().setCatalogStatus(request, decodeURIComponent(modelId));
}
