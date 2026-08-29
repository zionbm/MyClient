import "reflect-metadata";
import { Body, Controller, Get, Headers, Module, Post, UnauthorizedException } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ApiExceptionFilter, cloudRunServiceAuthHeaders, getEnv, getInternalApiSecret, getPort, health, log } from "@myclient/common";

type RequestHeaders = Record<string, string | string[] | undefined>;

type MockRun = {
  id: string;
  type: string;
  payload: unknown;
  status: "QUEUED" | "DONE";
  createdAt: string;
};

const mockRuns: MockRun[] = [];

function headerValue(headers: RequestHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()] ?? headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function requireInternalSecret(headers: RequestHeaders): void {
  if (headerValue(headers, "x-internal-secret") !== getInternalApiSecret()) {
    throw new UnauthorizedException("Missing or invalid internal secret");
  }
}

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
        "x-internal-secret": getInternalApiSecret()
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
  reminderStatus(@Headers() headers: RequestHeaders) {
    requireInternalSecret(headers);
    return { reminders: reminderPollState };
  }

  @Post("reminders/run")
  async runReminders(@Headers() headers: RequestHeaders) {
    requireInternalSecret(headers);
    await pollDueReminders();
    return { reminders: reminderPollState };
  }

  @Post("mock-runs")
  enqueue(@Headers() headers: RequestHeaders, @Body() body: { type?: string; payload?: unknown }) {
    requireInternalSecret(headers);
    const run: MockRun = {
      id: `mock_run_${crypto.randomUUID()}`,
      type: body.type ?? "MOCK_RUN",
      payload: body.payload ?? {},
      status: "QUEUED",
      createdAt: new Date().toISOString()
    };
    mockRuns.push(run);
    log("info", "mock run queued", { runId: run.id, type: run.type });
    return { run };
  }

  @Get("mock-runs")
  list(@Headers() headers: RequestHeaders) {
    requireInternalSecret(headers);
    return { runs: mockRuns };
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
