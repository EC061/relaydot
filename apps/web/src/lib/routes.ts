import { ControllerApi } from "./api";
import {
  adminToken,
  catalogSourcesPath,
  ingestSchedule,
  publicUrl,
  secretKey
} from "./config";
import { getController } from "./context";

export { adminToken, catalogSourcesPath, ingestSchedule, publicUrl, secretKey };

export function api(): ControllerApi {
  return new ControllerApi(
    getController().store,
    adminToken(),
    publicUrl(),
    secretKey(),
    fetch,
    catalogSourcesPath()
  );
}
