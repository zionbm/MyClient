import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  AssistantPlanSchema,
  AssistantStepReferenceSchema,
  V2AssistantCommandSchema,
  V2CreateAssistantSessionSchema,
  V2CreateCustomerSchema,
  V2CreateTaskSchema,
  type AssistantPlanStep
} from "@myclient/contracts";
import { CoreAccessService } from "./core-access.service.js";
import { CoreAiInternalClient } from "./core-internal-clients.service.js";
import { CoreV2IdempotencyService } from "./core-v2-idempotency.service.js";
import { CoreV2ActivitiesService } from "./core-v2-activities.service.js";
import { AssistantSessionsRepository } from "./core.repositories.js";
import { PrismaService } from "./prisma.service.js";
import { parseOptionalDate, requiredIdempotencyKey, type RequestHeaders } from "./core-utils.js";
import { normalizeCustomerName } from "./v2-normalization.js";

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
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
    @Inject(CoreV2ActivitiesService) private readonly activities: CoreV2ActivitiesService,
    @Inject(PrismaService) private readonly prisma: PrismaService
  ) {}

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
        const planned = await this.ai.planV2AssistantCommand({
          transcript: command.transcript,
          context: session.context
        });
        const plan = AssistantPlanSchema.parse(planned.plan);
        const steps = orderedSteps(plan.steps);
        return this.prisma.$transaction(async (tx) => {
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

            if (step.kind === "CLARIFY" || step.tool === "ASK_CLARIFICATION") {
              const question = typeof step.input.question === "string" ? step.input.question : "נדרש מידע נוסף";
              const pending = await tx.aiPendingAction.create({
                data: {
                  businessId,
                  userId: user.id,
                  actionType: step.tool,
                  payload: jsonValue(step.input),
                  missingFields: [],
                  actionBatchId: actionBatch.id,
                  createdByUserId: user.id,
                  assistantSessionId: session.id,
                  question,
                  dependencyStepKeys: step.dependsOn,
                  requiresExplicitConfirmation: step.requiresExplicitConfirmation
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
              outputs
            });
            if (output.entityType && output.entityId && output.entity) {
              sequence += 1;
              await tx.actionMutation.create({
                data: {
                  actionBatchId: actionBatch.id,
                  actionBatchStepId: batchStep.id,
                  sequence,
                  entityType: output.entityType,
                  entityId: output.entityId,
                  operation: "CREATE",
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
          const readSummary = receiptSteps.map((step) => step.message).filter((message): message is string => typeof message === "string").join(" ");
          const summary = readSummary || (waiting
            ? completedCount > 0
              ? "ביצעתי את הפעולות הברורות ושמרתי שאלה להשלמה."
              : "אני צריך עוד פרט לפני שאוכל לבצע את הבקשה."
            : completedCount === 1
              ? "הפעולה בוצעה בהצלחה."
              : `בוצעו ${completedCount} פעולות בהצלחה.`);
          const status = waiting
            ? completedCount > 0 ? "PARTIALLY_COMPLETED" : "WAITING"
            : "COMPLETED";
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
                kind: "action",
                status: step.status === "COMPLETED" ? "created" : "pending",
                title: step.status === "COMPLETED" ? "הפעולה הושלמה" : "ממתין להשלמה",
                subtitle: step.question,
                payload: {},
                fields: [],
                missingFields: [],
                entityId: step.entityId,
                aiPendingActionId: step.pendingActionId
              })),
              primaryAction: "סגור",
              secondaryActions: ["הקלט שוב"]
            }
          };
        });
      }
    });
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
    }
  ) {
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
      return { entityType: "customer", entityId: customer.id, entity: customer };
    }
    if (input.step.tool === "CREATE_TASK") {
      const command = V2CreateTaskSchema.parse(input.step.input);
      const customerId = command.customerId ?? this.resolveCustomerReference(input.step.input.customerRef, input.outputs);
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
      return { entityType: "task", entityId: task.id, entity: task };
    }
    throw new BadRequestException(`Assistant tool is not executable in the current vertical slice: ${input.step.tool}`);
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
}
