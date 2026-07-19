import { Store } from "./store";
import { InProcessWorker } from "./worker";

export interface ControllerContext {
  store: Store;
  worker: InProcessWorker;
}

const globalController = globalThis as typeof globalThis & {
  relaydotController?: ControllerContext;
};

export function getController(): ControllerContext {
  if (globalController.relaydotController === undefined) {
    const store = new Store(
      process.env.RELAYDOT_DATABASE_PATH ?? "/app/data/relaydot.db"
    );
    globalController.relaydotController = {
      store,
      worker: new InProcessWorker(store)
    };
  }
  return globalController.relaydotController;
}

export function startController(): void {
  getController().worker.start();
}

export async function stopController(): Promise<void> {
  const controller = globalController.relaydotController;
  if (controller === undefined) {
    return;
  }
  await controller.worker.stop();
  controller.store.close();
  delete globalController.relaydotController;
}
