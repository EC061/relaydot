/** Server-component guard for authenticated controller pages. */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { getController } from "./context";
import { SESSION_COOKIE } from "./security";
import { isAuthenticationError } from "./store";
import type { AdminSession } from "./types";

export async function currentAdminSession(): Promise<AdminSession | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token === undefined || token.length === 0) {
    return null;
  }
  try {
    return getController().store.authenticateAdminSession(token);
  } catch (error) {
    if (isAuthenticationError(error)) {
      return null;
    }
    throw error;
  }
}

/** Redirects to the sign-in page unless the request carries a live session. */
export async function requireAdminSession(): Promise<AdminSession> {
  const session = await currentAdminSession();
  if (session === null) {
    redirect("/login");
  }
  return session;
}
