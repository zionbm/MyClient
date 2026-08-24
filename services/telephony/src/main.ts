import "reflect-metadata";
import { BadGatewayException, Body, Controller, Get, Module, Post } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ApiExceptionFilter, cloudRunServiceAuthHeaders, getEnv, getPort, health, log, stableIdempotencyKey } from "@myclient/common";
import type { CreateCallbackTask } from "@myclient/contracts";

type IvrDigit = "1" | "2" | "3";
type IncomingCallResult = {
  businessId: string;
  incomingCall: { id: string; plivoCallId: string };
  mode: string;
  prompt?: string;
  reason?: string;
  urgent?: boolean;
  nextWebhook?: string;
  maxSeconds?: number;
  finishOnKey?: string;
};

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
  async incoming(@Body() body: { businessId?: string; callId?: string; from?: string; to?: string; digit?: string }) {
    return this.createCoreIncomingCall({
      businessId: body.businessId,
      plivoCallId: this.requireCallId(body.callId),
      fromNumber: body.from,
      toNumber: this.requireToNumber(body.to),
      selectedDigit: this.normalizeDigit(body.digit)
    });
  }

  @Post("plivo/callback-request")
  async callbackRequest(@Body() body: { businessId?: string; callId: string; from?: string; to?: string }) {
    const incoming = await this.createCoreIncomingCall({
      businessId: body.businessId,
      plivoCallId: this.requireCallId(body.callId),
      fromNumber: body.from,
      toNumber: this.requireToNumber(body.to),
      selectedDigit: "1"
    });
    return this.createCoreCallbackTask({
      businessId: incoming.businessId,
      incomingCallId: incoming.incomingCall.id,
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
      callId: string;
      from?: string;
      to?: string;
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
    await this.createCoreIncomingCall({
      plivoCallId: this.requireCallId(body.callId),
      fromNumber: body.from,
      toNumber: this.requireToNumber(body.to),
      selectedDigit: body.urgent ? "3" : "2"
    });
    return this.createCoreRecording({
      plivoCallId: body.callId,
      transcript: stt.transcript,
      recordingUrl: body.recordingUrl,
      urgent: body.urgent,
      provider: "mock-google-stt",
      confidence: stt.transcript ? 0.99 : 0.75
    });
  }

  private normalizeDigit(digit: string | undefined): IvrDigit | undefined {
    return digit === "1" || digit === "2" || digit === "3" ? digit : undefined;
  }

  private requireCallId(callId: string | undefined): string {
    if (!callId) {
      return `mock_call_${crypto.randomUUID()}`;
    }
    return callId;
  }

  private requireToNumber(to: string | undefined): string {
    if (!to) {
      return getEnv("DEFAULT_MOCK_PLIVO_NUMBER", "+972000000000");
    }
    return to;
  }

  private async createCoreIncomingCall(command: {
    businessId?: string;
    plivoCallId: string;
    fromNumber?: string;
    toNumber: string;
    selectedDigit?: IvrDigit;
  }): Promise<IncomingCallResult> {
    const coreBaseUrl = getEnv("CORE_BASE_URL", "http://localhost:3000");
    const response = await fetch(`${coreBaseUrl}/internal/telephony/incoming`, {
      method: "POST",
      headers: {
        ...(await cloudRunServiceAuthHeaders(coreBaseUrl)),
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

    return (await response.json()) as IncomingCallResult;
  }

  private async createCoreRecording(command: {
    plivoCallId: string;
    transcript?: string;
    recordingUrl?: string;
    urgent?: boolean;
    provider: string;
    confidence?: number;
  }) {
    const coreBaseUrl = getEnv("CORE_BASE_URL", "http://localhost:3000");
    const response = await fetch(`${coreBaseUrl}/internal/telephony/recording`, {
      method: "POST",
      headers: {
        ...(await cloudRunServiceAuthHeaders(coreBaseUrl)),
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

    return response.json();
  }

  private async createCoreCallbackTask(command: CreateCallbackTask) {
    const coreBaseUrl = getEnv("CORE_BASE_URL", "http://localhost:3000");
    const response = await fetch(`${coreBaseUrl}/internal/tasks/callback`, {
      method: "POST",
      headers: {
        ...(await cloudRunServiceAuthHeaders(coreBaseUrl)),
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
