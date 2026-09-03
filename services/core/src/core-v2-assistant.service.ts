import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { getEnv, getInternalApiSecret, log } from "@myclient/common";
import {
  AssistantPlanSchema,
  AssistantStepReferenceSchema,
  V2AssistantCommandSchema,
  V2CreateAssistantSessionSchema,
  V2CreateCustomerSchema,
  V2CreateNoteSchema,
  V2CreateTaskSchema,
  V2PendingActionsQuerySchema,
  V2ResolvePendingActionSchema,
  V2UpdateNoteSchema,
  V2UpdatePendingActionSchema,
  type AssistantPlan,
  type AssistantPlanStep
} from "@myclient/contracts";
import { CoreAccessService } from "./core-access.service.js";
import { CoreAiInternalClient } from "./core-internal-clients.service.js";
import { CoreV2IdempotencyService } from "./core-v2-idempotency.service.js";
import { CoreV2ActivitiesService } from "./core-v2-activities.service.js";
import { CoreV2ActionBatchesService } from "./core-v2-action-batches.service.js";
import { CoreOpenAiRealtimeClient } from "./core-openai-realtime-client.service.js";
import { AssistantSessionsRepository, BusinessSettingsRepository, V2ActivitiesRepository } from "./core.repositories.js";
import { PrismaService } from "./prisma.service.js";
import { parseOptionalDate, requiredIdempotencyKey, type RequestHeaders } from "./core-utils.js";
import { paginationFromParsedQuery, paginatedResponse } from "./core-utils.js";
import {
  normalizeCustomerName,
  normalizeIsraeliPhone,
  normalizeServiceAddress
} from "./v2-normalization.js";
import { applyAssistantConfirmationPolicy, materializeStepReferences, preferTranscriptCustomerName, stepsBlockedByPlannedClarification } from "./v2-assistant-plan.js";
import { composeAssistantSummary } from "./v2-assistant-reply.js";
import { assertAmountInvariant, money, nextPaidAmount, paymentStatus } from "./v2-money.js";
import { DEFAULT_WORKING_HOURS, freeSlots, isWithinWorkingHours, localDate, localDateTimeToUtc, workingWindow, type WorkingHours } from "./v2-scheduling.js";
import { effectiveScheduleEnd, shiftedScheduleEnd, verifyScheduleConflictToken, type ScheduleConflictOperation } from "./v2-schedule-confirmation.js";

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function orderedSteps(steps: AssistantPlanStep[]) {
  const remaining = new Map(steps.map((step) => [step.stepId, step]));
  const completed = new Set<string>();
  const result: AssistantPlanStep[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((step) => step.dependsOn.every((id) => completed.has(id)));
    if (ready.length === 0) throw new BadRequestException("Assistant plan contains unresolved dependencies");
    for (const step of ready) {
      result.push(step);
      completed.add(step.stepId);
      remaining.delete(step.stepId);
    }
  }
  return result;
}

@Injectable()
export class CoreV2AssistantService {
  constructor(
    @Inject(CoreAccessService) private readonly access: CoreAccessService,
    @Inject(CoreAiInternalClient) private readonly ai: CoreAiInternalClient,
    @Inject(CoreV2IdempotencyService) private readonly idempotency: CoreV2IdempotencyService,
    @Inject(AssistantSessionsRepository) private readonly sessions: AssistantSessionsRepository,
    @Inject(BusinessSettingsRepository) private readonly settings: BusinessSettingsRepository,
    @Inject(CoreV2ActivitiesService) private readonly activities: CoreV2ActivitiesService,
    @Inject(V2ActivitiesRepository) private readonly activityRepository: V2ActivitiesRepository,
    @Inject(CoreV2ActionBatchesService) private readonly actionBatches: CoreV2ActionBatchesService,
    @Inject(CoreOpenAiRealtimeClient) private readonly realtime: CoreOpenAiRealtimeClient,
    @Inject(PrismaService) private readonly prisma: PrismaService
  ) {}

  async createRealtimeSession(headers: RequestHeaders, businessId: string) {
    await this.access.requireV2BusinessAccess(headers, businessId);
    return this.realtime.createTranscriptionClientSecret({
      model: getEnv("OPENAI_REALTIME_TRANSCRIPTION_MODEL", "gpt-live-transcribe")
    });
  }

  async createSession(headers: RequestHeaders, businessId: string, body: unknown) {
    const user = await this.access.requireV2BusinessAccess(headers, businessId);
    const command = V2CreateAssistantSessionSchema.parse(body);
    return this.idempotency.execute({
      businessId,
      userId: user.id,
      scope: `v2.assistant.session.${command.clientSessionId}`,
      key: requiredIdempotencyKey(headers),
      request: command,
      execute: async () => ({
        session: await this.sessions.createOrRefresh({
          businessId,
          userId: user.id,
          clientSessionId: command.clientSessionId
        })
      })
    });
  }

