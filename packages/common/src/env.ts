export function getEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getPort(name: string, fallback: number): number {
  const value = process.env.PORT ?? process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const source = process.env.PORT ? "PORT" : name;
    throw new Error(`Invalid port in ${source}: ${value}`);
  }
  return parsed;
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export function getInternalApiSecret(): string {
  return getEnv("INTERNAL_API_SECRET", isProduction() ? undefined : "dev-internal-secret");
}
