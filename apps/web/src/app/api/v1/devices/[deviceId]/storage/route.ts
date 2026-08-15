import { api } from "@/lib/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ deviceId: string }> }
): Promise<Response> {
  const { deviceId } = await context.params;
  return api().deviceStorage(request, deviceId);
}
