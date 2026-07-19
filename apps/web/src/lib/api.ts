import { AuthenticationError, NotFoundError, Store } from "./store";
import { tokensMatch } from "./security";
import type { CommandType } from "./types";

const commandTypes = new Set<CommandType>([
  "sync",
  "update_agent",
  "reload_policy",
  "collect_diagnostics"
]);

class ValidationError extends Error {}

async function bodyObject(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new ValidationError("request body must be valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError("request body must be an object");
  }
  return value as Record<string, unknown>;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

export class ControllerApi {
  constructor(
    private readonly store: Store,
    private readonly adminToken: string
  ) {}

  health(): Response {
    return json({
      status: "ok",
      version: "0.1.0",
      ...this.store.health()
    });
  }

  async createEnrollmentToken(request: Request): Promise<Response> {
    const unauthorized = this.requireAdmin(request);
    if (unauthorized !== null) {
      return unauthorized;
    }
    return this.handle(async () => {
      const body = await bodyObject(request);
      const expiresIn = body.expires_in ?? 600;
      if (
        typeof expiresIn !== "number" ||
        !Number.isInteger(expiresIn) ||
        expiresIn < 60 ||
        expiresIn > 86_400
      ) {
        throw new ValidationError(
          "expires_in must be an integer from 60 to 86400"
        );
      }
      return json(this.store.createEnrollmentToken(expiresIn));
    });
  }

  async enroll(request: Request): Promise<Response> {
    return this.handle(async () => {
      const body = await bodyObject(request);
      for (const field of [
        "token",
        "name",
        "platform",
        "agent_version"
      ] as const) {
        if (typeof body[field] !== "string" || body[field].length === 0) {
          throw new ValidationError(`${field} must be a non-empty string`);
        }
      }
      return json(
        this.store.enrollDevice({
          token: body.token as string,
          name: body.name as string,
          platform: body.platform as string,
          agent_version: body.agent_version as string,
          public_key: typeof body.public_key === "string" ? body.public_key : null
        }),
        201
      );
    });
  }

  listDevices(request: Request): Response {
    const unauthorized = this.requireAdmin(request);
    return unauthorized ?? json(this.store.listDevices());
  }

  async heartbeat(request: Request, deviceId: string): Promise<Response> {
    const unauthorized = this.requireDevice(request, deviceId);
    if (unauthorized !== null) {
      return unauthorized;
    }
    return this.handle(async () => {
      const body = await bodyObject(request);
      if (
        typeof body.agent_version !== "string" ||
        body.agent_version.length === 0
      ) {
        throw new ValidationError("agent_version must be a non-empty string");
      }
      return json(this.store.heartbeat(deviceId, body.agent_version));
    });
  }

  async createCommand(
    request: Request,
    deviceId: string
  ): Promise<Response> {
    const unauthorized = this.requireAdmin(request);
    if (unauthorized !== null) {
      return unauthorized;
    }
    return this.handle(async () => {
      const body = await bodyObject(request);
      if (
        typeof body.type !== "string" ||
        !commandTypes.has(body.type as CommandType)
      ) {
        throw new ValidationError("unsupported command type");
      }
      if (
        typeof body.idempotency_key !== "string" ||
        body.idempotency_key.length === 0 ||
        body.idempotency_key.length > 200
      ) {
        throw new ValidationError(
          "idempotency_key must contain 1 to 200 characters"
        );
      }
      const payload =
        typeof body.payload === "object" &&
        body.payload !== null &&
        !Array.isArray(body.payload)
          ? (body.payload as Record<string, unknown>)
          : {};
      return json(
        this.store.createCommand({
          deviceId,
          type: body.type as CommandType,
          payload,
          idempotencyKey: body.idempotency_key
        })
      );
    });
  }

  claimCommands(request: Request, deviceId: string): Response {
    const unauthorized = this.requireDevice(request, deviceId);
    if (unauthorized !== null) {
      return unauthorized;
    }
    const limit = Number(new URL(request.url).searchParams.get("limit") ?? "10");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return json({ error: "limit must be an integer from 1 to 100" }, 422);
    }
    return json(this.store.claimCommands(deviceId, limit));
  }

  async acknowledgeCommand(
    request: Request,
    deviceId: string,
    commandId: string
  ): Promise<Response> {
    const unauthorized = this.requireDevice(request, deviceId);
    if (unauthorized !== null) {
      return unauthorized;
    }
    return this.handle(async () => {
      const body = await bodyObject(request);
      if (body.status !== "succeeded" && body.status !== "failed") {
        throw new ValidationError("status must be succeeded or failed");
      }
      return json(
        this.store.acknowledgeCommand({
          deviceId,
          commandId,
          status: body.status,
          result:
            typeof body.result === "object" &&
            body.result !== null &&
            !Array.isArray(body.result)
              ? (body.result as Record<string, unknown>)
              : null,
          error: typeof body.error === "string" ? body.error : null
        })
      );
    });
  }

  private requireAdmin(request: Request): Response | null {
    const token = request.headers.get("x-relaydot-admin-token");
    if (token === null || !tokensMatch(token, this.adminToken)) {
      return json({ error: "invalid admin token" }, 401);
    }
    return null;
  }

  private requireDevice(request: Request, deviceId: string): Response | null {
    const authorization = request.headers.get("authorization");
    if (authorization === null || !authorization.startsWith("Bearer ")) {
      return json({ error: "missing device bearer token" }, 401);
    }
    try {
      this.store.authenticateDevice(
        deviceId,
        authorization.slice("Bearer ".length)
      );
      return null;
    } catch (error) {
      if (error instanceof AuthenticationError) {
        return json({ error: error.message }, 401);
      }
      throw error;
    }
  }

  private async handle(action: () => Promise<Response>): Promise<Response> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof ValidationError) {
        return json({ error: error.message }, 422);
      }
      if (error instanceof AuthenticationError) {
        return json({ error: error.message }, 401);
      }
      if (error instanceof NotFoundError) {
        return json({ error: error.message }, 404);
      }
      throw error;
    }
  }
}