  async command(headers: RequestHeaders, businessId: string, sessionId: string, body: unknown) {
    const user = await this.access.requireV2BusinessAccess(headers, businessId);
    const command = V2AssistantCommandSchema.parse(body);
    const session = await this.sessions.findActive({
      id: sessionId,
      businessId,
      userId: user.id,
      clientSessionId: command.clientSessionId
    });
    if (!session) throw new NotFoundException("Assistant session expired or was not found");
    const key = requiredIdempotencyKey(headers);
    return this.idempotency.execute({
      businessId,
      userId: user.id,
      scope: `v2.assistant.command.${sessionId}`,
      key,
      request: command,
      execute: async () => {
        const startedAt = Date.now();
        const businessSettings = await this.settings.getByBusiness(businessId);
        const [recentTurns, pendingActions] = await Promise.all([
          this.prisma.assistantTurn.findMany({
            where: { assistantSessionId: session.id, expiresAt: { gt: new Date() } },
            include: { actionBatch: { select: { finalSummary: true, status: true } } },
            orderBy: { createdAt: "desc" },
            take: 6
          }),
          this.prisma.aiPendingAction.findMany({
            where: { assistantSessionId: session.id, businessId, status: "PENDING" },
            select: {
              id: true,
              actionType: true,
              payload: true,
              question: true,
              missingFields: true,
              candidateEntities: true,
              requiresExplicitConfirmation: true,
              createdAt: true
            },
            orderBy: { createdAt: "desc" },
            take: 5
          })
        ]);
        const planningContext = {
          session: session.context,
          recentTurns: recentTurns.reverse().map((turn) => ({
            transcript: turn.approvedTranscript,
            summary: turn.actionBatch?.finalSummary,
            status: turn.actionBatch?.status
          })),
          pendingActions,
          environment: {
            now: new Date().toISOString(),
            timezone: businessSettings.timezone,
            workingHours: businessSettings.workingHours ?? DEFAULT_WORKING_HOURS
          }
        };
        const planned = await this.ai.planV2AssistantCommand({
          transcript: command.transcript,
          context: planningContext
        });
        const planningDurationMs = Date.now() - startedAt;
        let plan = AssistantPlanSchema.parse(planned.plan);
        plan = preferTranscriptCustomerName(
          plan,
          command.transcript,
          await this.prisma.customer.findMany({
            where: { businessId, deletedAt: null, mergedIntoCustomerId: null },
            select: { name: true, normalizedName: true }
          })
        );
        const resolvesPendingActionId = typeof plan.extractedFacts.resolvesPendingActionId === "string"
          ? plan.extractedFacts.resolvesPendingActionId
          : undefined;
        const confirmedPendingActionId = pendingActions.some((pending) =>
          pending.id === resolvesPendingActionId && pending.requiresExplicitConfirmation
        ) ? resolvesPendingActionId : undefined;
        plan = applyAssistantConfirmationPolicy(plan, confirmedPendingActionId);
        plan = await this.completeSatisfiedCallTask(plan, command.transcript, businessId);
        const steps = orderedSteps(plan.steps);
        const plannedClarificationChain = stepsBlockedByPlannedClarification(steps);
        const execution = await this.prisma.$transaction(async (tx) => {
          const actionBatch = await tx.actionBatch.create({
            data: {
              businessId,
              actorUserId: user.id,
              assistantSessionId: session.id,
              approvedTranscript: command.transcript,
              proposedPlan: jsonValue(plan),
              finalSummary: "",
              status: "WAITING",
              undoEligibleUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
            }
          });
          const outputs = new Map<string, Record<string, unknown>>();
          const statuses = new Map<string, string>();
          const receiptSteps: Array<Record<string, unknown>> = [];
          let sequence = 0;

          for (const step of steps) {
            if (plannedClarificationChain.has(step.stepId) && step.kind === "WRITE") {
              statuses.set(step.stepId, "BLOCKED");
              await tx.actionBatchStep.create({
                data: { actionBatchId: actionBatch.id, stepKey: step.stepId, stepType: step.kind, dependsOn: step.dependsOn, status: "BLOCKED", toolName: step.tool, input: jsonValue(step.input), errorCode: "CLARIFICATION_REQUIRED" }
              });
              receiptSteps.push({ stepId: step.stepId, tool: step.tool, status: "BLOCKED" });
              continue;
            }
            const dependencyWaiting = step.dependsOn.some((dependency) => statuses.get(dependency) !== "COMPLETED");
            if (dependencyWaiting) {
              statuses.set(step.stepId, "BLOCKED");
              await tx.actionBatchStep.create({
                data: {
                  actionBatchId: actionBatch.id,
                  stepKey: step.stepId,
                  stepType: step.kind,
                  dependsOn: step.dependsOn,
                  status: "BLOCKED",
                  toolName: step.tool,
                  input: jsonValue(step.input),
                  errorCode: "DEPENDENCY_WAITING"
                }
              });
              receiptSteps.push({ stepId: step.stepId, tool: step.tool, status: "BLOCKED" });
              continue;
            }

            const pendingInput = materializeStepReferences(step, outputs);
            const financialProblem = step.requiresExplicitConfirmation
              ? await this.financialConfirmationProblem(tx, businessId, { ...step, input: pendingInput })
              : undefined;
            if (step.kind === "CLARIFY" || step.tool === "ASK_CLARIFICATION" || step.requiresExplicitConfirmation) {
              const question = financialProblem?.question ?? (typeof step.input.question === "string"
                ? step.input.question
                : step.requiresExplicitConfirmation ? this.confirmationQuestion({ ...step, input: pendingInput }) : "נדרש מידע נוסף");
              const pending = await tx.aiPendingAction.create({
                data: {
                  businessId,
                  userId: user.id,
                  actionType: step.tool,
                  payload: jsonValue({ tool: step.tool, input: pendingInput, confirmationRequiredAfterInput: financialProblem !== undefined }),
                  missingFields: financialProblem?.missingFields ?? [],
                  actionBatchId: actionBatch.id,
                  createdByUserId: user.id,
                  assistantSessionId: session.id,
                  question,
                  dependencyStepKeys: step.dependsOn,
                  entityVersions: jsonValue(Object.fromEntries(step.dependsOn.flatMap((dependency) => {
                    const output = outputs.get(dependency);
                    return typeof output?.entityId === "string" && typeof output.entityVersion === "number"
                      ? [[output.entityId, output.entityVersion]]
                      : [];
                  }))),
                  requiresExplicitConfirmation: step.requiresExplicitConfirmation && financialProblem === undefined
                }
              });
              const batchStep = await tx.actionBatchStep.create({
                data: {
                  actionBatchId: actionBatch.id,
                  stepKey: step.stepId,
                  stepType: step.kind,
                  dependsOn: step.dependsOn,
                  status: "WAITING",
                  toolName: step.tool,
                  input: jsonValue(step.input),
                  output: { pendingActionId: pending.id }
                }
              });
              await tx.aiPendingAction.update({ where: { id: pending.id }, data: { actionBatchStepId: batchStep.id } });
              statuses.set(step.stepId, "WAITING");
              receiptSteps.push({ stepId: step.stepId, tool: step.tool, status: "WAITING", question, pendingActionId: pending.id });
              continue;
            }

            const batchStep = await tx.actionBatchStep.create({
              data: {
                actionBatchId: actionBatch.id,
                stepKey: step.stepId,
                stepType: step.kind,
                dependsOn: step.dependsOn,
                status: "RUNNING",
                toolName: step.tool,
                input: jsonValue(step.input)
              }
            });
            const output = await this.executeBasicWrite(tx, {
              businessId,
              userId: user.id,
              key,
              headers,
              step,
              outputs,
              emptyReadIsResult: plan.requestKind === "QUESTION" && step.kind === "READ"
            });
            if (output.waiting) {
              const pendingOptions = objectValue(output);
              const pendingInput = materializeStepReferences(step, outputs);
              const continuationSteps = steps.filter((candidate) => candidate.dependsOn.includes(step.stepId));
              const createCustomerSuggestion = typeof pendingOptions.createCustomerName === "string"
                ? { name: pendingOptions.createCustomerName, sourceStepId: step.stepId }
                : undefined;
              const pending = await tx.aiPendingAction.create({
                data: {
                  businessId,
                  userId: user.id,
                  actionType: step.tool,
                  payload: jsonValue({
                    tool: step.tool,
                    input: pendingInput,
                    confirmationOverrides: pendingOptions.confirmationOverrides,
                    createCustomerSuggestion,
                    continuationSteps
                  }),
                  missingFields: Array.isArray(pendingOptions.missingFields) ? pendingOptions.missingFields as string[] : [],
                  actionBatchId: actionBatch.id,
                  actionBatchStepId: batchStep.id,
                  createdByUserId: user.id,
                  assistantSessionId: session.id,
                  question: output.question,
                  candidateEntities: output.candidates ? jsonValue(output.candidates) : undefined,
                  entityVersions: output.entityVersions ? jsonValue(output.entityVersions) : undefined,
                  dependencyStepKeys: step.dependsOn,
                  requiresExplicitConfirmation: step.requiresExplicitConfirmation || pendingOptions.requiresExplicitConfirmation === true
                }
              });
              await tx.actionBatchStep.update({
                where: { id: batchStep.id },
                data: { status: "WAITING", output: jsonValue({ pendingActionId: pending.id }) }
              });
              statuses.set(step.stepId, "WAITING");
              receiptSteps.push({
                stepId: step.stepId,
                tool: step.tool,
                status: "WAITING",
                question: output.question,
                pendingActionId: pending.id,
                payload: step.input,
                missingFields: pendingOptions.missingFields ?? [],
                candidates: pendingOptions.candidates ?? []
              });
              continue;
            }
            if (output.entityType && output.entityId && output.entity) {
              sequence += 1;
              await tx.actionMutation.create({
                data: {
                  actionBatchId: actionBatch.id,
                  actionBatchStepId: batchStep.id,
                  sequence,
                  entityType: output.entityType,
                  entityId: output.entityId,
                  operation: output.operation ?? "CREATE",
                  before: output.before ? jsonValue(output.before) : undefined,
                  after: jsonValue(output.entity)
                }
              });
            }
            await tx.actionBatchStep.update({
              where: { id: batchStep.id },
              data: { status: "COMPLETED", output: jsonValue(output) }
            });
            outputs.set(step.stepId, output);
            statuses.set(step.stepId, "COMPLETED");
            receiptSteps.push({ stepId: step.stepId, tool: step.tool, status: "COMPLETED", ...output });
          }

          const waiting = [...statuses.values()].some((status) => status !== "COMPLETED");
          const completedCount = [...statuses.values()].filter((status) => status === "COMPLETED").length;
          const warnings = [...new Set(receiptSteps.flatMap((step) => Array.isArray(step.warnings) ? step.warnings.filter((warning): warning is string => typeof warning === "string") : []))];
          const status = waiting
            ? completedCount > 0 ? "PARTIALLY_COMPLETED" : "WAITING"
            : "COMPLETED";
          const summary = composeAssistantSummary({
            plan,
            state: status,
            completedCount,
            messages: receiptSteps.map((step) => typeof step.message === "string" ? step.message : undefined),
            questions: receiptSteps.map((step) => typeof step.question === "string" ? step.question : undefined),
            warnings
          });
          const updatedBatch = await tx.actionBatch.update({
            where: { id: actionBatch.id },
            data: { finalSummary: summary, status }
          });
          await tx.assistantTurn.create({
            data: {
              assistantSessionId: session.id,
              role: "USER",
              approvedTranscript: command.transcript,
              actionBatchId: actionBatch.id,
              expiresAt: session.expiresAt
            }
          });
          await tx.assistantSession.update({
            where: { id: session.id },
            data: {
              turnCount: { increment: 1 },
              context: jsonValue({ lastActionBatchId: actionBatch.id, outputs: Object.fromEntries(outputs) })
            }
          });
          const resolvedPendingActionId = typeof plan.extractedFacts.resolvesPendingActionId === "string"
            ? plan.extractedFacts.resolvesPendingActionId
            : undefined;
          if (resolvedPendingActionId) {
            const continued = await tx.aiPendingAction.findFirst({
              where: {
                id: resolvedPendingActionId,
                businessId,
                assistantSessionId: session.id,
                status: "PENDING",
                actionBatchId: { not: actionBatch.id }
              }
            });
            if (continued) {
              await tx.aiPendingAction.update({
                where: { id: continued.id },
                data: {
                  status: "COMPLETED",
                  resolution: jsonValue({ continuedByActionBatchId: actionBatch.id, transcript: command.transcript }),
                  resolvedAt: new Date(),
                  resolvedByUserId: user.id
                }
              });
              if (continued.actionBatchStepId) {
                await tx.actionBatchStep.update({
                  where: { id: continued.actionBatchStepId },
                  data: { status: "COMPLETED", output: jsonValue({ continuedByActionBatchId: actionBatch.id }) }
                });
              }
              if (continued.actionBatchId) {
                await tx.actionBatch.update({
                  where: { id: continued.actionBatchId },
                  data: { status: "PARTIALLY_COMPLETED", finalSummary: "הפעולה הושלמה בהמשך השיחה." }
                });
              }
            }
          }
          const rejectedPendingActionId = typeof plan.extractedFacts.rejectsPendingActionId === "string"
            ? plan.extractedFacts.rejectsPendingActionId
            : undefined;
          if (rejectedPendingActionId) {
            const declined = await tx.aiPendingAction.findFirst({
              where: {
                id: rejectedPendingActionId,
                businessId,
                assistantSessionId: session.id,
                status: "PENDING",
                actionBatchId: { not: actionBatch.id }
              }
            });
            if (declined) {
              await tx.aiPendingAction.update({
                where: { id: declined.id },
                data: {
                  status: "REJECTED",
                  resolution: jsonValue({ declinedByActionBatchId: actionBatch.id, transcript: command.transcript }),
                  resolvedAt: new Date(),
                  resolvedByUserId: user.id
                }
              });
              if (declined.actionBatchStepId) {
                await tx.actionBatchStep.update({ where: { id: declined.actionBatchStepId }, data: { status: "REJECTED" } });
              }
              if (declined.actionBatchId) {
                await tx.actionBatch.update({
                  where: { id: declined.actionBatchId },
                  data: { status: "PARTIALLY_COMPLETED", finalSummary: "המשתמש בחר שלא ליצור את הלקוח." }
                });
              }
            }
          }
          return {
            actionBatch: updatedBatch,
            receipt: {
              approvedTranscript: command.transcript,
              textSummary: summary,
              spokenSummary: summary,
              steps: receiptSteps
            },
            voiceResult: {
              state: waiting ? "needs_input" : "done",
              title: waiting ? "צריך עוד פרט" : "בוצע",
              summary,
              transcript: command.transcript,
              items: receiptSteps.map((step) => ({
                id: String(step.pendingActionId ?? step.entityId ?? step.stepId),
                actionType: step.tool,
                kind: this.voiceItemKind(step.tool),
                status: step.status === "COMPLETED" ? "created" : "pending",
                title: this.voiceItemTitle(
                  step.tool,
                  step.status,
                  step.displayPayload ?? step.entity
                ),
                subtitle: step.question,
                payload: step.payload ?? step.displayPayload ?? step.entity ?? step.result ?? {},
                fields: [],
                missingFields: step.missingFields ?? [],
                entityId: step.entityId,
                aiPendingActionId: step.pendingActionId
              })),
              primaryAction: "סגור",
              secondaryActions: ["הקלט שוב"]
            }
          };
        });
        log("info", "v2 assistant command executed", {
          businessId,
          provider: planned.provider,
          planningRounds: 1,
          planningDurationMs,
          executionDurationMs: Date.now() - startedAt - planningDurationMs,
          status: execution.actionBatch.status,
          stepCount: execution.receipt.steps.length,
          durationMs: Date.now() - startedAt
        });
        return execution;
      }
    });
  }

