import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AddPaymentSchema, DateRangeQuerySchema, PutAmountSchema, UpdateAmountSchema } from "@myclient/contracts";
import { CoreAccessService } from "./core-access.service.js";
import { CoreIdempotencyService } from "./core-idempotency.service.js";
import { AuditRepository, AmountsRepository } from "./core.repositories.js";
import type { ActivityKind } from "./repositories/activities.repositories.js";
import { PrismaService } from "./prisma.service.js";
import { requiredIdempotencyKey, type RequestHeaders } from "./core-utils.js";

@Injectable()
export class CoreAmountsService {
  constructor(
    @Inject(CoreAccessService) private readonly access: CoreAccessService,
    @Inject(CoreIdempotencyService) private readonly idempotency: CoreIdempotencyService,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(AmountsRepository) private readonly amounts: AmountsRepository,
    @Inject(PrismaService) private readonly prisma: PrismaService
  ) {}

  async get(kind: ActivityKind, headers: RequestHeaders, businessId: string, entityId: string) {
    await this.access.requireBusinessAccess(headers, businessId);
    const amount = await this.amounts.find(kind, businessId, entityId);
    if (!amount) throw new NotFoundException("Amount not found");
    return { amount };
  }

  put(kind: ActivityKind, headers: RequestHeaders, businessId: string, entityId: string, body: unknown) {
    return this.set(kind, headers, businessId, entityId, "put", PutAmountSchema.parse(body));
  }

  patch(kind: ActivityKind, headers: RequestHeaders, businessId: string, entityId: string, body: unknown) {
    return this.set(kind, headers, businessId, entityId, "patch", UpdateAmountSchema.parse(body));
  }

  async payment(kind: ActivityKind, headers: RequestHeaders, businessId: string, entityId: string, body: unknown) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const command = AddPaymentSchema.parse(body);
    return this.idempotency.execute({
      businessId,
      userId: user.id,
      scope: `v2.${kind}.amount.payment.${entityId}`,
      key: requiredIdempotencyKey(headers),
      request: command,
      execute: () =>
        this.prisma.$transaction(async (tx) => {
          const result = await this.amounts.payment(
            {
              kind,
              businessId,
              entityId,
              actorUserId: user.id,
              mode: command.mode,
              amount: command.amount,
              source: "core_v2"
            },
            tx
          );
          this.validateResult(result);
          await this.recordAudit(kind, businessId, user.id, entityId, "PAYMENT", result.amount, tx);
          return { amount: result.amount, [kind]: { id: entityId } };
        })
    });
  }

  async paymentReport(headers: RequestHeaders, businessId: string, query: unknown) {
    await this.access.requireBusinessAccess(headers, businessId);
    const command = DateRangeQuerySchema.parse(query);
    return this.amounts.paymentReport(businessId, new Date(command.from), new Date(command.to));
  }

  async openBalances(headers: RequestHeaders, businessId: string) {
    await this.access.requireBusinessAccess(headers, businessId);
    return this.amounts.openBalances(businessId);
  }

  private async set(
    kind: ActivityKind,
    headers: RequestHeaders,
    businessId: string,
    entityId: string,
    action: string,
    command: { totalAmount?: number; paidAmount?: number; confirmed?: boolean; version?: number }
  ) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    return this.idempotency.execute({
      businessId,
      userId: user.id,
      scope: `v2.${kind}.amount.${action}.${entityId}`,
      key: requiredIdempotencyKey(headers),
      request: command,
      execute: () =>
        this.prisma.$transaction(async (tx) => {
          const result = await this.amounts.set(
            { kind, businessId, entityId, actorUserId: user.id, change: command, source: "core_v2" },
            tx
          );
          this.validateResult(result);
          await this.recordAudit(kind, businessId, user.id, entityId, "SET_AMOUNT", result.amount, tx);
          return { amount: result.amount };
        })
    });
  }

  private validateResult(result: {
    notFound?: true;
    amountNotFound?: true;
    needsConfirmation?: true;
    invalidAmount?: true;
    versionConflict?: true;
  }) {
    if (result.notFound) throw new NotFoundException("Activity not found");
    if (result.amountNotFound) throw new NotFoundException("Amount not found");
    if (result.needsConfirmation)
      throw new ConflictException({
        code: "AMOUNT_CONFIRMATION_REQUIRED",
        message: "Lowering total below the paid amount requires confirmation and an explicit paid amount correction"
      });
    if (result.versionConflict)
      throw new ConflictException({ code: "ENTITY_VERSION_CONFLICT", message: "Amount changed since it was loaded" });
    if (result.invalidAmount)
      throw new BadRequestException({
        code: "INVALID_AMOUNT",
        message: "Paid amount must be between zero and the total amount"
      });
  }

  private recordAudit(
    kind: ActivityKind,
    businessId: string,
    actorId: string,
    entityId: string,
    action: string,
    after: unknown,
    tx: Prisma.TransactionClient
  ) {
    return this.audit.record(
      {
        businessId,
        actorType: "user",
        actorId,
        source: "core_v2",
        entityType: "amount",
        entityId,
        action: `${action}__${kind.toUpperCase()}`,
        after: JSON.parse(JSON.stringify(after)) as Prisma.InputJsonValue
      },
      tx
    );
  }
}
