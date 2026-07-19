import { api } from "@/lib/routes";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return api().createEnrollmentToken(request);
}
