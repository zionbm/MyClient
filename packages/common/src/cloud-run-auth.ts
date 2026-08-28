import { getEnv } from "./env.js";
import { OAuth2Client, type TokenPayload } from "google-auth-library";

const metadataBaseUrl = "http://metadata.google.internal/computeMetadata/v1";
const oidcClient = new OAuth2Client();

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

export type GoogleOidcVerificationOptions = {
  token: string;
  audiences: string[];
  allowedServiceAccounts: string[];
};

export async function verifyGoogleOidcToken(options: GoogleOidcVerificationOptions): Promise<TokenPayload> {
  const ticket = await oidcClient.verifyIdToken({
    idToken: options.token,
    audience: options.audiences
  });
  const payload = ticket.getPayload();
  const email = payload?.email;

  if (!payload || !email || !options.allowedServiceAccounts.includes(email)) {
    throw new Error("Google OIDC token was not issued for an allowed service account");
  }

  if (payload.email_verified === false) {
    throw new Error("Google OIDC service account email is not verified");
  }

  return payload;
}
