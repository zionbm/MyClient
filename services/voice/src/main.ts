import "reflect-metadata";
import { BadGatewayException, BadRequestException, Body, Controller, Get, Headers, Module, Post } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ApiExceptionFilter, getEnv, getPort, health, log, stableIdempotencyKey } from "@myclient/common";

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

@Controller()
class VoiceController {
  @Get("health")
  health() {
    return health("voice", { stt: "openai", tts: "mock-google-tts-hebrew-chirp3-hd" });
  }

  @Post("stt/mock")
  transcribe(@Body() body: { transcript?: string; recordingUrl?: string; languageCode?: string }) {
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
    const audio = requireAudio(body);
    const apiKey = getEnv("OPENAI_API_KEY");
    const model = getEnv("OPENAI_STT_MODEL", "gpt-4o-mini-transcribe");
    const contentType = headerValue(headers, "content-type") ?? "audio/mp4";
    const filename = headerValue(headers, "x-audio-filename") ?? "owner-command.m4a";
    const languageCode = headerValue(headers, "x-language-code") ?? "he-IL";
    const audioBuffer = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer;

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
      throw new BadGatewayException({
        message: `OpenAI transcription failed with ${response.status}`,
        details: result
      });
    }
    if (!result.text?.trim()) {
      throw new BadGatewayException("OpenAI transcription returned empty text");
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

  @Post("tts/mock")
  synthesize(@Body() body: { text?: string; voice?: string }) {
    const text = body.text ?? "שלום, הגעתם למזכירה הווירטואלית.";
    return {
      provider: "mock-google-tts",
      voice: body.voice ?? "he-IL-Chirp3-HD",
      text,
      audioObjectUri: `mock://tts/${stableIdempotencyKey("tts", text)}`
    };
  }
}

@Module({
  controllers: [VoiceController]
})
class VoiceModule {}

async function bootstrap() {
  const adapter = new FastifyAdapter();
  const app = await NestFactory.create<NestFastifyApplication>(VoiceModule, adapter);
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
