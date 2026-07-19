import { api } from "@/lib/routes";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ deviceId: string; commandId: string }> }
): Promise<Response> {
  const { deviceId, commandId } = await context.params;
  return api().acknowledgeCommand(request, deviceId, commandId);
}
