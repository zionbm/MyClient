import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma.service.js";
import { BusinessesRepository } from "./business.repositories.js";
import { createdAtCursorWhere, paginationTake, type CreateCallTranscriptInput, type CreateIncomingCallInput, type PaginationInput, type UpdateIncomingCallInput } from "./repository.shared.js";

@Injectable()
export class IncomingCallsRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BusinessesRepository) private readonly businesses: BusinessesRepository
  ) {}

  async createOrUpdate(input: CreateIncomingCallInput) {
    await this.businesses.requireBusiness(input.businessId);
    return this.prisma.incomingCall.upsert({
      where: { plivoCallId: input.plivoCallId },
      update: {
        fromNumber: input.fromNumber,
        toNumber: input.toNumber,
        status: input.status,
        selectedDigit: input.selectedDigit,
        urgent: input.urgent ?? false
      },
      create: {
        businessId: input.businessId,
        plivoCallId: input.plivoCallId,
        fromNumber: input.fromNumber,
        toNumber: input.toNumber,
        status: input.status,
        selectedDigit: input.selectedDigit,
        urgent: input.urgent ?? false
      }
    });
  }

  async update(input: UpdateIncomingCallInput) {
    return this.prisma.incomingCall.update({
      where: { plivoCallId: input.plivoCallId },
      data: {
        status: input.status,
        selectedDigit: input.selectedDigit,
        urgent: input.urgent,
        recordingUrl: input.recordingUrl
      }
    });
  }

  async findByPlivoCallId(plivoCallId: string) {
    return this.prisma.incomingCall.findUnique({
      where: { plivoCallId }
    });
  }

  async listByBusiness(businessId: string, pagination?: PaginationInput) {
    await this.businesses.requireBusiness(businessId);
    return this.prisma.incomingCall.findMany({
      where: {
        businessId,
        ...createdAtCursorWhere(pagination?.cursor)
      },
      include: { transcripts: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: paginationTake(pagination)
    });
  }
}

@Injectable()
export class CallTranscriptsRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(input: CreateCallTranscriptInput) {
    return this.prisma.callTranscript.create({
      data: {
        businessId: input.businessId,
        incomingCallId: input.incomingCallId,
        transcript: input.transcript,
        taskId: input.taskId,
        provider: input.provider ?? "mock",
        confidence: input.confidence
      }
    });
  }
}
