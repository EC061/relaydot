import { api } from "@/lib/routes";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ deviceId: string }> }
): Promise<Response> {
  const { deviceId } = await context.params;
  return api().claimCommands(request, deviceId);
}
