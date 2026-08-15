import { api } from "@/lib/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function DELETE(
  request: Request,
  context: { params: Promise<{ modelId: string }> }
): Promise<Response> {
  return context.params.then(({ modelId }) =>
    api().deletePrice(request, decodeURIComponent(modelId))
  );
}
