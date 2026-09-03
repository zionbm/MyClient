import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { V2CreateNoteSchema, V2UpdateNoteSchema } from "@myclient/contracts";
import { CoreAccessService } from "./core-access.service.js";
import { CoreV2IdempotencyService } from "./core-v2-idempotency.service.js";
import { AuditRepository, V2NotesRepository } from "./core.repositories.js";
import { PrismaService } from "./prisma.service.js";
import { requiredIdempotencyKey, type RequestHeaders } from "./core-utils.js";

@Injectable()
export class CoreV2NotesService {
  constructor(
    @Inject(CoreAccessService) private readonly access: CoreAccessService,
    @Inject(CoreV2IdempotencyService) private readonly idempotency: CoreV2IdempotencyService,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(V2NotesRepository) private readonly notes: V2NotesRepository,
    @Inject(PrismaService) private readonly prisma: PrismaService
  ) {}

  async create(headers: RequestHeaders, businessId: string, customerId: string, body: unknown) {
    const user = await this.access.requireV2BusinessAccess(headers, businessId);
    const command = V2CreateNoteSchema.parse(body);
    return this.idempotency.execute({
      businessId,
      userId: user.id,
      scope: `v2.note.create.${customerId}`,
      key: requiredIdempotencyKey(headers),
      request: command,
      execute: () => this.prisma.$transaction(async (tx) => {
        const note = await this.notes.create({ businessId, customerId, ...command }, tx);
        if (!note) throw new NotFoundException("Customer not found");
        await this.recordAudit(businessId, user.id, note.id, "CREATE_V2_NOTE", note, tx);
        return { note };
      })
    });
  }

  async update(headers: RequestHeaders, businessId: string, customerId: string, noteId: string, body: unknown) {
    const user = await this.access.requireV2BusinessAccess(headers, businessId);
    const command = V2UpdateNoteSchema.parse(body);
    return this.idempotency.execute({
      businessId,
      userId: user.id,
      scope: `v2.note.update.${noteId}`,
      key: requiredIdempotencyKey(headers),
      request: command,
      execute: () => this.prisma.$transaction(async (tx) => {
        const note = await this.notes.update({ businessId, customerId, noteId, ...command }, tx);
        if (!note) throw new NotFoundException("Note not found");
        await this.recordAudit(businessId, user.id, note.id, "UPDATE_V2_NOTE", note, tx);
        return { note };
      })
    });
  }

  async delete(headers: RequestHeaders, businessId: string, customerId: string, noteId: string) {
    const user = await this.access.requireV2BusinessAccess(headers, businessId);
    return this.idempotency.execute({
      businessId,
      userId: user.id,
      scope: `v2.note.delete.${noteId}`,
      key: requiredIdempotencyKey(headers),
      request: { customerId, noteId },
      execute: () => this.prisma.$transaction(async (tx) => {
        const note = await this.notes.softDelete(businessId, customerId, noteId, tx);
        if (!note) throw new NotFoundException("Note not found");
        await this.recordAudit(businessId, user.id, note.id, "DELETE_V2_NOTE", note, tx);
        return { note };
      })
    });
  }

  private recordAudit(businessId: string, actorId: string, entityId: string, action: string, after: unknown, tx: Prisma.TransactionClient) {
    return this.audit.record({
      businessId,
      actorType: "user",
      actorId,
      source: "app_v2",
      entityType: "note",
      entityId,
      action,
      after: JSON.parse(JSON.stringify(after)) as Prisma.InputJsonValue
    }, tx);
  }
}
