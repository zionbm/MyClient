import { ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { type Business, type User } from "@prisma/client";
import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import { getEnv, getInternalApiSecret, verifyGoogleOidcToken } from "@myclient/common";
import { AuthRepository } from "./core.repositories.js";

export type RequestHeaders = Record<string, string | string[] | undefined>;

type AuthenticatedUser = User & {
  business: Business | null;
  memberships?: Array<{ businessId: string; memberType: string; status: string; business?: Business }>;
};

export type VerifiedAuth = {
  firebaseUid: string;
  email?: string;
  phoneNumber?: string;
  displayName?: string;
};

export function authProviderName() {
  return getEnv("AUTH_PROVIDER", "mock");
}

function headerValue(headers: RequestHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()] ?? headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function parseMockFirebaseUid(headers: RequestHeaders): string {
  const authorization = headerValue(headers, "authorization");
  const prefix = "Bearer mock:";
  if (!authorization?.startsWith(prefix)) {
    throw new UnauthorizedException("Missing or invalid authorization token");
  }
  const firebaseUid = authorization.slice(prefix.length).trim();
  if (!firebaseUid) {
    throw new UnauthorizedException("Missing or invalid authorization token");
  }
  return firebaseUid;
}

function firebaseApp() {
  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault() });
  }
}

function parseBearerToken(headers: RequestHeaders): string {
  const authorization = headerValue(headers, "authorization");
  const prefix = "Bearer ";
  if (!authorization?.startsWith(prefix)) {
    throw new UnauthorizedException("Missing or invalid authorization token");
  }
  const token = authorization.slice(prefix.length).trim();
  if (!token) {
    throw new UnauthorizedException("Missing or invalid authorization token");
  }
  return token;
}

function parseOptionalBearerToken(headers: RequestHeaders): string | undefined {
  const authorization = headerValue(headers, "authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return undefined;
  }
  return authorization.slice("Bearer ".length).trim() || undefined;
}

function displayNameFromToken(decoded: DecodedIdToken): string | undefined {
  const value = decoded.name ?? decoded.email;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

@Injectable()
export class CoreAccessService {
  constructor(@Inject(AuthRepository) private readonly auth: AuthRepository) {}

  async requireAuthenticatedUser(headers: RequestHeaders): Promise<AuthenticatedUser> {
    const { firebaseUid, phoneNumber } = await this.verifyAuth(headers);
    const user = await this.auth.getMe(firebaseUid, phoneNumber);
    if (!user) {
      throw new UnauthorizedException("Authenticated user was not found");
    }
    return user;
  }

  async requireBusinessAccess(headers: RequestHeaders, businessId: string): Promise<AuthenticatedUser> {
    const user = await this.requireAuthenticatedUser(headers);
    const hasMembership = user.memberships?.some(
      (membership) => membership.businessId === businessId && membership.status === "ACTIVE"
    );
    if (user.businessId !== businessId && !hasMembership) {
      throw new ForbiddenException("User is not allowed to access this business");
    }
    return user;
  }

  requireInternalSecret(headers: RequestHeaders): void {
    if (headerValue(headers, "x-internal-secret") !== getInternalApiSecret()) {
      throw new UnauthorizedException("Missing or invalid internal secret");
    }
  }

  async requireInternalScheduler(headers: RequestHeaders): Promise<void> {
    const token = parseOptionalBearerToken(headers);
    const allowedServiceAccount = process.env.SCHEDULER_SERVICE_ACCOUNT_EMAIL ?? "";
    const audience = process.env.SCHEDULER_OIDC_AUDIENCE ?? "";
    if (!allowedServiceAccount || !audience) {
      this.requireInternalSecret(headers);
      return;
    }
    if (!token) {
      throw new UnauthorizedException("Missing scheduler identity token");
    }
    try {
      await verifyGoogleOidcToken({
        token,
        audiences: audience
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        allowedServiceAccounts: allowedServiceAccount
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      });
    } catch {
      throw new UnauthorizedException("Missing or invalid scheduler identity token");
    }
  }

  async verifyAuth(headers: RequestHeaders, options?: { mockFallback?: string }): Promise<VerifiedAuth> {
    if (authProviderName() === "firebase") {
      const token = parseBearerToken(headers);
      try {
        firebaseApp();
        const decoded = await getAuth().verifyIdToken(token);
        return {
          firebaseUid: decoded.uid,
          email: decoded.email,
          phoneNumber: typeof decoded.phone_number === "string" ? decoded.phone_number : undefined,
          displayName: displayNameFromToken(decoded)
        };
      } catch {
        throw new UnauthorizedException("Missing or invalid Firebase ID token");
      }
    }
    return {
      firebaseUid: options?.mockFallback ?? parseMockFirebaseUid(headers),
      phoneNumber: headerValue(headers, "x-mock-phone-number")
    };
  }
}
