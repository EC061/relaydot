import { api } from "@/lib/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  return api().storage(request);
}

export async function PUT(request: Request): Promise<Response> {
  return api().saveStorage(request);
}

export function DELETE(request: Request): Response {
  return api().deleteStorage(request);
}
