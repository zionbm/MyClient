import { randomUUID } from "node:crypto";
import { log } from "./logger.js";

type ObservedRequest = {
  headers: Record<string, string | string[] | undefined>;
  method: string;
  url: string;
  requestId?: string;
  startedAt?: number;
};

type ObservedResponse = {
  statusCode: number;
  header: (name: string, value: string) => void;
};

type FastifyLike = {
  addHook: (
    name: "onRequest" | "onResponse",
    hook: (request: ObservedRequest, response: ObservedResponse, done: () => void) => void
  ) => void;
};

export function configureHttpObservability(server: FastifyLike, service: string): void {
  server.addHook("onRequest", (request, response, done) => {
    const suppliedRequestId = request.headers["x-request-id"];
    request.requestId = typeof suppliedRequestId === "string" && suppliedRequestId.trim()
      ? suppliedRequestId
      : randomUUID();
    request.startedAt = Date.now();
    response.header("x-request-id", request.requestId);
    done();
  });

  server.addHook("onResponse", (request, response, done) => {
    log("info", "http request completed", {
      service,
      requestId: request.requestId,
      method: request.method,
      url: request.url,
      statusCode: response.statusCode,
      durationMs: request.startedAt === undefined ? undefined : Date.now() - request.startedAt
    });
    done();
  });
}
