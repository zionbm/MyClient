import "reflect-metadata";
import { Body, Controller, Get, Module, Post } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ApiExceptionFilter, cloudRunServiceAuthHeaders, getEnv, getPort, health, log } from "@myclient/common";

type MockJob = {
  id: string;
  type: string;
  payload: unknown;
  status: "QUEUED" | "COMPLETED";
  createdAt: string;
};

const jobs: MockJob[] = [];

function positiveNumberEnv(name: string, fallback: number) {
  const value = Number(getEnv(name, String(fallback)));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

type ReminderPollState = {
  enabled: boolean;
  intervalMs: number;
  running: boolean;
  runs: number;
  lastRunAt?: string;
  lastStatus?: "SUCCESS" | "FAILED";
  lastProcessed?: number;
  lastError?: string;
};

const reminderPollState: ReminderPollState = {
  enabled: getEnv("WORKER_REMINDER_POLL_ENABLED", "true") === "true",
  intervalMs: positiveNumberEnv("WORKER_REMINDER_POLL_INTERVAL_MS", 300000),
  running: false,
  runs: 0
};

async function pollDueReminders() {
  if (!reminderPollState.enabled || reminderPollState.running) {
    return;
  }

  reminderPollState.running = true;
  reminderPollState.runs += 1;
  reminderPollState.lastRunAt = new Date().toISOString();
  try {
    const coreBaseUrl = getEnv("CORE_BASE_URL", "http://localhost:3000");
    const response = await fetch(`${coreBaseUrl}/internal/reminders/due`, {
      method: "POST",
      headers: {
        ...(await cloudRunServiceAuthHeaders(coreBaseUrl)),
        "content-type": "application/json",
        "x-internal-secret": getEnv("INTERNAL_API_SECRET", "dev-internal-secret")
      },
      body: JSON.stringify({
        limit: positiveNumberEnv("WORKER_REMINDER_BATCH_SIZE", 20)
      })
    });
    const result = (await response.json().catch(() => ({}))) as { processed?: number; error?: unknown };
    if (!response.ok) {
      throw new Error(`Core reminder endpoint failed with ${response.status}: ${JSON.stringify(result)}`);
    }
    reminderPollState.lastStatus = "SUCCESS";
    reminderPollState.lastProcessed = result.processed ?? 0;
    reminderPollState.lastError = undefined;
    if ((result.processed ?? 0) > 0) {
      log("info", "due reminders processed", { processed: result.processed });
    }
  } catch (error) {
    reminderPollState.lastStatus = "FAILED";
    reminderPollState.lastError = error instanceof Error ? error.message : String(error);
    log("error", "due reminder polling failed", { error: reminderPollState.lastError });
  } finally {
    reminderPollState.running = false;
  }
}

@Controller()
class WorkerController {
  @Get("health")
  health() {
    return health("worker", {
      queue: "mock-in-memory",
      scheduler: "interval-polling",
      reminders: reminderPollState.enabled ? "enabled" : "disabled"
    });
  }

  @Get("reminders/status")
  reminderStatus() {
    return { reminders: reminderPollState };
  }

  @Post("reminders/run")
  async runReminders() {
    await pollDueReminders();
    return { reminders: reminderPollState };
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
  if (reminderPollState.enabled) {
    setInterval(() => {
      void pollDueReminders();
    }, reminderPollState.intervalMs);
    void pollDueReminders();
  }
  log("info", "worker service listening", { port, reminderPollIntervalMs: reminderPollState.intervalMs });
}

await bootstrap();
