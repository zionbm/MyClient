import "reflect-metadata";
import { BadGatewayException, Body, Controller, Get, Module, Post } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ApiExceptionFilter, getEnv, getPort, health, log, stableIdempotencyKey } from "@myclient/common";
import type { CreateCallbackTask } from "@myclient/contracts";

type IvrDigit = "1" | "2" | "3";

async function readDownstreamError(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

@Controller()
class TelephonyController {
  @Get("health")
  health() {
    return health("telephony", { plivo: "mock", core: getEnv("CORE_BASE_URL", "http://localhost:3000") });
  }

  @Post("plivo/incoming")
  incoming(@Body() body: { businessId?: string; callId?: string; from?: string; to?: string; digit?: string }) {
    const digit = this.normalizeDigit(body.digit);
    const callerIdAvailable = Boolean(body.from);
    if (!callerIdAvailable) {
      return {
        mode: "RECORD_MESSAGE",
        reason: "CALLER_ID_MISSING",
        prompt: "אנא ציין את שמך ואת מספר הטלפון לחזרה אחרי הצליל."
      };
    }

    if (!digit) {
      return {
        mode: "PLAY_MENU",
        prompt: "לחזרה טלפונית הקש 1, להשארת הודעה הקש 2, ולמקרה דחוף הקש 3."
      };
    }

    if (digit === "1") {
      return {
        mode: "CREATE_CALLBACK_WITHOUT_RECORDING",
        nextWebhook: "/plivo/callback-request"
      };
    }

    return {
      mode: "RECORD_MESSAGE",
      urgent: digit === "3",
      maxSeconds: 60,
      finishOnKey: "#"
    };
  }

  @Post("plivo/callback-request")
  async callbackRequest(@Body() body: { businessId: string; callId: string; from?: string; to?: string }) {
    return this.createCoreCallbackTask({
      businessId: body.businessId,
      callerPhone: body.from,
      priority: "NORMAL",
      sourceCallId: body.callId,
      idempotencyKey: stableIdempotencyKey("plivo_callback", body.callId)
    });
  }

  @Post("plivo/recording")
  async recording(
    @Body()
    body: {
      businessId: string;
      callId: string;
      from?: string;
      recordingUrl?: string;
      transcript?: string;
      urgent?: boolean;
    }
  ) {
    const voiceBaseUrl = getEnv("VOICE_BASE_URL", "http://localhost:3002");
    const sttResponse = await fetch(`${voiceBaseUrl}/stt/mock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recordingUrl: body.recordingUrl, transcript: body.transcript })
    });

    if (!sttResponse.ok) {
      throw new BadGatewayException({
        message: `Voice service failed with ${sttResponse.status}`,
        details: await readDownstreamError(sttResponse)
      });
    }

    const stt = (await sttResponse.json()) as { transcript?: string };
    return this.createCoreCallbackTask({
      businessId: body.businessId,
      callerPhone: body.from,
      transcript: stt.transcript,
      priority: body.urgent ? "URGENT" : "NORMAL",
      sourceCallId: body.callId,
      idempotencyKey: stableIdempotencyKey("plivo_recording", `${body.callId}:${body.urgent ? "urgent" : "normal"}`)
    });
  }

  private normalizeDigit(digit: string | undefined): IvrDigit | undefined {
    return digit === "1" || digit === "2" || digit === "3" ? digit : undefined;
  }

  private async createCoreCallbackTask(command: CreateCallbackTask) {
    const coreBaseUrl = getEnv("CORE_BASE_URL", "http://localhost:3000");
    const response = await fetch(`${coreBaseUrl}/internal/tasks/callback`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": getEnv("INTERNAL_API_SECRET", "dev-internal-secret")
      },
      body: JSON.stringify(command)
    });

    if (!response.ok) {
      throw new BadGatewayException({
        message: `Core service failed with ${response.status}`,
        details: await readDownstreamError(response)
      });
    }

    const result = await response.json();
    log("info", "telephony callback task forwarded", {
      businessId: command.businessId,
      sourceCallId: command.sourceCallId,
      priority: command.priority
    });
    return result;
  }
}

@Module({
  controllers: [TelephonyController]
})
class TelephonyModule {}

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(TelephonyModule, new FastifyAdapter());
  app.useGlobalFilters(new ApiExceptionFilter("telephony"));
  const port = getPort("TELEPHONY_PORT", 3003);
  await app.listen(port, "0.0.0.0");
  log("info", "telephony service listening", { port });
}

await bootstrap();
