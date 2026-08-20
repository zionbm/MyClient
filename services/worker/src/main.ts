import "reflect-metadata";
import { Body, Controller, Get, Module, Post } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ApiExceptionFilter, getPort, health, log } from "@myclient/common";

type MockJob = {
  id: string;
  type: string;
  payload: unknown;
  status: "QUEUED" | "COMPLETED";
  createdAt: string;
};

const jobs: MockJob[] = [];

@Controller()
class WorkerController {
  @Get("health")
  health() {
    return health("worker", { queue: "mock-in-memory", scheduler: "mock-cloud-scheduler" });
  }

  @Post("jobs/mock")
  enqueue(@Body() body: { type?: string; payload?: unknown }) {
    const job: MockJob = {
      id: `job_${crypto.randomUUID()}`,
      type: body.type ?? "MOCK_JOB",
      payload: body.payload ?? {},
      status: "QUEUED",
      createdAt: new Date().toISOString()
    };
    jobs.push(job);
    log("info", "mock job queued", { jobId: job.id, type: job.type });
    return { job };
  }

  @Get("jobs/mock")
  list() {
    return { jobs };
  }
}

@Module({
  controllers: [WorkerController]
})
class WorkerModule {}

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(WorkerModule, new FastifyAdapter());
  app.useGlobalFilters(new ApiExceptionFilter("worker"));
  const port = getPort("WORKER_PORT", 3004);
  await app.listen(port, "0.0.0.0");
  log("info", "worker service listening", { port });
}

await bootstrap();
