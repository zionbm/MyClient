import { Inject, Injectable } from "@nestjs/common";
import { V2SearchQuerySchema } from "@myclient/contracts";
import { CoreAccessService } from "./core-access.service.js";
import { PrismaService } from "./prisma.service.js";
import { encodePageCursor, paginationFromParsedQuery, type RequestHeaders } from "./core-utils.js";

@Injectable()
export class CoreV2SearchService {
  constructor(
    @Inject(CoreAccessService) private readonly access: CoreAccessService,
    @Inject(PrismaService) private readonly prisma: PrismaService
  ) {}

  async search(headers: RequestHeaders, businessId: string, query: unknown) {
    await this.access.requireV2BusinessAccess(headers, businessId);
    const command = V2SearchQuerySchema.parse(query);
    const pagination = paginationFromParsedQuery(command);
    const contains = { contains: command.query, mode: "insensitive" as const };
    const wants = (target: string) => command.target === "all" || command.target === target;
    const taskStatus = command.status === "all" ? undefined
      : command.status === "open" ? "OPEN" as const
      : command.status === "cancelled" ? "CANCELLED" as const
      : "DONE" as const;
    const activityStatus = command.status === "all" ? undefined
      : command.status === "open" ? "OPEN" as const
      : command.status === "cancelled" ? "CANCELLED" as const
      : "CLOSED" as const;
    const take = command.limit + 1;
    const cursorWhere = pagination.cursor ? {
      OR: [
        { updatedAt: { lt: pagination.cursor.createdAt } },
        { updatedAt: pagination.cursor.createdAt, id: { lt: pagination.cursor.id } }
      ]
    } : {};
    const [customers, tasks, jobs, visits] = await Promise.all([
      wants("customers") ? this.prisma.customer.findMany({
        where: { businessId, deletedAt: null, mergedIntoCustomerId: null, AND: [cursorWhere, { OR: [{ name: contains }, { email: contains }] }] },
        take,
        orderBy: { updatedAt: "desc" }
      }) : [],
      wants("tasks") ? this.prisma.task.findMany({
        where: { businessId, deletedAt: null, status: taskStatus, AND: [cursorWhere, { OR: [{ title: contains }, { description: contains }] }] },
        include: { customer: true },
        take,
        orderBy: { updatedAt: "desc" }
      }) : [],
      wants("jobs") ? this.prisma.job.findMany({
        where: { businessId, deletedAt: null, status: activityStatus, AND: [cursorWhere, { OR: [{ title: contains }, { description: contains }, { customer: { name: contains } }] }] },
        include: { customer: true },
        take,
        orderBy: { updatedAt: "desc" }
      }) : [],
      wants("visits") ? this.prisma.visit.findMany({
        where: { businessId, deletedAt: null, status: activityStatus, AND: [cursorWhere, { OR: [{ title: contains }, { description: contains }, { customer: { name: contains } }] }] },
        include: { customer: true },
        take,
        orderBy: { updatedAt: "desc" }
      }) : []
    ]);
    const candidates = [
      ...customers.map((item) => ({ type: "customer", item })),
      ...tasks.map((item) => ({ type: "task", item })),
      ...jobs.map((item) => ({ type: "job", item })),
      ...visits.map((item) => ({ type: "visit", item }))
    ].sort((a, b) => b.item.updatedAt.getTime() - a.item.updatedAt.getTime() || b.item.id.localeCompare(a.item.id));
    const hasMore = candidates.length > command.limit;
    const items = candidates.slice(0, command.limit);
    const last = items.at(-1)?.item;
    return { items, pageInfo: { hasMore, nextCursor: hasMore && last ? encodePageCursor({ id: last.id, createdAt: last.updatedAt }) : null } };
  }
}
