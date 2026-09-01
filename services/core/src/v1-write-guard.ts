const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const LEGACY_RESOURCE_ROOTS = new Set(["reminders", "appointments", "home-visits", "quotes", "ai-pending-actions"]);

export function v1WriteBusinessId(method: string, url: string) {
  if (SAFE_METHODS.has(method.toUpperCase())) return undefined;
  const path = url.split("?", 1)[0] ?? url;
  if (path.startsWith("/v2/") || path.startsWith("/internal/")) return undefined;
  const match = path.match(/^\/businesses\/([^/]+)/);
  if (!match?.[1]) return undefined;
  const segments = path.split("/").filter(Boolean);
  const resource = segments[2];
  if (resource === "customers") {
    return segments[4] === "notes" ? undefined : decodeURIComponent(match[1]);
  }
  if (resource === "voice-commands") {
    return segments[3] === "realtime-session" ? undefined : decodeURIComponent(match[1]);
  }
  return resource && LEGACY_RESOURCE_ROOTS.has(resource) ? decodeURIComponent(match[1]) : undefined;
}
