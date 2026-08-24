import { getEnv } from "./env.js";

const metadataBaseUrl = "http://metadata.google.internal/computeMetadata/v1";

export async function cloudRunServiceAuthHeaders(baseUrl: string): Promise<Record<string, string>> {
  if (getEnv("CLOUD_RUN_SERVICE_AUTH", "none") !== "google") {
    return {};
  }

  const audience = new URL(baseUrl).origin;
  const tokenUrl = `${metadataBaseUrl}/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`;
  const response = await fetch(tokenUrl, {
    headers: { "Metadata-Flavor": "Google" }
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch Cloud Run identity token: ${response.status}`);
  }

  return {
    authorization: `Bearer ${await response.text()}`
  };
}