  async listPending(headers: RequestHeaders, businessId: string, query: unknown) {
    await this.access.requireV2BusinessAccess(headers, businessId);
    const command = V2PendingActionsQuerySchema.parse(query);
    const pagination = paginationFromParsedQuery(command);
    const items = await this.prisma.aiPendingAction.findMany({
      where: {
        businessId,
        ...(command.status === "ALL" ? {} : { status: command.status }),
        ...(command.actionBatchId ? { actionBatchId: command.actionBatchId } : {}),
        ...(pagination.cursor ? { OR: [{ createdAt: { lt: pagination.cursor.createdAt } }, { createdAt: pagination.cursor.createdAt, id: { lt: pagination.cursor.id } }] } : {})
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: command.limit + 1
    });
    const page = paginatedResponse(items, command.limit);
    return { actions: page.items, pageInfo: page.pageInfo, totalCount: await this.prisma.aiPendingAction.count({ where: { businessId, status: "PENDING" } }) };
  }

  async updatePending(headers: RequestHeaders, businessId: string, pendingActionId: string, body: unknown) {
    const user = await this.access.requireV2BusinessAccess(headers, businessId);
    const command = V2UpdatePendingActionSchema.parse(body);
    return this.idempotency.execute({
      businessId,
      userId: user.id,
      scope: `v2.assistant.pending.update.${pendingActionId}`,
      key: requiredIdempotencyKey(headers),
      request: command,
      execute: async () => {
        const existing = await this.prisma.aiPendingAction.findFirst({ where: { id: pendingActionId, businessId, status: "PENDING" } });
        if (!existing) throw new NotFoundException("Pending action not found");
        const action = await this.prisma.aiPendingAction.update({ where: { id: existing.id }, data: { payload: command.payload ? jsonValue(command.payload) : undefined, question: command.question } });
        return { action };
      }
    });
  }

  async rejectPending(headers: RequestHeaders, businessId: string, pendingActionId: string) {
    const user = await this.access.requireV2BusinessAccess(headers, businessId);
    return this.idempotency.execute({
      businessId,
      userId: user.id,
      scope: `v2.assistant.pending.reject.${pendingActionId}`,
      key: requiredIdempotencyKey(headers),
      request: { pendingActionId },
      execute: async () => {
        const action = await this.prisma.aiPendingAction.findFirst({ where: { id: pendingActionId, businessId, status: "PENDING" } });
        if (!action) throw new NotFoundException("Pending action not found");
        const rejected = await this.prisma.aiPendingAction.update({ where: { id: action.id }, data: { status: "REJECTED", resolvedAt: new Date(), resolvedByUserId: user.id } });
        log("info", "v2 pending action resolved", { businessId, outcome: "REJECTED", ageMs: Date.now() - action.createdAt.getTime(), actionType: action.actionType });
        if (action.actionBatchStepId) await this.prisma.actionBatchStep.update({ where: { id: action.actionBatchStepId }, data: { status: "REJECTED" } });
        if (action.actionBatchId) await this.prisma.actionBatch.update({ where: { id: action.actionBatchId }, data: { status: "PARTIALLY_COMPLETED", finalSummary: "הפעולה הממתינה נדחתה." } });
        return { action: rejected };
      }
    });
  }

  async resolvePending(headers: RequestHeaders, businessId: string, pendingActionId: string, body: unknown) {
    const user = await this.access.requireV2BusinessAccess(headers, businessId);
    const command = V2ResolvePendingActionSchema.parse(body);
    return this.idempotency.execute({
      businessId,
      userId: user.id,
      scope: `v2.assistant.pending.resolve.${pendingActionId}`,
      key: requiredIdempotencyKey(headers),
      request: command,
      execute: async () => this.prisma.$transaction(async (tx) => {
        const pending = await tx.aiPendingAction.findFirst({ where: { id: pendingActionId, businessId, status: "PENDING" } });
        if (!pending?.actionBatchId || !pending.actionBatchStepId) throw new NotFoundException("Pending action not found");
        if (pending.requiresExplicitConfirmation && command.confirmed !== true) throw new ConflictException({ code: "CONFIRMATION_REQUIRED", message: "Explicit confirmation is required" });
        await this.revalidatePendingEntities(tx, pending.entityVersions);
        const batch = await tx.actionBatch.findFirst({ where: { id: pending.actionBatchId, businessId } });
        if (!batch?.proposedPlan) throw new NotFoundException("Assistant plan not found");
        const plan = AssistantPlanSchema.parse(batch.proposedPlan);
        const allSteps = await tx.actionBatchStep.findMany({ where: { actionBatchId: batch.id } });
        const outputs = new Map<string, Record<string, unknown>>();
        for (const step of allSteps) {
          if (step.status === "COMPLETED" && step.output) outputs.set(step.stepKey, step.output as Record<string, unknown>);
        }
        const currentStep = allSteps.find((step) => step.id === pending.actionBatchStepId)!;
        let sequence = await tx.actionMutation.count({ where: { actionBatchId: batch.id } });
        const plannedCurrentStep = plan.steps.find((step) => step.stepId === currentStep.stepKey)!;
        let selectedOutput: Record<string, unknown> = { entityId: command.selectedEntityId, ...(command.payload ?? {}) };
        const createCustomerName = typeof command.payload?.createCustomerName === "string"
          ? command.payload.createCustomerName.trim()
          : "";
        if (plannedCurrentStep.tool === "FIND_CUSTOMERS" && createCustomerName) {
          const createCommand = V2CreateCustomerSchema.parse({ name: createCustomerName });
          const customer = await tx.customer.create({
            data: {
              businessId,
              name: createCommand.name,
              normalizedName: normalizeCustomerName(createCommand.name)
            }
          });
          selectedOutput = {
            entityType: "customer",
            entityId: customer.id,
            customerId: customer.id,
            entity: customer,
            message: `נוצר הלקוח ${customer.name}.`
          };
          sequence += 1;
          await tx.actionMutation.create({
            data: {
              actionBatchId: batch.id,
              actionBatchStepId: currentStep.id,
              sequence,
              entityType: "customer",
              entityId: customer.id,
              operation: "CREATE",
              after: jsonValue(customer)
            }
          });
        }
        if (plannedCurrentStep.kind === "WRITE") {
          const storedPendingPayload = objectValue(pending.payload);
          const confirmationOverrides = objectValue(storedPendingPayload.confirmationOverrides);
          const confirmedStep = {
            ...plannedCurrentStep,
            requiresExplicitConfirmation: false,
            input: { ...plannedCurrentStep.input, ...objectValue(storedPendingPayload.input), ...confirmationOverrides, ...(command.payload ?? {}), ...(command.selectedEntityId ? { entityId: command.selectedEntityId } : {}) }
          };
          if (storedPendingPayload.confirmationRequiredAfterInput === true && !pending.requiresExplicitConfirmation) {
            const financialProblem = await this.financialConfirmationProblem(tx, businessId, confirmedStep);
            if (financialProblem) {
              await tx.aiPendingAction.update({
                where: { id: pending.id },
                data: {
                  payload: jsonValue({ ...storedPendingPayload, input: confirmedStep.input }),
                  question: financialProblem.question,
                  missingFields: financialProblem.missingFields
                }
              });
              return { actionBatchId: batch.id, summary: financialProblem.question, remaining: 1, needsReview: true };
            }
            const question = this.confirmationQuestion(confirmedStep);
            await tx.aiPendingAction.update({
              where: { id: pending.id },
              data: {
                payload: jsonValue({ ...storedPendingPayload, input: confirmedStep.input, confirmationRequiredAfterInput: false }),
                question,
                missingFields: [],
                requiresExplicitConfirmation: true
              }
            });
            return { actionBatchId: batch.id, summary: question, remaining: 1, needsReview: true };
          }
          const executed = await this.executeBasicWrite(tx, { businessId, userId: user.id, key: requiredIdempotencyKey(headers), headers, step: confirmedStep, outputs, emptyReadIsResult: false });
          if (executed.waiting) {
            const refreshed = objectValue(executed);
            await tx.aiPendingAction.update({
              where: { id: pending.id },
              data: {
                payload: jsonValue({ tool: plannedCurrentStep.tool, input: confirmedStep.input, confirmationOverrides: refreshed.confirmationOverrides }),
                question: executed.question,
                missingFields: Array.isArray(refreshed.missingFields) ? refreshed.missingFields as string[] : [],
                candidateEntities: refreshed.candidates ? jsonValue(refreshed.candidates) : Prisma.JsonNull,
                entityVersions: refreshed.entityVersions ? jsonValue(refreshed.entityVersions) : Prisma.JsonNull,
                requiresExplicitConfirmation: refreshed.requiresExplicitConfirmation === true
              }
            });
            log("info", "v2 pending action refreshed", { businessId, actionType: pending.actionType, reason: "STILL_MISSING_INPUT" });
            return { actionBatchId: batch.id, summary: executed.question, remaining: 1, needsReview: true };
          }
          selectedOutput = executed;
          if (executed.entityType && executed.entityId && executed.entity) {
            sequence += 1;
            await tx.actionMutation.create({ data: { actionBatchId: batch.id, actionBatchStepId: currentStep.id, sequence, entityType: executed.entityType, entityId: executed.entityId, operation: executed.operation ?? "CREATE", before: executed.before ? jsonValue(executed.before) : undefined, after: jsonValue(executed.entity) } });
          }
        }
        await tx.actionBatchStep.update({ where: { id: currentStep.id }, data: { status: "COMPLETED", output: jsonValue(selectedOutput) } });
        outputs.set(currentStep.stepKey, selectedOutput);
        await tx.aiPendingAction.update({ where: { id: pending.id }, data: { status: "COMPLETED", resolution: jsonValue(command), resolvedAt: new Date(), resolvedByUserId: user.id } });
        log("info", "v2 pending action resolved", { businessId, outcome: "COMPLETED", ageMs: Date.now() - pending.createdAt.getTime(), actionType: pending.actionType });
        for (const step of orderedSteps(plan.steps)) {
          const stored = allSteps.find((item) => item.stepKey === step.stepId);
          if (!stored || stored.status !== "BLOCKED" || !step.dependsOn.every((dependency) => outputs.has(dependency))) continue;
          const output = await this.executeBasicWrite(tx, { businessId, userId: user.id, key: requiredIdempotencyKey(headers), headers, step, outputs, emptyReadIsResult: false });
          if (output.waiting) continue;
          await tx.actionBatchStep.update({ where: { id: stored.id }, data: { status: "COMPLETED", output: jsonValue(output) } });
          outputs.set(step.stepId, output);
          if (output.entityType && output.entityId && output.entity) {
            sequence += 1;
            await tx.actionMutation.create({ data: { actionBatchId: batch.id, actionBatchStepId: stored.id, sequence, entityType: output.entityType, entityId: output.entityId, operation: output.operation ?? "CREATE", before: output.before ? jsonValue(output.before) : undefined, after: jsonValue(output.entity) } });
          }
        }
        const remaining = await tx.actionBatchStep.count({ where: { actionBatchId: batch.id, status: { in: ["WAITING", "BLOCKED"] } } });
        const summary = remaining === 0 ? "השלמתי את הפעולה הממתינה." : "שמרתי את התשובה, אך עדיין חסר מידע לפעולה נוספת.";
        await tx.actionBatch.update({ where: { id: batch.id }, data: { status: remaining === 0 ? "COMPLETED" : "PARTIALLY_COMPLETED", finalSummary: summary } });
        return { actionBatchId: batch.id, summary, remaining };
      })
    });
  }

  private async revalidatePendingEntities(tx: Prisma.TransactionClient, entityVersions: Prisma.JsonValue | null) {
    if (!entityVersions || typeof entityVersions !== "object" || Array.isArray(entityVersions)) return;
    for (const [id, expected] of Object.entries(entityVersions)) {
      const [customer, task, job, visit] = await Promise.all([
        tx.customer.findUnique({ where: { id }, select: { version: true } }),
        tx.task.findUnique({ where: { id }, select: { version: true } }),
        tx.job.findUnique({ where: { id }, select: { version: true } }),
        tx.visit.findUnique({ where: { id }, select: { version: true } })
      ]);
      const actual = customer?.version ?? task?.version ?? job?.version ?? visit?.version;
      if (actual !== expected) throw new ConflictException({ code: "PENDING_ACTION_STALE", message: "The selected entity changed; review the action again" });
    }
  }

  private confirmationQuestion(step: AssistantPlanStep) {
    if (step.tool.startsWith("CANCEL_")) return "הפעולה תבטל את הפריט אך תשמור את ההיסטוריה שלו. לאשר ביטול?";
    if (step.tool.startsWith("DELETE_")) return "הפעולה תמחק את הפריט מהמערכת. לאשר מחיקה?";
    if (step.tool === "UNDO_ACTION_BATCH") return "הפעולה תשחזר שינויים מהפעולה האחרונה. לאשר Undo?";
    if (step.tool === "MERGE_CUSTOMERS") return "הפעולה תמזג בין שני לקוחות ותעביר את המידע ללקוח אחד. לאשר מיזוג?";
    if (["SET_ACTIVITY_AMOUNT", "ADD_PAYMENT", "SET_PAID_TOTAL", "SETTLE_BALANCE"].includes(step.tool)) {
      const amount = typeof step.input.amount === "number"
        ? ` של ${step.input.amount} ₪`
        : typeof step.input.totalAmount === "number" ? ` ל-${step.input.totalAmount} ₪` : "";
      return `הפעולה תעדכן מידע כספי${amount}. לאשר?`;
    }
    return "הפעולה דורשת אישור מפורש. לבצע?";
  }

  private async financialConfirmationProblem(
    tx: Prisma.TransactionClient,
    businessId: string,
    step: AssistantPlanStep
  ): Promise<{ question: string; missingFields: string[] } | undefined> {
    if (!["SET_ACTIVITY_AMOUNT", "ADD_PAYMENT", "SET_PAID_TOTAL", "SETTLE_BALANCE"].includes(step.tool)) return undefined;
    const entityId = typeof step.input.entityId === "string" ? step.input.entityId : undefined;
    if (!entityId) return { question: "לאיזו פעילות לעדכן את הסכום?", missingFields: ["entityId"] };
    const existing = await tx.amount.findFirst({
      where: { businessId, deletedAt: null, OR: [{ jobId: entityId }, { visitId: entityId }] }
    });
    if (step.tool !== "SET_ACTIVITY_AMOUNT" && !existing) {
      return { question: "צריך להגדיר סכום כולל לפני עדכון תשלום.", missingFields: ["totalAmount"] };
    }
    const previousTotal = money(Number(existing?.totalAmount ?? 0));
    const previousPaid = money(Number(existing?.paidAmount ?? 0));
    const nextTotal = step.tool === "SET_ACTIVITY_AMOUNT"
      ? money(Number(step.input.totalAmount))
      : previousTotal;
    const mode = step.tool === "ADD_PAYMENT" ? "ADD" : step.tool === "SET_PAID_TOTAL" ? "SET_PAID_TOTAL" : "SETTLE_BALANCE";
    const nextPaid = step.tool === "SET_ACTIVITY_AMOUNT"
      ? (typeof step.input.paidAmount === "number" ? money(step.input.paidAmount) : previousPaid)
      : nextPaidAmount(mode, previousPaid, nextTotal, typeof step.input.amount === "number" ? step.input.amount : undefined);
    try {
      assertAmountInvariant(nextTotal, nextPaid);
    } catch {
      const balance = Number(previousTotal.minus(previousPaid));
      return {
        question: `הסכום גבוה מהיתרה של ${balance} ₪. מה הסכום הנכון?`,
        missingFields: ["amount"]
      };
    }
    return undefined;
  }

  private async executeBasicWrite(
    tx: Prisma.TransactionClient,
    input: {
      businessId: string;
      userId: string;
      key: string;
      headers: RequestHeaders;
      step: AssistantPlanStep;
      outputs: Map<string, Record<string, unknown>>;
      emptyReadIsResult: boolean;
    }
  ) {
    if (input.step.tool === "FIND_CUSTOMERS") {
      const query = typeof input.step.input.query === "string"
        ? input.step.input.query
        : typeof input.step.input.name === "string" ? input.step.input.name : "";
      const normalizedName = normalizeCustomerName(query);
      const candidates = await tx.customer.findMany({
        where: {
          businessId: input.businessId,
          deletedAt: null,
          mergedIntoCustomerId: null,
          OR: [
            { normalizedName },
            { email: { equals: query, mode: "insensitive" } },
            { customerPhones: { some: { rawPhone: query, deletedAt: null } } }
          ]
        },
        select: { id: true, name: true, email: true, version: true },
        take: 10
      });
      if (input.emptyReadIsResult) {
        return {
          result: { customers: candidates },
          message: candidates.length === 0 ? "לא מצאתי לקוחות מתאימים." : `מצאתי ${candidates.length} לקוחות מתאימים.`
        };
      }
      if (candidates.length !== 1) {
        return {
          waiting: true as const,
          question: candidates.length === 0
            ? `לא מצאתי לקוח בשם ${query}. האם תרצה שאצור אותו?`
            : "מצאתי כמה לקוחות מתאימים. במי לבחור?",
          candidates: candidates.length === 0
            ? [{
                id: "create-customer",
                title: `יצירת לקוח בשם ${query}`,
                payload: { createCustomerName: query }
              }]
            : candidates,
          entityVersions: Object.fromEntries(candidates.map((customer) => [customer.id, customer.version])),
          missingFields: [],
          createCustomerName: candidates.length === 0 ? query : undefined
        };
      }
      return { result: { customers: candidates }, entityId: candidates[0]!.id, customerId: candidates[0]!.id, entityVersion: candidates[0]!.version, message: `מצאתי את ${candidates[0]!.name}.` };
    }
    if (["FIND_TASKS", "FIND_JOBS", "FIND_VISITS"].includes(input.step.tool)) {
      const customerId = typeof input.step.input.customerId === "string"
        ? input.step.input.customerId
        : this.resolveCustomerReference(input.step.input.customerRef, input.outputs);
      const title = typeof input.step.input.title === "string" ? input.step.input.title : undefined;
      const commonWhere = { businessId: input.businessId, deletedAt: null, ...(customerId ? { customerId } : {}), ...(title ? { title: { contains: title, mode: "insensitive" as const } } : {}) };
      const candidates = input.step.tool === "FIND_TASKS"
        ? await tx.task.findMany({ where: commonWhere, take: 10 })
        : input.step.tool === "FIND_JOBS"
          ? await tx.job.findMany({ where: commonWhere, take: 10 })
          : await tx.visit.findMany({ where: commonWhere, take: 10 });
      if (input.emptyReadIsResult) {
        const noun = input.step.tool === "FIND_TASKS" ? "משימות" : input.step.tool === "FIND_JOBS" ? "עבודות" : "ביקורים";
        return {
          result: { items: candidates },
          message: candidates.length === 0 ? `לא מצאתי ${noun} מתאימים.` : `מצאתי ${candidates.length} ${noun} מתאימים.`
        };
      }
      if (candidates.length !== 1) {
        return {
          waiting: true as const,
          question: candidates.length === 0 ? "לא מצאתי פעילות יחידה שמתאימה לבקשה." : "מצאתי כמה פעילויות מתאימות. באיזו לבחור?",
          candidates: candidates.map((item) => ({ id: item.id, title: item.title, status: item.status })),
          entityVersions: Object.fromEntries(candidates.map((item) => [item.id, item.version])),
          missingFields: candidates.length === 0 ? ["entityId"] : []
        };
      }
      return { result: { items: candidates }, entityId: candidates[0]!.id, entityVersion: candidates[0]!.version, message: `מצאתי את ${candidates[0]!.title}.` };
    }
    if (input.step.tool === "GET_AVAILABILITY") {
      const result = await this.activities.availability(input.headers, input.businessId, input.step.input);
      const slots = result.freeSlots.slice(0, 3);
      const times = slots.map((slot) => new Intl.DateTimeFormat("he-IL", {
        timeZone: result.timezone,
        hour: "2-digit",
        minute: "2-digit"
      }).format(slot.startsAt));
      return {
        result,
        message: times.length > 0
          ? `החלונות הפנויים הראשונים הם ${times.join(", ")}.`
          : "לא מצאתי חלון פנוי ביום המבוקש."
      };
    }
    if (input.step.tool === "GET_SCHEDULE") {
      const result = await this.activities.schedule(input.headers, input.businessId, input.step.input);
      const limit = typeof input.step.input.limit === "number" ? input.step.input.limit : result.items.length;
      const items = result.items.slice(0, limit);
      return {
        result: { items },
        message: items.length > 0
          ? `הפעילות הבאה היא ${items[0]!.title}.`
          : "לא מצאתי פעילות מתוזמנת בטווח המבוקש."
      };
    }
    if (input.step.tool === "GET_CUSTOMER_TIMELINE") {
      const customerId = this.resolveEntityId(input.step.input.customerId, input.step.input.customerRef, input.outputs);
      if (!customerId) return { waiting: true as const, question: "על איזה לקוח להציג פעילות?", missingFields: ["customerId"] };
      const [tasks, jobs, visits, notes] = await Promise.all([
        tx.task.findMany({ where: { businessId: input.businessId, customerId, deletedAt: null }, orderBy: { updatedAt: "desc" }, take: 10 }),
        tx.job.findMany({ where: { businessId: input.businessId, customerId, deletedAt: null }, orderBy: { updatedAt: "desc" }, take: 10 }),
        tx.visit.findMany({ where: { businessId: input.businessId, customerId, deletedAt: null }, orderBy: { updatedAt: "desc" }, take: 10 }),
        tx.note.findMany({ where: { businessId: input.businessId, customerId, deletedAt: null }, orderBy: { updatedAt: "desc" }, take: 10 })
      ]);
      const count = tasks.length + jobs.length + visits.length + notes.length;
      return { result: { tasks, jobs, visits, notes }, message: count === 0 ? "לא מצאתי פעילות קודמת ללקוח." : `מצאתי ${count} פריטים בציר הזמן של הלקוח.` };
    }
    if (input.step.tool === "GET_ACTIVITY_AMOUNT") {
      const entityId = this.resolveEntityId(input.step.input.entityId, input.step.input.entityRef, input.outputs);
      const amount = entityId ? await tx.amount.findFirst({ where: { businessId: input.businessId, deletedAt: null, OR: [{ jobId: entityId }, { visitId: entityId }] } }) : null;
      if (!amount) return { result: { amount: null }, message: "לא מוגדר סכום לפעילות." };
      return { result: { amount }, entityId: amount.id, message: `הסכום הוא ${amount.totalAmount.toString()} שקלים, ומתוכם שולמו ${amount.paidAmount.toString()} שקלים.` };
    }
    if (input.step.tool === "GET_PAYMENT_SUMMARY") {
      const from = typeof input.step.input.from === "string" ? new Date(input.step.input.from) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const to = typeof input.step.input.to === "string" ? new Date(input.step.input.to) : new Date();
      const events = await tx.amountEvent.findMany({ where: { businessId: input.businessId, occurredAt: { gte: from, lt: to }, amount: { OR: [{ job: { status: { not: "CANCELLED" }, deletedAt: null } }, { visit: { status: { not: "CANCELLED" }, deletedAt: null } }] } } });
      const total = events.reduce((sum, event) => sum.plus(event.paidDelta), money(0));
      return { result: { totalPaid: total, eventCount: events.length }, message: `בתקופה המבוקשת התקבלו ${total.toString()} שקלים.` };
    }
    if (input.step.tool === "GET_OPEN_BALANCES") {
      const amounts = await tx.amount.findMany({ where: { businessId: input.businessId, deletedAt: null, paymentStatus: { not: "PAID" }, OR: [{ job: { status: { not: "CANCELLED" }, deletedAt: null } }, { visit: { status: { not: "CANCELLED" }, deletedAt: null } }] } });
      const balance = amounts.reduce((sum, amount) => sum.plus(amount.totalAmount.minus(amount.paidAmount)), money(0));
      return { result: { totalBalance: balance, count: amounts.length }, message: `היתרה הפתוחה היא ${balance.toString()} שקלים ב-${amounts.length} פעילויות.` };
    }
    if (input.step.tool === "GET_TODAY_OVERVIEW") {
      const businessSettings = await this.settings.getByBusiness(input.businessId);
      const timezone = businessSettings.timezone;
      const date = typeof input.step.input.date === "string" ? input.step.input.date : localDate(new Date(), timezone);
      const startsAt = localDateTimeToUtc(date, "00:00", timezone);
      const endsAt = localDateTimeToUtc(this.nextDate(date), "00:00", timezone);
      const [tasks, jobs, visits] = await Promise.all([
        tx.task.findMany({ where: { businessId: input.businessId, status: "OPEN", deletedAt: null, dueAt: { lt: endsAt } }, orderBy: { dueAt: "asc" }, take: 50 }),
        tx.job.findMany({ where: { businessId: input.businessId, status: "OPEN", deletedAt: null, startsAt: { gte: startsAt, lt: endsAt } }, orderBy: { startsAt: "asc" }, take: 50 }),
        tx.visit.findMany({ where: { businessId: input.businessId, status: "OPEN", deletedAt: null, startsAt: { gte: startsAt, lt: endsAt } }, orderBy: { startsAt: "asc" }, take: 50 })
      ]);
      const total = tasks.length + jobs.length + visits.length;
      if (total === 0) {
        return { result: { date, tasks, jobs, visits }, message: "אין לך משימות, עבודות או ביקורים פתוחים להיום." };
      }
      const parts = [
        tasks.length > 0 ? `${tasks.length} משימות` : null,
        jobs.length > 0 ? `${jobs.length} עבודות` : null,
        visits.length > 0 ? `${visits.length} ביקורים` : null
      ].filter((value): value is string => Boolean(value));
      return { result: { date, tasks, jobs, visits }, message: `פתוחים להיום: ${parts.join(", ")}.` };
    }
    if (input.step.tool === "RESPOND") {
      return { result: input.step.input, message: typeof input.step.input.text === "string" ? input.step.input.text : "הבקשה נבדקה." };
    }
    if (input.step.tool === "CREATE_CUSTOMER") {
      const command = V2CreateCustomerSchema.parse(input.step.input);
      const customer = await tx.customer.create({
        data: {
          businessId: input.businessId,
          name: command.name,
          normalizedName: normalizeCustomerName(command.name),
          email: command.email,
          generalNotes: command.generalNotes
        }
      });
      return { entityType: "customer", entityId: customer.id, entity: customer, message: `נוצר הלקוח ${customer.name}. אפשר להוסיף לו טלפון או כתובת בהודעה הבאה.` };
    }
    if (input.step.tool === "CREATE_TASK") {
      const command = V2CreateTaskSchema.parse(input.step.input);
      const customerId = command.customerId ?? this.resolveCustomerReference(input.step.input.customerRef, input.outputs);
      if (customerId && !await tx.customer.findFirst({
        where: { id: customerId, businessId: input.businessId, deletedAt: null, mergedIntoCustomerId: null },
        select: { id: true }
      })) {
        return { waiting: true as const, question: "הלקוח שנבחר אינו זמין עוד.", missingFields: ["customerId"] };
      }
      const task = await tx.task.create({
        data: {
          businessId: input.businessId,
          customerId,
          title: command.title,
          description: command.description,
          dueAt: parseOptionalDate(command.dueAt) ?? undefined,
          status: command.status,
          source: "assistant_v2",
          sourceRef: input.step.stepId,
          idempotencyKey: `${input.key}:${input.step.stepId}`
        }
      });
      const businessSettings = await this.settings.getByBusiness(input.businessId);
      const dueText = task.dueAt
        ? ` ל-${new Intl.DateTimeFormat("he-IL", { timeZone: businessSettings.timezone, dateStyle: "short", timeStyle: "short" }).format(task.dueAt)}`
        : "";
      const customer = task.customerId ? await tx.customer.findFirst({ where: { id: task.customerId, businessId: input.businessId, deletedAt: null } }) : null;
      return { entityType: "task", entityId: task.id, entity: task, displayPayload: { ...task, customerName: customer?.name }, message: `נפתחה המשימה "${task.title}"${dueText}.` };
    }
    if (input.step.tool === "UPDATE_TASK") {
      const taskId = this.resolveEntityId(input.step.input.taskId, input.step.input.entityRef, input.outputs);
      const existing = taskId ? await tx.task.findFirst({ where: { id: taskId, businessId: input.businessId, deletedAt: null } }) : null;
      if (!existing) return { waiting: true as const, question: "לא מצאתי את המשימה לעדכון.", missingFields: ["taskId"] };
      const hasCustomerId = Object.prototype.hasOwnProperty.call(input.step.input, "customerId");
      const nextCustomerId = hasCustomerId && (typeof input.step.input.customerId === "string" || input.step.input.customerId === null)
        ? input.step.input.customerId
        : undefined;
      if (typeof nextCustomerId === "string" && !await tx.customer.findFirst({
        where: { id: nextCustomerId, businessId: input.businessId, deletedAt: null, mergedIntoCustomerId: null },
        select: { id: true }
      })) {
        return { waiting: true as const, question: "הלקוח שנבחר אינו זמין עוד.", missingFields: ["customerId"] };
      }
      const entity = await tx.task.update({ where: { id: existing.id }, data: { customerId: nextCustomerId, title: typeof input.step.input.title === "string" ? input.step.input.title : undefined, description: typeof input.step.input.description === "string" ? input.step.input.description : undefined, dueAt: typeof input.step.input.dueAt === "string" ? new Date(input.step.input.dueAt) : undefined, version: { increment: 1 } } });
      const customer = entity.customerId ? await tx.customer.findFirst({ where: { id: entity.customerId, businessId: input.businessId, deletedAt: null } }) : null;
      return { entityType: "task", entityId: entity.id, entity, displayPayload: { ...entity, customerName: customer?.name }, before: existing, operation: "UPDATE", message: `המשימה "${entity.title}" עודכנה.` };
    }
    if (input.step.tool === "CREATE_NOTE") {
      const customerId = this.resolveEntityId(input.step.input.customerId, input.step.input.customerRef, input.outputs);
      const command = V2CreateNoteSchema.parse({ text: input.step.input.text, status: input.step.input.status });
      const customer = customerId ? await tx.customer.findFirst({ where: { id: customerId, businessId: input.businessId, deletedAt: null, mergedIntoCustomerId: null } }) : null;
      if (!customer) return { waiting: true as const, question: "צריך לבחור לקוח עבור ההערה.", missingFields: ["customerId"] };
      const entity = await tx.note.create({ data: { businessId: input.businessId, customerId: customer.id, text: command.text, status: command.status } });
      return { entityType: "note", entityId: entity.id, entity, displayPayload: { ...entity, customerId: customer.id, customerName: customer.name }, message: `נוספה הערה ללקוח ${customer.name}.` };
    }
    if (input.step.tool === "UPDATE_NOTE") {
      const noteId = this.resolveEntityId(input.step.input.noteId, input.step.input.entityRef, input.outputs);
      const existing = noteId ? await tx.note.findFirst({ where: { id: noteId, businessId: input.businessId, deletedAt: null } }) : null;
      if (!existing) return { waiting: true as const, question: "לא מצאתי את ההערה לעדכון.", missingFields: ["noteId"] };
      const command = V2UpdateNoteSchema.parse({ text: input.step.input.text, status: input.step.input.status });
      const entity = await tx.note.update({ where: { id: existing.id }, data: command });
      const customer = await tx.customer.findFirst({ where: { id: entity.customerId, businessId: input.businessId, deletedAt: null } });
      return { entityType: "note", entityId: entity.id, entity, displayPayload: { ...entity, customerId: entity.customerId, customerName: customer?.name }, before: existing, operation: "UPDATE" };
    }
    if (input.step.tool === "UPDATE_CUSTOMER") {
      const customerId = this.resolveEntityId(input.step.input.customerId, input.step.input.customerRef, input.outputs);
      const existing = await tx.customer.findFirst({ where: { id: customerId, businessId: input.businessId, deletedAt: null, mergedIntoCustomerId: null } });
      if (!existing) return { waiting: true as const, question: "לא מצאתי את הלקוח לעדכון.", missingFields: ["customerId"] };
      const name = typeof input.step.input.name === "string" ? input.step.input.name.trim() : undefined;
      const entity = await tx.customer.update({
        where: { id: existing.id },
        data: {
          name,
          normalizedName: name ? normalizeCustomerName(name) : undefined,
          email: typeof input.step.input.email === "string" ? input.step.input.email : undefined,
          generalNotes: typeof input.step.input.generalNotes === "string" ? input.step.input.generalNotes : undefined,
          version: { increment: 1 }
        }
      });
      return { entityType: "customer", entityId: entity.id, entity, before: existing, operation: "UPDATE", message: `פרטי הלקוח ${entity.name} עודכנו.` };
    }
    if (input.step.tool === "ADD_CUSTOMER_PHONE") {
      const customerId = this.resolveEntityId(input.step.input.customerId, input.step.input.customerRef, input.outputs);
      const phone = typeof input.step.input.phone === "string" ? input.step.input.phone.trim() : "";
      if (!customerId || !phone) return { waiting: true as const, question: "צריך לקוח ומספר טלפון.", missingFields: [!customerId ? "customerId" : "phone"] };
      const customer = await tx.customer.findFirst({
        where: {
          id: customerId,
          businessId: input.businessId,
          deletedAt: null,
          mergedIntoCustomerId: null
        }
      });
      if (!customer) return { waiting: true as const, question: "לא מצאתי את הלקוח להוספת הטלפון.", missingFields: ["customerId"] };
      const normalizedPhone = normalizeIsraeliPhone(phone);
      if (!normalizedPhone) return { waiting: true as const, question: "מספר הטלפון אינו תקין.", missingFields: ["phone"] };
      const duplicate = await tx.customerPhone.findFirst({
        where: { businessId: input.businessId, normalizedPhone, deletedAt: null },
        include: { customer: { select: { name: true } } }
      });
      if (duplicate) return { waiting: true as const, question: `מספר הטלפון כבר משויך ללקוח ${duplicate.customer.name}.`, missingFields: ["phone"] };
      const activeCount = await tx.customerPhone.count({ where: { businessId: input.businessId, customerId, deletedAt: null } });
      const entity = await tx.customerPhone.create({ data: { businessId: input.businessId, customerId, rawPhone: phone, normalizedPhone, label: typeof input.step.input.label === "string" ? input.step.input.label : undefined, isPrimary: activeCount === 0 } });
      return {
        entityType: "customer_phone",
        entityId: entity.id,
        entity,
        displayPayload: { customerId, customerName: customer.name, phone: entity.rawPhone },
        message: `נוסף הטלפון ${entity.rawPhone} ללקוח ${customer.name}.`
      };
    }
    if (input.step.tool === "UPDATE_CUSTOMER_PHONE" || input.step.tool === "DELETE_CUSTOMER_PHONE") {
      const phoneId = this.resolveEntityId(input.step.input.phoneId, input.step.input.entityRef, input.outputs);
      const existing = phoneId ? await tx.customerPhone.findFirst({ where: { id: phoneId, businessId: input.businessId, deletedAt: null } }) : null;
      if (!existing) return { waiting: true as const, question: "לא מצאתי את מספר הטלפון לעדכון.", missingFields: ["phoneId"] };
      const deleting = input.step.tool === "DELETE_CUSTOMER_PHONE";
      const rawPhone = typeof input.step.input.phone === "string" ? input.step.input.phone.trim() : undefined;
      const normalizedPhone = rawPhone ? normalizeIsraeliPhone(rawPhone) : undefined;
      if (rawPhone && !normalizedPhone) return { waiting: true as const, question: "מספר הטלפון אינו תקין.", missingFields: ["phone"] };
      if (normalizedPhone) {
        const duplicate = await tx.customerPhone.findFirst({
          where: { businessId: input.businessId, normalizedPhone, deletedAt: null, id: { not: existing.id } },
          include: { customer: { select: { name: true } } }
        });
        if (duplicate) return { waiting: true as const, question: `מספר הטלפון כבר משויך ללקוח ${duplicate.customer.name}.`, missingFields: ["phone"] };
      }
      const makePrimary = !deleting && input.step.input.isPrimary === true;
      if (makePrimary) {
        await tx.customerPhone.updateMany({
          where: { businessId: input.businessId, customerId: existing.customerId, deletedAt: null },
          data: { isPrimary: false }
        });
      }
      const entity = await tx.customerPhone.update({ where: { id: existing.id }, data: deleting ? { deletedAt: new Date(), deletedByUserId: input.userId, isPrimary: false } : { rawPhone, normalizedPhone: normalizedPhone ?? undefined, label: typeof input.step.input.label === "string" ? input.step.input.label : undefined, isPrimary: typeof input.step.input.isPrimary === "boolean" ? input.step.input.isPrimary : undefined } });
      if (deleting && existing.isPrimary) {
        const replacement = await tx.customerPhone.findFirst({
          where: { businessId: input.businessId, customerId: existing.customerId, deletedAt: null },
          orderBy: { createdAt: "asc" }
        });
        if (replacement) await tx.customerPhone.update({ where: { id: replacement.id }, data: { isPrimary: true } });
      }
      return { entityType: "customer_phone", entityId: entity.id, entity, before: existing, operation: deleting ? "DELETE" : "UPDATE" };
    }
    if (input.step.tool === "ADD_SERVICE_ADDRESS") {
      const customerId = this.resolveEntityId(input.step.input.customerId, input.step.input.customerRef, input.outputs);
      const addressText = typeof input.step.input.addressText === "string" ? input.step.input.addressText.trim() : "";
      if (!customerId || !addressText) return { waiting: true as const, question: "צריך לקוח וכתובת שירות.", missingFields: [!customerId ? "customerId" : "addressText"] };
      const customer = await tx.customer.findFirst({
        where: { id: customerId, businessId: input.businessId, deletedAt: null, mergedIntoCustomerId: null },
        select: { id: true }
      });
      if (!customer) return { waiting: true as const, question: "הלקוח שנבחר אינו זמין עוד.", missingFields: ["customerId"] };
      const entity = await tx.serviceAddress.create({ data: { businessId: input.businessId, customerId, addressText, normalizedAddress: normalizeServiceAddress(addressText), label: typeof input.step.input.label === "string" ? input.step.input.label : undefined } });
      return { entityType: "service_address", entityId: entity.id, entity };
    }
    if (input.step.tool === "UPDATE_SERVICE_ADDRESS" || input.step.tool === "DELETE_SERVICE_ADDRESS") {
      const addressId = this.resolveEntityId(input.step.input.addressId, input.step.input.entityRef, input.outputs);
      const existing = addressId ? await tx.serviceAddress.findFirst({ where: { id: addressId, businessId: input.businessId, deletedAt: null } }) : null;
      if (!existing) return { waiting: true as const, question: "לא מצאתי את כתובת השירות לעדכון.", missingFields: ["addressId"] };
      const deleting = input.step.tool === "DELETE_SERVICE_ADDRESS";
      const addressText = typeof input.step.input.addressText === "string" ? input.step.input.addressText.trim() : undefined;
      const entity = await tx.serviceAddress.update({ where: { id: existing.id }, data: deleting ? { deletedAt: new Date(), deletedByUserId: input.userId } : { addressText, normalizedAddress: addressText ? normalizeServiceAddress(addressText) : undefined, label: typeof input.step.input.label === "string" ? input.step.input.label : undefined } });
      return { entityType: "service_address", entityId: entity.id, entity, before: existing, operation: deleting ? "DELETE" : "UPDATE" };
    }
    if (input.step.tool === "RESTORE_CUSTOMER") {
      const customerId = this.resolveEntityId(input.step.input.customerId, input.step.input.customerRef, input.outputs);
      const existing = customerId ? await tx.customer.findFirst({ where: { id: customerId, businessId: input.businessId, deletedAt: { not: null } } }) : null;
      if (!existing) return { waiting: true as const, question: "לא מצאתי לקוח שניתן לשחזר.", missingFields: ["customerId"] };
      const restoreSnapshot = {
        customer: existing,
        phones: [] as unknown[],
        addresses: [] as unknown[],
        tasks: [] as unknown[],
        jobs: [] as unknown[],
        visits: [] as unknown[],
        amounts: [] as unknown[]
      };
      if (existing.deleteActionBatchId) {
        const where = { businessId: input.businessId, deleteActionBatchId: existing.deleteActionBatchId };
        [restoreSnapshot.phones, restoreSnapshot.addresses, restoreSnapshot.tasks, restoreSnapshot.jobs, restoreSnapshot.visits, restoreSnapshot.amounts] = await Promise.all([
          tx.customerPhone.findMany({ where }),
          tx.serviceAddress.findMany({ where }),
          tx.task.findMany({ where }),
          tx.job.findMany({ where }),
          tx.visit.findMany({ where }),
          tx.amount.findMany({ where })
        ]);
        await Promise.all([
          tx.customerPhone.updateMany({ where, data: { deletedAt: null, deletedByUserId: null, deleteActionBatchId: null } }),
          tx.serviceAddress.updateMany({ where, data: { deletedAt: null, deletedByUserId: null, deleteActionBatchId: null } }),
          tx.task.updateMany({ where, data: { deletedAt: null, deletedByUserId: null, deleteActionBatchId: null } }),
          tx.job.updateMany({ where, data: { deletedAt: null, deletedByUserId: null, deleteActionBatchId: null } }),
          tx.visit.updateMany({ where, data: { deletedAt: null, deletedByUserId: null, deleteActionBatchId: null } }),
          tx.amount.updateMany({ where, data: { deletedAt: null, deletedByUserId: null, deleteActionBatchId: null } })
        ]);
      }
      const entity = await tx.customer.update({ where: { id: existing.id }, data: { deletedAt: null, deletedByUserId: null, deleteActionBatchId: null, version: { increment: 1 } } });
      return { entityType: "customer", entityId: entity.id, entity, before: { restoreSnapshot }, operation: "RESTORE" };
    }
    if (input.step.tool === "MERGE_CUSTOMERS") {
      const sourceId = this.resolveEntityId(input.step.input.sourceCustomerId, input.step.input.sourceCustomerRef, input.outputs);
      const targetId = this.resolveEntityId(input.step.input.targetCustomerId, input.step.input.targetCustomerRef, input.outputs);
      if (!sourceId || !targetId || sourceId === targetId) return { waiting: true as const, question: "צריך לבחור לקוח מקור ולקוח יעד שונים.", missingFields: ["sourceCustomerId", "targetCustomerId"] };
      const [source, target] = await Promise.all([tx.customer.findFirst({ where: { id: sourceId, businessId: input.businessId, deletedAt: null, mergedIntoCustomerId: null } }), tx.customer.findFirst({ where: { id: targetId, businessId: input.businessId, deletedAt: null, mergedIntoCustomerId: null } })]);
      if (!source || !target) return { waiting: true as const, question: "אחד הלקוחות למיזוג לא נמצא.", missingFields: ["customers"] };
      const [sourcePhones, sourceAddresses, tasks, jobs, visits, notes] = await Promise.all([
        tx.customerPhone.findMany({ where: { businessId: input.businessId, customerId: source.id, deletedAt: null } }),
        tx.serviceAddress.findMany({ where: { businessId: input.businessId, customerId: source.id, deletedAt: null } }),
        tx.task.findMany({ where: { businessId: input.businessId, customerId: source.id }, select: { id: true, version: true } }),
        tx.job.findMany({ where: { businessId: input.businessId, customerId: source.id }, select: { id: true, version: true } }),
        tx.visit.findMany({ where: { businessId: input.businessId, customerId: source.id }, select: { id: true, version: true } }),
        tx.note.findMany({ where: { businessId: input.businessId, customerId: source.id }, select: { id: true } })
      ]);
      const phoneChanges: Array<{ before: unknown; after: unknown }> = [];
      for (const phone of sourcePhones) {
        const duplicate = await tx.customerPhone.findFirst({ where: { businessId: input.businessId, customerId: target.id, normalizedPhone: phone.normalizedPhone, deletedAt: null } });
        const after = await tx.customerPhone.update({ where: { id: phone.id }, data: duplicate ? { deletedAt: new Date(), deletedByUserId: input.userId, isPrimary: false } : { customerId: target.id, isPrimary: false } });
        phoneChanges.push({ before: phone, after });
      }
      const addressChanges: Array<{ before: unknown; after: unknown }> = [];
      for (const address of sourceAddresses) {
        const duplicate = address.normalizedAddress ? await tx.serviceAddress.findFirst({ where: { businessId: input.businessId, customerId: target.id, normalizedAddress: address.normalizedAddress, deletedAt: null } }) : null;
        const after = await tx.serviceAddress.update({ where: { id: address.id }, data: duplicate ? { deletedAt: new Date(), deletedByUserId: input.userId } : { customerId: target.id } });
        addressChanges.push({ before: address, after });
      }
      await Promise.all([
        tx.task.updateMany({ where: { businessId: input.businessId, customerId: source.id }, data: { customerId: target.id } }),
        tx.job.updateMany({ where: { businessId: input.businessId, customerId: source.id }, data: { customerId: target.id } }),
        tx.visit.updateMany({ where: { businessId: input.businessId, customerId: source.id }, data: { customerId: target.id } }),
        tx.note.updateMany({ where: { businessId: input.businessId, customerId: source.id }, data: { customerId: target.id } })
      ]);
      const updatedTarget = await tx.customer.update({ where: { id: target.id }, data: { version: { increment: 1 } } });
      const entity = await tx.customer.update({ where: { id: source.id }, data: { mergedIntoCustomerId: target.id, mergedAt: new Date(), mergedByUserId: input.userId, version: { increment: 1 } } });
      return {
        entityType: "customer",
        entityId: entity.id,
        entity,
        before: {
          mergeSnapshot: {
            source,
            target,
            targetAfterVersion: updatedTarget.version,
            phones: phoneChanges,
            addresses: addressChanges,
            tasks,
            jobs,
            visits,
            notes
          }
        },
        operation: "MERGE"
      };
    }
    if (["COMPLETE_TASK", "CANCEL_TASK", "REOPEN_TASK", "DELETE_TASK"].includes(input.step.tool)) {
      const taskId = this.resolveEntityId(input.step.input.taskId, input.step.input.entityRef, input.outputs);
      const existing = taskId ? await tx.task.findFirst({ where: { id: taskId, businessId: input.businessId, deletedAt: null } }) : null;
      if (!existing) return { waiting: true as const, question: "לא מצאתי את המשימה לעדכון.", missingFields: ["taskId"] };
      const data = input.step.tool === "DELETE_TASK" ? { deletedAt: new Date(), deletedByUserId: input.userId, version: { increment: 1 } }
        : {
            status: input.step.tool === "COMPLETE_TASK" ? "DONE" as const : input.step.tool === "CANCEL_TASK" ? "CANCELLED" as const : "OPEN" as const,
            completedAt: input.step.tool === "COMPLETE_TASK" ? new Date() : input.step.tool === "REOPEN_TASK" ? null : undefined,
            version: { increment: 1 }
          };
      const entity = await tx.task.update({ where: { id: existing.id }, data });
      const message = input.step.tool === "COMPLETE_TASK" ? `המשימה "${entity.title}" סומנה כהושלמה.` : undefined;
      return { entityType: "task", entityId: entity.id, entity, before: existing, operation: input.step.tool === "DELETE_TASK" ? "DELETE" : "UPDATE", message };
    }
    if (input.step.tool === "CREATE_JOB" || input.step.tool === "CREATE_VISIT") {
      const kind = input.step.tool === "CREATE_JOB" ? "job" as const : "visit" as const;
      const customerId = this.resolveEntityId(input.step.input.customerId, input.step.input.customerRef, input.outputs);
      const title = typeof input.step.input.title === "string" ? input.step.input.title.trim() : "";
      if (!customerId || !title) return { waiting: true as const, question: "צריך לקוח וכותרת לפעילות.", missingFields: [!customerId ? "customerId" : "title"] };
      const startsAt = typeof input.step.input.startsAt === "string" ? new Date(input.step.input.startsAt) : undefined;
      const explicitEndsAt = typeof input.step.input.endsAt === "string" ? new Date(input.step.input.endsAt) : undefined;
      const endsAt = startsAt ? effectiveScheduleEnd(kind, startsAt, explicitEndsAt) : explicitEndsAt;
      if ((startsAt && Number.isNaN(startsAt.getTime())) || (endsAt && Number.isNaN(endsAt.getTime())) || (startsAt && endsAt && endsAt <= startsAt)) return { waiting: true as const, question: "המועד אינו תקין. צריך שעת התחלה ושעת סיום מאוחרת ממנה.", missingFields: ["schedule"] };
      const result = await this.activityRepository.createInTransaction(tx, {
        kind,
        businessId: input.businessId,
        customerId,
        title,
        description: typeof input.step.input.description === "string" ? input.step.input.description : undefined,
        startsAt,
        endsAt,
        serviceAddressId: typeof input.step.input.serviceAddressId === "string" ? input.step.input.serviceAddressId : undefined,
        locationSnapshot: typeof input.step.input.locationSnapshot === "string" ? input.step.input.locationSnapshot : undefined,
        idempotencyKey: `${input.key}:${input.step.stepId}`,
        allowScheduleConflict: false,
        approvedConflictFingerprint: startsAt ? this.assistantApprovedConflictFingerprint(input.step.input.scheduleConflictToken, { businessId: input.businessId, userId: input.userId, operation: "CREATE", kind, entityId: null, startsAt, endsAt }) : undefined
      });
      if ("missingLink" in result) return { waiting: true as const, question: "הלקוח או כתובת השירות אינם זמינים עוד.", missingFields: ["customerOrAddress"] };
      if (!("entity" in result)) return this.scheduleConflictPending(input.businessId, input.userId, "CREATE", null, startsAt!, endsAt, kind, result.conflicts);
      const entity = result.entity;
      if (!entity) throw new ConflictException("Activity creation did not return an entity");
      const businessSettings = await this.settings.getByBusiness(input.businessId);
      const windowText = startsAt && endsAt
        ? ` ל-${new Intl.DateTimeFormat("he-IL", { timeZone: businessSettings.timezone, dateStyle: "short", timeStyle: "short" }).format(startsAt)} עד ${new Intl.DateTimeFormat("he-IL", { timeZone: businessSettings.timezone, timeStyle: "short" }).format(endsAt)}`
        : " ללא מועד";
      const customer = await tx.customer.findFirst({ where: { id: entity.customerId, businessId: input.businessId, deletedAt: null } });
      return { entityType: kind, entityId: entity.id, entity, displayPayload: { ...entity, customerName: customer?.name }, message: `נ${kind === "job" ? "פתחה עבודה" : "פתח ביקור"} "${entity.title}"${windowText}.`, warnings: await this.activities.scheduleWarnings(input.businessId, startsAt, endsAt, kind) };
    }
    if (input.step.tool === "UPDATE_JOB" || input.step.tool === "UPDATE_VISIT") {
      const kind = input.step.tool === "UPDATE_JOB" ? "job" as const : "visit" as const;
      const entityId = this.resolveEntityId(input.step.input.entityId, input.step.input.entityRef, input.outputs);
      const existing = entityId ? kind === "job" ? await tx.job.findFirst({ where: { id: entityId, businessId: input.businessId, deletedAt: null } }) : await tx.visit.findFirst({ where: { id: entityId, businessId: input.businessId, deletedAt: null } }) : null;
      if (!existing) return { waiting: true as const, question: "לא מצאתי את הפעילות לעדכון.", missingFields: ["entityId"] };
      const startsAt = typeof input.step.input.startsAt === "string" ? new Date(input.step.input.startsAt) : undefined;
      const explicitEndsAt = typeof input.step.input.endsAt === "string" ? new Date(input.step.input.endsAt) : undefined;
      const endsAt = startsAt && explicitEndsAt === undefined
        ? shiftedScheduleEnd(kind, existing.startsAt, existing.endsAt, startsAt)
        : explicitEndsAt;
      const result = await this.activityRepository.updateInTransaction(tx, {
        kind,
        entityId: existing.id,
        businessId: input.businessId,
        title: typeof input.step.input.title === "string" ? input.step.input.title : undefined,
        description: typeof input.step.input.description === "string" ? input.step.input.description : undefined,
        startsAt,
        endsAt,
        serviceAddressId: typeof input.step.input.serviceAddressId === "string" ? input.step.input.serviceAddressId : undefined,
        locationSnapshot: typeof input.step.input.locationSnapshot === "string" ? input.step.input.locationSnapshot : undefined,
        allowScheduleConflict: false,
        approvedConflictFingerprint: (startsAt ?? existing.startsAt) ? this.assistantApprovedConflictFingerprint(input.step.input.scheduleConflictToken, { businessId: input.businessId, userId: input.userId, operation: "UPDATE", kind, entityId: existing.id, startsAt: (startsAt ?? existing.startsAt)!, endsAt: endsAt ?? existing.endsAt }) : undefined
      });
      if ("invalidSchedule" in result) return { waiting: true as const, question: "שעת הסיום חייבת להיות אחרי שעת ההתחלה.", missingFields: ["schedule"] };
      if ("missingLink" in result) return { waiting: true as const, question: "הלקוח או כתובת השירות אינם זמינים עוד.", missingFields: ["customerOrAddress"] };
      if ("notFound" in result) return { waiting: true as const, question: "הפעילות השתנתה מאז הבדיקה. צריך לבדוק שוב.", missingFields: ["entityVersion"] };
      if (!("entity" in result)) return this.scheduleConflictPending(input.businessId, input.userId, "UPDATE", existing.id, startsAt ?? existing.startsAt!, endsAt ?? existing.endsAt, kind, result.conflicts);
      const entity = result.entity;
      if (!entity) throw new ConflictException("Activity update did not return an entity");
      const customer = await tx.customer.findFirst({ where: { id: entity.customerId, businessId: input.businessId, deletedAt: null } });
      return { entityType: kind, entityId: entity.id, entity, displayPayload: { ...entity, customerName: customer?.name }, before: existing, operation: "UPDATE", message: `${kind === "job" ? "העבודה" : "הביקור"} "${entity.title}" עודכ${kind === "job" ? "נה" : "ן"}.`, warnings: await this.activities.scheduleWarnings(input.businessId, entity.startsAt ?? undefined, entity.endsAt ?? undefined, kind) };
    }
    if (["REPORT_JOB_COMPLETED", "CANCEL_JOB", "REOPEN_JOB", "DELETE_JOB", "REPORT_VISIT_COMPLETED", "CANCEL_VISIT", "REOPEN_VISIT", "DELETE_VISIT"].includes(input.step.tool)) {
      const kind = input.step.tool.includes("VISIT") ? "visit" : "job";
      const entityId = this.resolveEntityId(input.step.input.entityId, input.step.input.entityRef, input.outputs);
      const existing = entityId
        ? kind === "job" ? await tx.job.findFirst({ where: { id: entityId, businessId: input.businessId, deletedAt: null }, include: { amounts: { where: { deletedAt: null } } } }) : await tx.visit.findFirst({ where: { id: entityId, businessId: input.businessId, deletedAt: null }, include: { amounts: { where: { deletedAt: null } } } })
        : null;
      if (!existing) return { waiting: true as const, question: "לא מצאתי את הפעילות לעדכון.", missingFields: ["entityId"] };
      const isDelete = input.step.tool.startsWith("DELETE_");
      const isCancel = input.step.tool.startsWith("CANCEL_");
      const isReopen = input.step.tool.startsWith("REOPEN_");
      const completedAt = input.step.tool.startsWith("REPORT_") ? new Date() : undefined;
      const paid = existing.amounts[0]?.paymentStatus === "PAID";
      const noCharge = input.step.input.noCharge === true;
      if (completedAt && existing.amounts.length === 0 && !noCharge) {
        return { waiting: true as const, question: "האם היה חיוב עבור הפעילות?", missingFields: ["noChargeOrAmount"] };
      }
      const deletedAt = isDelete ? new Date() : undefined;
      const data = isDelete ? { deletedAt, deletedByUserId: input.userId, version: { increment: 1 } }
        : isCancel ? { status: "CANCELLED" as const, version: { increment: 1 } }
        : isReopen ? { status: "OPEN" as const, executionCompletedAt: null, executionCompletedByUserId: null, version: { increment: 1 } }
        : { executionCompletedAt: completedAt, executionCompletedByUserId: input.userId, status: paid || noCharge ? "CLOSED" as const : "OPEN" as const, version: { increment: 1 } };
      if (isDelete) {
        await tx.amount.updateMany({ where: { businessId: input.businessId, deletedAt: null, ...(kind === "job" ? { jobId: existing.id } : { visitId: existing.id }) }, data: { deletedAt, deletedByUserId: input.userId, version: { increment: 1 } } });
      }
      const entity = kind === "job" ? await tx.job.update({ where: { id: existing.id }, data }) : await tx.visit.update({ where: { id: existing.id }, data });
      const { amounts, ...activityBefore } = existing;
      return { entityType: kind, entityId: entity.id, entity, before: isDelete ? { deleteCascade: { activity: activityBefore, amounts } } : existing, operation: isDelete ? "DELETE_CASCADE" : "UPDATE" };
    }
    if (["SET_ACTIVITY_AMOUNT", "ADD_PAYMENT", "SET_PAID_TOTAL", "SETTLE_BALANCE"].includes(input.step.tool)) {
      const entityId = this.resolveEntityId(input.step.input.entityId, input.step.input.entityRef, input.outputs);
      if (!entityId) return { waiting: true as const, question: "לאיזו פעילות לעדכן את הסכום?", missingFields: ["entityId"] };
      const existing = await tx.amount.findFirst({ where: { businessId: input.businessId, deletedAt: null, OR: [{ jobId: entityId }, { visitId: entityId }] } });
      if (input.step.tool !== "SET_ACTIVITY_AMOUNT" && !existing) return { waiting: true as const, question: "צריך להגדיר סכום כולל לפני עדכון תשלום.", missingFields: ["totalAmount"] };
      const job = await tx.job.findFirst({ where: { id: entityId, businessId: input.businessId, deletedAt: null } });
      const visit = job ? null : await tx.visit.findFirst({ where: { id: entityId, businessId: input.businessId, deletedAt: null } });
      if (!job && !visit) return { waiting: true as const, question: "לא מצאתי את הפעילות.", missingFields: ["entityId"] };
      const previousTotal = existing?.totalAmount ?? money(0);
      const previousPaid = existing?.paidAmount ?? money(0);
      const nextTotal = input.step.tool === "SET_ACTIVITY_AMOUNT" ? money(Number(input.step.input.totalAmount)) : previousTotal;
      const mode = input.step.tool === "ADD_PAYMENT" ? "ADD" : input.step.tool === "SET_PAID_TOTAL" ? "SET_PAID_TOTAL" : "SETTLE_BALANCE";
      const nextPaid = input.step.tool === "SET_ACTIVITY_AMOUNT"
        ? (typeof input.step.input.paidAmount === "number" ? money(input.step.input.paidAmount) : previousPaid)
        : nextPaidAmount(mode, previousPaid, nextTotal, typeof input.step.input.amount === "number" ? input.step.input.amount : undefined);
      try { assertAmountInvariant(nextTotal, nextPaid); } catch { return { waiting: true as const, question: "הסכום ששולם אינו יכול להיות גבוה מהסכום הכולל. איך לתקן?", missingFields: ["totalAmountOrPaidAmount"] }; }
      const status = paymentStatus(nextTotal, nextPaid);
      const entity = existing ? await tx.amount.update({ where: { id: existing.id }, data: { totalAmount: nextTotal, paidAmount: nextPaid, paymentStatus: status, version: { increment: 1 } } }) : await tx.amount.create({ data: { businessId: input.businessId, ...(job ? { jobId: entityId } : { visitId: entityId }), totalAmount: nextTotal, paidAmount: nextPaid, paymentStatus: status } });
      const eventType = input.step.tool === "SET_ACTIVITY_AMOUNT" ? existing ? "CHANGE_TOTAL" as const : "CREATE" as const
        : input.step.tool === "ADD_PAYMENT" ? "ADD_PAYMENT" as const
        : input.step.tool === "SET_PAID_TOTAL" ? "SET_PAID_TOTAL" as const
        : "SETTLE_BALANCE" as const;
      await tx.amountEvent.create({ data: { businessId: input.businessId, amountId: entity.id, actorUserId: input.userId, eventType, previousTotal, nextTotal, previousPaid, nextPaid, paidDelta: nextPaid.minus(previousPaid), source: "assistant_v2" } });
      const activity = job ?? visit!;
      if (activity.status !== "CANCELLED") {
        const nextStatus = activity.executionCompletedAt && status === "PAID" ? "CLOSED" : "OPEN";
        if (job) await tx.job.update({ where: { id: job.id }, data: { status: nextStatus } }); else await tx.visit.update({ where: { id: visit!.id }, data: { status: nextStatus } });
      }
      return { entityType: "amount", entityId: entity.id, entity, before: existing ?? undefined, operation: existing ? "UPDATE" : "CREATE" };
    }
    if (input.step.tool === "UNDO_ACTION_BATCH") {
      const requestedId = typeof input.step.input.actionBatchId === "string" ? input.step.input.actionBatchId : undefined;
      const target = requestedId
        ? await tx.actionBatch.findFirst({ where: { id: requestedId, businessId: input.businessId } })
        : await tx.actionBatch.findFirst({
            where: { businessId: input.businessId, status: { not: "UNDONE" }, mutations: { some: {} } },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }]
          });
      if (!target) return { waiting: true as const, question: "לא מצאתי פעולה אחרונה שניתן לבטל.", missingFields: ["actionBatchId"] };
      const undone = await this.actionBatches.undoInTransaction(tx, input.businessId, target.id, input.userId);
      return { result: undone, message: undone.summary };
    }
    throw new BadRequestException(`Assistant tool is not executable in the current vertical slice: ${input.step.tool}`);
  }

  private async scheduleConflictPending(
    businessId: string,
    userId: string,
    operation: ScheduleConflictOperation,
    entityId: string | null,
    startsAt: Date,
    endsAt: Date | null | undefined,
    kind: "job" | "visit",
    conflicts: unknown[]
  ) {
    const preview = await this.activities.conflictPreview(businessId, startsAt, endsAt, kind, conflicts, { userId, operation, entityId });
    const candidates = [
      {
        id: "keep-conflicting-time",
        title: "לקבוע בכל זאת במועד שביקשת",
        payload: { scheduleConflictToken: preview.scheduleConflictToken }
      },
      ...preview.alternativeSlots.map((slot, index) => ({
        id: `alternative-${index + 1}`,
        title: `חלופה ${index + 1}: ${slot.startsAt.toISOString()}`,
        payload: { startsAt: slot.startsAt.toISOString(), endsAt: slot.endsAt.toISOString() }
      }))
    ];
    return {
      waiting: true as const,
      question: "המועד מתנגש בפעילות קיימת. אפשר לבחור חלופה או לאשר קביעה בכל זאת.",
      candidates,
      requiresExplicitConfirmation: true,
      confirmationOverrides: { scheduleConflictToken: preview.scheduleConflictToken },
      entityVersions: {}
    };
  }

  private async completeSatisfiedCallTask(
    plan: AssistantPlan,
    transcript: string,
    businessId: string
  ): Promise<AssistantPlan> {
    const describesCompletedConversation = /(?:דיברתי|דיברנו|שוחחתי|שוחחנו)/u.test(transcript);
    const describesScheduledWork = /(?:קבעתי|קבענו|סגרתי|סגרנו)/u.test(transcript);
    if (!describesCompletedConversation || !describesScheduledWork) return plan;
    if (plan.steps.some((step) => step.tool === "COMPLETE_TASK")) return plan;
    const activitySteps = plan.steps.filter((step) => step.tool === "CREATE_JOB" || step.tool === "CREATE_VISIT");
    const customerIds = [...new Set(activitySteps.map((step) => step.input.customerId).filter((value): value is string => typeof value === "string" && value.length > 0))];
    if (customerIds.length !== 1) return plan;
    const openTasks = await this.prisma.task.findMany({
      where: { businessId, customerId: customerIds[0], status: "OPEN", deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 20
    });
    const matching = openTasks.filter((task) => /(?:להתקשר|התקשר|לחזור|שיחה|לדבר)/u.test(task.title));
    if (matching.length !== 1) return plan;
    return AssistantPlanSchema.parse({
      ...plan,
      steps: [
        ...plan.steps,
        {
          stepId: "complete_satisfied_call_task",
          kind: "WRITE",
          tool: "COMPLETE_TASK",
          dependsOn: [],
          input: { taskId: matching[0]!.id },
          confidence: 1,
          requiresExplicitConfirmation: false
        }
      ]
    });
  }

  private nextDate(date: string) {
    const [year, month, day] = date.split("-").map(Number);
    return new Date(Date.UTC(year!, month! - 1, day! + 1)).toISOString().slice(0, 10);
  }

  private voiceItemTitle(tool: unknown, status: unknown, entity: unknown) {
    if (status !== "COMPLETED") return "ממתין להשלמה";
    const value = objectValue(entity);
    const entityTitle = typeof value.title === "string" ? value.title : undefined;
    const customerName = typeof value.name === "string" ? value.name : undefined;
    return tool === "CREATE_CUSTOMER" ? `לקוח חדש${customerName ? `: ${customerName}` : ""}`
      : tool === "ADD_CUSTOMER_PHONE" ? `טלפון נוסף${typeof value.customerName === "string" ? `: ${value.customerName}` : ""}`
      : tool === "CREATE_JOB" || tool === "UPDATE_JOB" ? entityTitle ?? "עבודה"
      : tool === "CREATE_VISIT" || tool === "UPDATE_VISIT" ? entityTitle ?? "ביקור"
      : tool === "CREATE_TASK" || tool === "UPDATE_TASK" ? entityTitle ?? "משימה"
      : tool === "CREATE_NOTE" || tool === "UPDATE_NOTE" ? "הערה ללקוח"
      : tool === "COMPLETE_TASK" ? `משימה הושלמה${entityTitle ? `: ${entityTitle}` : ""}`
      : "הפעולה הושלמה";
  }

  private voiceItemKind(tool: unknown) {
    return tool === "CREATE_CUSTOMER" || tool === "UPDATE_CUSTOMER" || tool === "ADD_CUSTOMER_PHONE" ? "customer"
      : typeof tool === "string" && tool.includes("TASK") ? "reminder"
      : typeof tool === "string" && tool.includes("JOB") ? "job"
      : typeof tool === "string" && tool.includes("VISIT") ? "home_visit"
      : typeof tool === "string" && tool.includes("NOTE") ? "note"
      : "action";
  }

  private assistantApprovedConflictFingerprint(token: unknown, input: { businessId: string; userId: string; operation: ScheduleConflictOperation; kind: "job" | "visit"; entityId: string | null; startsAt: Date; endsAt?: Date | null }) {
    if (typeof token !== "string" || !token) return undefined;
    return verifyScheduleConflictToken(token, {
      businessId: input.businessId,
      userId: input.userId,
      operation: input.operation,
      kind: input.kind,
      entityId: input.entityId,
      startsAt: input.startsAt.toISOString(),
      endsAt: effectiveScheduleEnd(input.kind, input.startsAt, input.endsAt).toISOString()
    }, getInternalApiSecret())?.conflictFingerprint;
  }

  private resolveCustomerReference(value: unknown, outputs: Map<string, Record<string, unknown>>) {
    if (value === undefined) return undefined;
    const reference = AssistantStepReferenceSchema.parse(value);
    const resolved = outputs.get(reference.stepId)?.[reference.outputField];
    if (typeof resolved !== "string" || !resolved) {
      throw new BadRequestException("Assistant step reference could not be resolved");
    }
    return resolved;
  }

  private resolveEntityId(direct: unknown, referenceValue: unknown, outputs: Map<string, Record<string, unknown>>) {
    if (typeof direct === "string" && direct) return direct;
    if (referenceValue === undefined) return undefined;
    const reference = AssistantStepReferenceSchema.parse(referenceValue);
    const resolved = outputs.get(reference.stepId)?.[reference.outputField];
    return typeof resolved === "string" && resolved ? resolved : undefined;
  }
}
