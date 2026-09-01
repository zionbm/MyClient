import { createHash } from "node:crypto";
import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { log } from "@myclient/common";
import { PrismaService } from "./prisma.service.js";

type IdempotentWriteInput<T> = {
  businessId: string;
  userId: string;
  scope: string;
  key: string;
  request: unknown;
  execute: () => Promise<T>;
};

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

function requestHash(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function jsonResponse<T>(value: T): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

@Injectable()
export class CoreV2IdempotencyService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async execute<T>(input: IdempotentWriteInput<T>): Promise<T> {
    const hash = requestHash(input.request);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    let record;
    try {
      record = await this.prisma.apiIdempotencyRecord.create({
        data: {
          businessId: input.businessId,
          userId: input.userId,
          scope: input.scope,
          key: input.key,
          requestHash: hash,
          expiresAt
        }
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
        throw error;
      }
      const existing = await this.prisma.apiIdempotencyRecord.findUniqueOrThrow({
        where: {
          businessId_userId_scope_key: {
            businessId: input.businessId,
            userId: input.userId,
            scope: input.scope,
            key: input.key
          }
        }
      });
      if (existing.requestHash !== hash) {
        log("warn", "v2 idempotency key payload mismatch", { businessId: input.businessId, scope: input.scope });
        throw new ConflictException({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "The idempotency key was already used with a different request"
        });
      }
      if (existing.status === "COMPLETED" && existing.response !== null) {
        log("info", "v2 idempotency replay", { businessId: input.businessId, scope: input.scope });
        return existing.response as T;
      }
      if (existing.expiresAt > new Date()) {
        log("info", "v2 idempotency request still in progress", { businessId: input.businessId, scope: input.scope });
        throw new ConflictException({
          code: "IDEMPOTENCY_REQUEST_IN_PROGRESS",
          message: "A request with this idempotency key is still in progress"
        });
      }
      const reclaimed = await this.prisma.apiIdempotencyRecord.updateMany({
        where: { id: existing.id, status: "PENDING", expiresAt: { lte: new Date() } },
        data: { expiresAt }
      });
      if (reclaimed.count !== 1) {
        throw new ConflictException({
          code: "IDEMPOTENCY_REQUEST_IN_PROGRESS",
          message: "A request with this idempotency key is still in progress"
        });
      }
      record = { ...existing, expiresAt };
    }

    try {
      const response = await input.execute();
      await this.prisma.apiIdempotencyRecord.update({
        where: { id: record.id },
        data: { status: "COMPLETED", response: jsonResponse(response) }
      });
      return response;
    } catch (error) {
      await this.prisma.apiIdempotencyRecord.deleteMany({
        where: { id: record.id, status: "PENDING" }
      });
      throw error;
    }
  }
}
