import type { HealthResponse } from "@myclient/contracts";

export function health(service: string, dependencies?: Record<string, string>): HealthResponse {
  return {
    service,
    status: "ok",
    timestamp: new Date().toISOString(),
    dependencies
  };
}
