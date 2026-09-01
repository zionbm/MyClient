import "reflect-metadata";
import { BadGatewayException, BadRequestException, Body, Controller, Get, Headers, Module, Post, UnauthorizedException } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ApiExceptionFilter, configureHttpObservability, getEnv, getInternalApiSecret, getPort, health, log, stableIdempotencyKey } from "@myclient/common";

type RequestHeaders = Record<string, string | string[] | undefined>;

function headerValue(headers: RequestHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()] ?? headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function requireAudio(body: unknown): Buffer {
  if (!Buffer.isBuffer(body) || body.byteLength === 0) {
    throw new BadRequestException("Audio body is required");
  }
  return body;
}

function requireInternalSecret(headers: RequestHeaders): void {
  if (headerValue(headers, "x-internal-secret") !== getInternalApiSecret()) {
    throw new UnauthorizedException("Missing or invalid internal secret");
  }
}

@Controller()
class VoiceController {
  @Get("health")
  health() {
    return health("voice", { stt: "openai", tts: getEnv("MOCK_TTS_PROVIDER", "true") === "true" ? "mock" : "openai" });
  }

  @Post("stt/mock")
  transcribe(@Headers() headers: RequestHeaders, @Body() body: { transcript?: string; recordingUrl?: string; languageCode?: string }) {
    requireInternalSecret(headers);
    const transcript = body.transcript?.trim() || "תמלול לדוגמה: הלקוח ביקש שתחזור אליו.";
    const result = {
      provider: "mock-google-stt",
      languageCode: body.languageCode ?? "he-IL",
      recordingUrl: body.recordingUrl,
      transcript,
      confidence: body.transcript ? 0.99 : 0.75
    };
    log("info", "mock stt completed", { recordingUrl: body.recordingUrl, confidence: result.confidence });
    return result;
  }

  @Post("stt/openai")
  async transcribeOpenAi(@Headers() headers: RequestHeaders, @Body() body: unknown) {
    requireInternalSecret(headers);
    const audio = requireAudio(body);
    const apiKey = getEnv("OPENAI_API_KEY");
    const configuredModel = getEnv("OPENAI_STT_MODEL", "gpt-4o-mini-transcribe");
    const contentType = headerValue(headers, "content-type") ?? "audio/mp4";
    const filename = headerValue(headers, "x-audio-filename") ?? "owner-command.m4a";
    const languageCode = headerValue(headers, "x-language-code") ?? "he-IL";
    const audioBuffer = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer;
    const models = configuredModel === "whisper-1" ? [configuredModel] : [configuredModel, "whisper-1"];

    let lastFailure: { status: number; result: unknown; model: string } | null = null;
    for (const model of models) {
      const form = new FormData();
      form.append("file", new Blob([audioBuffer], { type: contentType }), filename);
      form.append("model", model);
      form.append("language", languageCode.startsWith("he") ? "he" : languageCode);

      const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`
        },
        body: form
      });

      const result = (await response.json().catch(() => ({}))) as { text?: string; error?: { message?: string }; usage?: unknown };
      if (!response.ok) {
        lastFailure = { status: response.status, result, model };
        log("error", "openai stt failed", {
          model,
          status: response.status,
          languageCode,
          contentType,
          filename,
          bytes: audio.byteLength,
          message: result.error?.message
        });
        continue;
      }
      if (!result.text?.trim()) {
        lastFailure = { status: 502, result: { message: "empty transcript" }, model };
        log("error", "openai stt returned empty text", {
          model,
          languageCode,
          contentType,
          filename,
          bytes: audio.byteLength
        });
        continue;
      }

      log("info", "openai stt completed", { model, languageCode, bytes: audio.byteLength });
      return {
        provider: "openai",
        model,
        languageCode,
        transcript: result.text.trim(),
        confidence: 1,
        usage: result.usage
      };
    }

    throw new BadGatewayException({
      message: `OpenAI transcription failed with ${lastFailure?.status ?? 502}`,
      details: lastFailure
    });
  }

  @Post("tts/mock")
  synthesize(@Headers() headers: RequestHeaders, @Body() body: { text?: string; voice?: string }) {
    requireInternalSecret(headers);
    const text = body.text ?? "שלום, הגעתם למזכירה הווירטואלית.";
    return {
      provider: "mock-google-tts",
      voice: body.voice ?? "he-IL-Chirp3-HD",
      text,
      audioObjectUri: `mock://tts/${stableIdempotencyKey("tts", text)}`
    };
  }

  @Post("tts")
  synthesizeConfigured(@Headers() headers: RequestHeaders, @Body() body: { text?: string; voice?: string }) {
    return getEnv("MOCK_TTS_PROVIDER", "true") === "true"
      ? this.synthesize(headers, body)
      : this.synthesizeOpenAi(headers, body);
  }

  @Post("tts/openai")
  async synthesizeOpenAi(@Headers() headers: RequestHeaders, @Body() body: { text?: string; voice?: string }) {
    requireInternalSecret(headers);
    const startedAt = Date.now();
    const text = body.text?.trim();
    if (!text) throw new BadRequestException("TTS text is required");
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { authorization: `Bearer ${getEnv("OPENAI_API_KEY")}`, "content-type": "application/json" },
      body: JSON.stringify({ model: getEnv("OPENAI_TTS_MODEL", "gpt-4o-mini-tts"), voice: body.voice ?? getEnv("OPENAI_TTS_VOICE", "marin"), input: text, instructions: "דבר בעברית ישראלית טבעית, ברורה וקצרה." })
    });
    if (!response.ok) throw new BadGatewayException(`OpenAI TTS failed with ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    log("info", "openai tts completed", { model: getEnv("OPENAI_TTS_MODEL", "gpt-4o-mini-tts"), voice: body.voice ?? getEnv("OPENAI_TTS_VOICE", "marin"), bytes: bytes.byteLength, durationMs: Date.now() - startedAt });
    return { provider: "openai", text, contentType: "audio/mpeg", audioBase64: bytes.toString("base64") };
  }
}

@Module({
  controllers: [VoiceController]
})
class VoiceModule {}

async function bootstrap() {
  const adapter = new FastifyAdapter();
  const app = await NestFactory.create<NestFastifyApplication>(VoiceModule, adapter);
  configureHttpObservability(adapter.getInstance(), "voice");
  adapter.getInstance().addContentTypeParser(
    ["audio/mp4", "audio/m4a", "audio/aac", "application/octet-stream"],
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body)
  );
  app.useGlobalFilters(new ApiExceptionFilter("voice"));
  const port = getPort("VOICE_PORT", 3002);
  await app.listen(port, "0.0.0.0");
  log("info", "voice service listening", { port });
}

await bootstrap();
