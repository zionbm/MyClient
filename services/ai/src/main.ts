import "reflect-metadata";
import { Body, Controller, Get, Module, Post } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ApiExceptionFilter, getPort, health, log, stableIdempotencyKey } from "@myclient/common";
import type { AiAction } from "@myclient/contracts";

@Controller()
class AiController {
  @Get("health")
  health() {
    return health("ai", { llm: "mock-gemini" });
  }

  @Post("intent/parse")
  parseIntent(@Body() body: { text?: string; businessId?: string; userId?: string; idempotencyKey?: string }) {
    const text = (body.text ?? "").trim();
    const idempotencyKey = body.idempotencyKey ?? stableIdempotencyKey("ai", `${body.businessId}:${body.userId}:${text}`);

    const action: AiAction = this.mockAction(text, idempotencyKey);
    log("info", "mock intent parsed", { businessId: body.businessId, actionType: action.type });
    return { provider: "mock-gemini", action };
  }

  private mockAction(text: string, idempotencyKey: string): AiAction {
    if (!text) {
      return {
        type: "CREATE_TASK",
        idempotencyKey,
        confidence: 0.2,
        requiresConfirmation: false,
        missingFields: ["text"],
        payload: {}
      };
    }

    if (text.includes("פגישה") || text.toLowerCase().includes("appointment")) {
      return {
        type: "CREATE_APPOINTMENT",
        idempotencyKey,
        confidence: 0.72,
        requiresConfirmation: true,
        missingFields: ["startsAt"],
        payload: { title: text }
      };
    }

    if (text.includes("לקוח") || text.toLowerCase().includes("customer")) {
      return {
        type: "CREATE_CUSTOMER",
        idempotencyKey,
        confidence: 0.68,
        requiresConfirmation: false,
        missingFields: ["name"],
        payload: { rawText: text }
      };
    }

    return {
      type: "CREATE_TASK",
      idempotencyKey,
      confidence: 0.82,
      requiresConfirmation: false,
      missingFields: [],
      payload: {
        title: text,
        description: `Created from owner command: ${text}`
      }
    };
  }
}

@Module({
  controllers: [AiController]
})
class AiModule {}

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AiModule, new FastifyAdapter());
  app.useGlobalFilters(new ApiExceptionFilter("ai"));
  const port = getPort("AI_PORT", 3001);
  await app.listen(port, "0.0.0.0");
  log("info", "ai service listening", { port });
}

await bootstrap();
