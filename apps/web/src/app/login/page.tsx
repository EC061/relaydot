import { redirect } from "next/navigation";

import { currentAdminSession } from "@/lib/session";

import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function Login() {
  if ((await currentAdminSession()) !== null) {
    redirect("/");
  }

  return (
    <main className="loginShell">
      <section className="loginCard">
        <span className="brandMark" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <p className="eyebrow">Controller access</p>
        <h1>Sign in to relaydot</h1>
        <p className="lede">
          The dashboard exposes the enrolled fleet and the audit trail. Present
          the administrator token configured on this controller to continue.
        </p>
        <LoginForm />
      </section>
    </main>
  );
}
