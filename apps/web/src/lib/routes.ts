import { ControllerApi } from "./api";
import { getController } from "./context";

export function api(): ControllerApi {
  return new ControllerApi(
    getController().store,
    process.env.RELAYDOT_ADMIN_TOKEN ?? "relaydot-development-only"
  );
}
