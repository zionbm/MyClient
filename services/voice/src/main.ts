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
    return health("voice", {
      stt: getEnv("GEMINI_STT_MODEL", "gemini-3.6-flash"),
      tts: getEnv("GEMINI_TTS_MODEL", "gemini-3.1-flash-tts-preview")
    });
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

  @Post("stt/gemini")
  async transcribeGemini(@Headers() headers: RequestHeaders, @Body() body: unknown) {
    const audio = requireAudio(body);
    const apiKey = getEnv("GEMINI_API_KEY");
    const model = getEnv("GEMINI_STT_MODEL", "gemini-3.6-flash");
    const contentType = headerValue(headers, "content-type") ?? "audio/mp4";
    const languageCode = headerValue(headers, "x-language-code") ?? "he-IL";

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                text:
                  "תמלל את קובץ האודיו לעברית. זו הקלטה של בעל עסק שמבקש ליצור משימה, לקוח, פגישה, עבודה או הערה במערכת CRM. " +
                  "החזר רק JSON תקין עם transcript ו-confidence. אל תוסיף הסברים."
              },
              {
                inlineData: {
                  mimeType: contentType,
                  data: audio.toString("base64")
                }
              }
            ]
          }
        ],
        generationConfig: {
          response_mime_type: "application/json",
          response_schema: {
            type: "OBJECT",
            required: ["transcript", "confidence"],
            properties: {
              transcript: { type: "STRING" },
              confidence: { type: "NUMBER" }
            }
          },
          speech_config: {
            languageCode
          }
        }
      })
    });

    const result = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: unknown;
    };
    if (!response.ok) {
      throw new BadGatewayException({
        message: `Gemini transcription failed with ${response.status}`,
        details: result
      });
    }

    const outputText = result.candidates?.flatMap((candidate) => candidate.content?.parts ?? []).find((part) => part.text)?.text;
    if (!outputText) {
      throw new BadGatewayException("Gemini transcription returned empty output");
    }

    const transcription = JSON.parse(outputText) as { transcript?: string; confidence?: number };
    if (!transcription.transcript?.trim()) {
      throw new BadGatewayException("Gemini transcription returned empty text");
    }

    log("info", "gemini stt completed", { model, languageCode, bytes: audio.byteLength });
    return {
      provider: "gemini",
      model,
      languageCode,
      transcript: transcription.transcript.trim(),
      confidence: transcription.confidence ?? 1,
      usage: result.usageMetadata
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

  @Post("tts/gemini")
  async synthesizeGemini(@Body() body: { text?: string; voice?: string; languageCode?: string }) {
    const text = body.text?.trim() || "שלום, הגעתם למזכירה הווירטואלית.";
    const apiKey = getEnv("GEMINI_API_KEY");
    const model = getEnv("GEMINI_TTS_MODEL", "gemini-3.1-flash-tts-preview");
    const voice = body.voice ?? getEnv("GEMINI_TTS_VOICE", "Kore");

    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        input: text,
        response_format: {
          type: "audio"
        },
        generation_config: {
          speech_config: [
            { voice }
          ]
        }
      })
    });

    const result = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
      output_audio?: { data?: string; mime_type?: string };
    };
    if (!response.ok) {
      throw new BadGatewayException({
        message: `Gemini TTS failed with ${response.status}`,
        details: result
      });
    }
    if (!result.output_audio?.data) {
      throw new BadGatewayException("Gemini TTS returned empty audio");
    }

    return {
      provider: "gemini",
      model,
      voice,
      text,
      audioMimeType: result.output_audio.mime_type ?? "audio/wav",
      audioBase64: result.output_audio.data,
      audioObjectUri: `data:${result.output_audio.mime_type ?? "audio/wav"};base64,${result.output_audio.data}`
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
