import { api } from "@/lib/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return api().testStorage(request);
}
