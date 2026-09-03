import "reflect-metadata";
import { Body, Controller, Get, Headers, Module, Post, UnauthorizedException } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ApiExceptionFilter, cloudRunServiceAuthHeaders, configureHttpObservability, getEnv, getInternalApiSecret, getPort, health, log, validateServiceEnvironment } from "@myclient/common";

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

type TaskPollState = {
  enabled: boolean;
  intervalMs: number;
  running: boolean;
  runs: number;
  lastRunAt?: string;
  lastStatus?: "SUCCESS" | "FAILED";
  lastProcessed?: number;
  lastError?: string;
};

const taskPollState: TaskPollState = {
  enabled: getEnv("WORKER_TASK_POLL_ENABLED", "true") === "true",
  intervalMs: positiveNumberEnv("WORKER_TASK_POLL_INTERVAL_MS", 300000),
  running: false,
  runs: 0
};

async function pollDueTasks() {
  if (!taskPollState.enabled || taskPollState.running) {
    return;
  }

  taskPollState.running = true;
  taskPollState.runs += 1;
  taskPollState.lastRunAt = new Date().toISOString();
  try {
    const coreBaseUrl = getEnv("CORE_BASE_URL", "http://localhost:3000");
    const response = await fetch(`${coreBaseUrl}/internal/tasks/due`, {
      method: "POST",
      headers: {
        ...(await cloudRunServiceAuthHeaders(coreBaseUrl)),
        "content-type": "application/json",
        "x-internal-secret": getInternalApiSecret()
      },
      body: JSON.stringify({
        limit: positiveNumberEnv("WORKER_TASK_BATCH_SIZE", 20)
      })
    });
    const result = (await response.json().catch(() => ({}))) as { processed?: number; error?: unknown };
    if (!response.ok) {
      throw new Error(`Core task endpoint failed with ${response.status}: ${JSON.stringify(result)}`);
    }
    taskPollState.lastStatus = "SUCCESS";
    taskPollState.lastProcessed = result.processed ?? 0;
    taskPollState.lastError = undefined;
    if ((result.processed ?? 0) > 0) {
      log("info", "due tasks processed", { processed: result.processed });
    }
  } catch (error) {
    taskPollState.lastStatus = "FAILED";
    taskPollState.lastError = error instanceof Error ? error.message : String(error);
    log("error", "due task polling failed", { error: taskPollState.lastError });
  } finally {
    taskPollState.running = false;
  }
}

@Controller()
class WorkerController {
  @Get("health")
  health() {
    return health("worker", {
      queue: "mock-in-memory",
      scheduler: "interval-polling",
      tasks: taskPollState.enabled ? "enabled" : "disabled"
    });
  }

  @Get("tasks/status")
  taskStatus(@Headers() headers: RequestHeaders) {
    requireInternalSecret(headers);
    return { tasks: taskPollState };
  }

  @Post("tasks/run")
  async runReminders(@Headers() headers: RequestHeaders) {
    requireInternalSecret(headers);
    await pollDueTasks();
    return { tasks: taskPollState };
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
  validateServiceEnvironment("worker");
  const adapter = new FastifyAdapter();
  const app = await NestFactory.create<NestFastifyApplication>(WorkerModule, adapter);
  app.enableShutdownHooks();
  configureHttpObservability(adapter.getInstance(), "worker");
  app.useGlobalFilters(new ApiExceptionFilter("worker"));
  const port = getPort("WORKER_PORT", 3004);
  await app.listen(port, "0.0.0.0");
  if (taskPollState.enabled) {
    setInterval(() => {
      void pollDueTasks();
    }, taskPollState.intervalMs);
    void pollDueTasks();
  }
  log("info", "worker service listening", { port, taskPollIntervalMs: taskPollState.intervalMs });
}

await bootstrap();
