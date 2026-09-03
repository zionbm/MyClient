export type ServiceName = "core" | "ai" | "voice" | "telephony" | "worker";

const BOOLEAN_VARIABLES = [
  "MOCK_LLM_PROVIDER",
  "MOCK_STT_PROVIDER",
  "MOCK_TTS_PROVIDER",
  "MOCK_PLIVO_PROVIDER",
  "MOCK_FCM_PROVIDER",
  "WORKER_TASK_POLL_ENABLED"
];

const URL_VARIABLES = ["AI_BASE_URL", "VOICE_BASE_URL", "CORE_BASE_URL"];

function requireVariables(environment: NodeJS.ProcessEnv, names: string[]) {
  const missing = names.filter((name) => !environment[name]?.trim());
  if (missing.length > 0) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
}

export function validateServiceEnvironment(service: ServiceName, environment: NodeJS.ProcessEnv = process.env): void {
  for (const name of BOOLEAN_VARIABLES) {
    const value = environment[name];
    if (value !== undefined && value !== "true" && value !== "false") {
      throw new Error(`Invalid boolean environment variable ${name}`);
    }
  }
  for (const name of URL_VARIABLES) {
    const value = environment[name];
    if (value !== undefined) {
      try {
        new URL(value);
      } catch {
        throw new Error(`Invalid URL environment variable ${name}`);
      }
    }
  }
  if (environment.NODE_ENV !== "production") return;

  requireVariables(environment, ["INTERNAL_API_SECRET"]);
  if (service === "core") requireVariables(environment, ["DATABASE_URL", "AI_BASE_URL", "VOICE_BASE_URL"]);
  if (service === "ai" && environment.MOCK_LLM_PROVIDER !== "true") requireVariables(environment, ["OPENAI_API_KEY"]);
  if (service === "voice") requireVariables(environment, ["OPENAI_API_KEY"]);
  if (service === "telephony") requireVariables(environment, ["CORE_BASE_URL", "VOICE_BASE_URL"]);
  if (service === "worker") requireVariables(environment, ["CORE_BASE_URL"]);
}
