import { Inject, Injectable } from "@nestjs/common";
import { type AmountEventType, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma.service.js";
import { activityStatusAfterAmount, assertAmountInvariant, money, nextPaidAmount, paymentStatus } from "../v2-money.js";
import type { V2ActivityKind } from "./v2-activities.repositories.js";

type AmountChange = {
  totalAmount?: number;
  paidAmount?: number;
  confirmed?: boolean;
  version?: number;
};

@Injectable()
export class V2AmountsRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  find(kind: V2ActivityKind, businessId: string, entityId: string) {
    return this.prisma.amount.findFirst({
      where: { businessId, deletedAt: null, ...(kind === "job" ? { jobId: entityId } : { visitId: entityId }) },
      include: { events: { orderBy: { occurredAt: "asc" } } }
    });
  }

  async set(input: {
    kind: V2ActivityKind;
    businessId: string;
    entityId: string;
    actorUserId: string;
    change: AmountChange;
    source: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const activity = await this.activity(tx, input.kind, input.businessId, input.entityId);
      if (!activity) return { notFound: true as const };
      const existing = await tx.amount.findFirst({
        where: { businessId: input.businessId, deletedAt: null, ...(input.kind === "job" ? { jobId: input.entityId } : { visitId: input.entityId }) }
      });
      if (existing && input.change.version !== undefined && existing.version !== input.change.version) {
        return { versionConflict: true as const };
      }
      const previousTotal = existing?.totalAmount ?? money(0);
      const previousPaid = existing?.paidAmount ?? money(0);
      const nextTotal = input.change.totalAmount === undefined ? previousTotal : money(input.change.totalAmount);
      const nextPaid = input.change.paidAmount === undefined ? previousPaid : money(input.change.paidAmount);
      if (nextTotal.lessThan(previousPaid) && !input.change.confirmed) return { needsConfirmation: true as const };
      try {
        assertAmountInvariant(nextTotal, nextPaid);
      } catch {
        return { invalidAmount: true as const };
      }
      const status = paymentStatus(nextTotal, nextPaid);
      const amount = existing
        ? await tx.amount.update({
            where: { id: existing.id },
            data: { totalAmount: nextTotal, paidAmount: nextPaid, paymentStatus: status, version: { increment: 1 } }
          })
        : await tx.amount.create({
            data: {
              businessId: input.businessId,
              ...(input.kind === "job" ? { jobId: input.entityId } : { visitId: input.entityId }),
              totalAmount: nextTotal,
              paidAmount: nextPaid,
              paymentStatus: status
            }
          });
      const eventType: AmountEventType = !existing ? "CREATE"
        : input.change.paidAmount !== undefined ? "CORRECTION"
        : "CHANGE_TOTAL";
      await this.event(tx, input, amount.id, eventType, previousTotal, nextTotal, previousPaid, nextPaid);
      await this.syncActivity(tx, input.kind, activity, status);
      return { amount };
    });
  }

  async payment(input: {
    kind: V2ActivityKind;
    businessId: string;
    entityId: string;
    actorUserId: string;
    mode: "ADD" | "SET_PAID_TOTAL" | "SETTLE_BALANCE";
    amount?: number;
    source: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const activity = await this.activity(tx, input.kind, input.businessId, input.entityId);
      if (!activity) return { notFound: true as const };
      const existing = await tx.amount.findFirst({
        where: { businessId: input.businessId, deletedAt: null, ...(input.kind === "job" ? { jobId: input.entityId } : { visitId: input.entityId }) }
      });
      if (!existing) return { amountNotFound: true as const };
      const nextPaid = nextPaidAmount(input.mode, existing.paidAmount, existing.totalAmount, input.amount);
      try {
        assertAmountInvariant(existing.totalAmount, nextPaid);
      } catch {
        return { invalidAmount: true as const };
      }
      const status = paymentStatus(existing.totalAmount, nextPaid);
      const amount = await tx.amount.update({
        where: { id: existing.id },
        data: { paidAmount: nextPaid, paymentStatus: status, version: { increment: 1 } }
      });
      const eventType: AmountEventType = input.mode === "ADD" ? "ADD_PAYMENT"
        : input.mode === "SET_PAID_TOTAL" ? "SET_PAID_TOTAL"
        : "SETTLE_BALANCE";
      await this.event(tx, input, amount.id, eventType, existing.totalAmount, existing.totalAmount, existing.paidAmount, nextPaid);
      await this.syncActivity(tx, input.kind, activity, status);
      return { amount };
    });
  }

  async paymentReport(businessId: string, from: Date, to: Date) {
    const events = await this.prisma.amountEvent.findMany({
      where: {
        businessId,
        occurredAt: { gte: from, lt: to },
        amount: {
          deletedAt: null,
          OR: [
            { job: { status: { not: "CANCELLED" }, deletedAt: null } },
            { visit: { status: { not: "CANCELLED" }, deletedAt: null } }
          ]
        }
      },
      include: { amount: { include: { job: { include: { customer: true } }, visit: { include: { customer: true } } } } },
      orderBy: { occurredAt: "desc" }
    });
    const totalPaid = events.reduce((sum, event) => sum.plus(event.paidDelta), money(0));
    return { totalPaid, events };
  }

  async openBalances(businessId: string) {
    const amounts = await this.prisma.amount.findMany({
      where: {
        businessId,
        deletedAt: null,
        paymentStatus: { not: "PAID" },
        OR: [
          { job: { status: { not: "CANCELLED" }, deletedAt: null } },
          { visit: { status: { not: "CANCELLED" }, deletedAt: null } }
        ]
      },
      include: { job: { include: { customer: true } }, visit: { include: { customer: true } } },
      orderBy: { updatedAt: "desc" }
    });
    const totalBalance = amounts.reduce((sum, amount) => sum.plus(amount.totalAmount.minus(amount.paidAmount)), money(0));
    return { totalBalance, amounts };
  }

  private activity(tx: Prisma.TransactionClient, kind: V2ActivityKind, businessId: string, entityId: string) {
    return kind === "job"
      ? tx.job.findFirst({ where: { id: entityId, businessId, deletedAt: null } })
      : tx.visit.findFirst({ where: { id: entityId, businessId, deletedAt: null } });
  }

  private async syncActivity(
    tx: Prisma.TransactionClient,
    kind: V2ActivityKind,
    activity: { id: string; status: "OPEN" | "CLOSED" | "CANCELLED"; executionCompletedAt: Date | null },
    status: "UNPAID" | "PARTIALLY_PAID" | "PAID"
  ) {
    const nextStatus = activityStatusAfterAmount(activity.status, activity.executionCompletedAt, status);
    if (nextStatus === "CANCELLED") return;
    if (kind === "job") await tx.job.update({ where: { id: activity.id }, data: { status: nextStatus } });
    else await tx.visit.update({ where: { id: activity.id }, data: { status: nextStatus } });
  }

  private event(
    tx: Prisma.TransactionClient,
    input: { businessId: string; actorUserId: string; source: string },
    amountId: string,
    eventType: AmountEventType,
    previousTotal: Prisma.Decimal,
    nextTotal: Prisma.Decimal,
    previousPaid: Prisma.Decimal,
    nextPaid: Prisma.Decimal
  ) {
    return tx.amountEvent.create({
      data: {
        businessId: input.businessId,
        amountId,
        actorUserId: input.actorUserId,
        eventType,
        previousTotal,
        nextTotal,
        previousPaid,
        nextPaid,
        paidDelta: nextPaid.minus(previousPaid),
        source: input.source
      }
    });
  }
}
