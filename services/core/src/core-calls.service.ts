import { Inject, Injectable } from "@nestjs/common";
import { CoreAccessService } from "./core-access.service.js";
import { IncomingCallsRepository, V2CustomersRepository, V2TasksRepository } from "./core.repositories.js";
import { callDisplayStatus, callIvrSelection, paginatedResponse, paginationFromQuery, type RequestHeaders } from "./core-utils.js";
import { normalizeIsraeliPhone } from "./v2-normalization.js";

@Injectable()
export class CoreCallsService {
  constructor(
    @Inject(CoreAccessService) private readonly access: CoreAccessService,
    @Inject(IncomingCallsRepository) private readonly calls: IncomingCallsRepository,
    @Inject(V2CustomersRepository) private readonly customers: V2CustomersRepository,
    @Inject(V2TasksRepository) private readonly tasks: V2TasksRepository
  ) {}

  async list(headers: RequestHeaders, businessId: string, query: unknown) {
    await this.access.requireBusinessAccess(headers, businessId);
    const pagination = paginationFromQuery(query);
    const page = paginatedResponse(await this.calls.listByBusiness(businessId, pagination), pagination.limit);
    return {
      calls: await Promise.all(page.items.map(async (call) => {
        const transcript = call.transcripts.at(-1) ?? null;
        const relatedTask = transcript?.taskId
          ? await this.tasks.findById(businessId, transcript.taskId)
          : null;
        const customer = call.fromNumber
          ? await this.customers.findByNormalizedPhone(businessId, normalizeIsraeliPhone(call.fromNumber) ?? "")
          : null;
        return {
          id: call.id,
          fromNumber: call.fromNumber,
          toNumber: call.toNumber,
          calledAt: call.createdAt,
          durationSeconds: null,
          ivrSelection: callIvrSelection(call),
          displayStatus: relatedTask?.status === "DONE" ? "TASK_DONE" : callDisplayStatus(call),
          urgent: call.urgent,
          transcriptPreview: transcript?.transcript ?? null,
          relatedTask: relatedTask ? { id: relatedTask.id, status: relatedTask.status, dueAt: relatedTask.dueAt } : null,
          customer
        };
      })),
      pageInfo: page.pageInfo
    };
  }
}
