import { Inject, Injectable } from "@nestjs/common";
import { SearchQuerySchema } from "@myclient/contracts";
import { CoreAccessService } from "./core-access.service.js";
import { PrismaService } from "./prisma.service.js";
import type { RequestHeaders } from "./core-utils.js";

@Injectable()
export class CoreSearchService {
  constructor(
    @Inject(CoreAccessService) private readonly access: CoreAccessService,
    @Inject(PrismaService) private readonly prisma: PrismaService
  ) {}

  async search(headers: RequestHeaders, businessId: string, query: unknown) {
    await this.access.requireBusinessAccess(headers, businessId);
    const command = SearchQuerySchema.parse(query);
    const offset = Number.parseInt(command.cursor ?? "0", 10);
    const skip = Number.isFinite(offset) && offset >= 0 ? offset : 0;
    const contains = { contains: command.query, mode: "insensitive" as const };

    if (command.target === "customers") {
      const customers = await this.prisma.customer.findMany({
        where: { businessId, deletedAt: null, OR: [{ name: contains }, { phone: contains }, { email: contains }, { address: contains }] },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip,
        take: command.limit + 1
      });
      return this.page(customers, command.limit, skip);
    }

    const status = command.status === "open" ? "OPEN" : undefined;
    const [reminders, homeVisits, appointments, quotes] = await Promise.all([
      this.prisma.reminder.findMany({ where: { businessId, deletedAt: null, status, OR: [{ title: contains }, { description: contains }, { customer: { name: contains } }, { customer: { phone: contains } }] }, include: { customer: true } }),
      this.prisma.homeVisit.findMany({ where: { businessId, deletedAt: null, status, OR: [{ title: contains }, { location: contains }, { notes: contains }, { customer: { name: contains } }, { customer: { phone: contains } }] }, include: { customer: true } }),
      this.prisma.appointment.findMany({ where: { businessId, deletedAt: null, status, OR: [{ title: contains }, { location: contains }, { notes: contains }, { customer: { name: contains } }, { customer: { phone: contains } }] }, include: { customer: true } }),
      this.prisma.quote.findMany({ where: { businessId, deletedAt: null, status, OR: [{ title: contains }, { description: contains }, { customer: { name: contains } }, { customer: { phone: contains } }] }, include: { customer: true } })
    ]);
    const items = [
      ...reminders.map((item) => ({ ...item, type: "reminder" })),
      ...homeVisits.map((item) => ({ ...item, type: "home_visit" })),
      ...appointments.map((item) => ({ ...item, type: "appointment" })),
      ...quotes.map((item) => ({ ...item, type: "quote" }))
    ].filter((item) => command.status !== "done" || ["DONE", "PAID", "CANCELLED"].includes(item.status))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
    return this.page(items, command.limit, skip);
  }

  private page<T>(items: T[], limit: number, skip: number) {
    const pageItems = items.slice(0, limit);
    const hasMore = items.length > limit;
    return { items: pageItems, pageInfo: { hasMore, nextCursor: hasMore ? String(skip + limit) : null } };
  }
}
