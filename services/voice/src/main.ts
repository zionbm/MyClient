import "reflect-metadata";
import { Body, Controller, Get, Module, Post } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ApiExceptionFilter, getPort, health, log, stableIdempotencyKey } from "@myclient/common";

@Controller()
class VoiceController {
  @Get("health")
  health() {
    return health("voice", { stt: "mock-google-stt", tts: "mock-google-tts-hebrew-chirp3-hd" });
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
  const app = await NestFactory.create<NestFastifyApplication>(VoiceModule, new FastifyAdapter());
  app.useGlobalFilters(new ApiExceptionFilter("voice"));
  const port = getPort("VOICE_PORT", 3002);
  await app.listen(port, "0.0.0.0");
  log("info", "voice service listening", { port });
}

await bootstrap();
