export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startController } = await import("./lib/context");
    startController();
  }
}
