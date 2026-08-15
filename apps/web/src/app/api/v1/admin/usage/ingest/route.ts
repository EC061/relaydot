import { api } from "@/lib/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  return api().usageIngestStatus(request);
}

export async function POST(request: Request): Promise<Response> {
  return api().ingestNow(request);
}
