import "reflect-metadata";
import { BadGatewayException, Body, Controller, Get, Module, Post } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ApiExceptionFilter, getEnv, getPort, health, log, stableIdempotencyKey } from "@myclient/common";
import type { AiAction } from "@myclient/contracts";

@Controller()
class AiController {
  @Get("health")
  health() {
    return health("ai", { llm: getEnv("GEMINI_LLM_MODEL", "gemini-3.6-flash") });
  }

  @Post("intent/parse")
  async parseIntent(@Body() body: { text?: string; businessId?: string; userId?: string; idempotencyKey?: string }) {
    const text = (body.text ?? "").trim();
    const idempotencyKey = body.idempotencyKey ?? stableIdempotencyKey("ai", `${body.businessId}:${body.userId}:${text}`);

    const action = getEnv("MOCK_LLM_PROVIDER", "false") === "true"
      ? this.mockAction(text, idempotencyKey)
      : await this.geminiAction(text, idempotencyKey);
    log("info", "intent parsed", { businessId: body.businessId, actionType: action.type });
    return { provider: getEnv("MOCK_LLM_PROVIDER", "false") === "true" ? "mock-gemini" : "gemini", action };
  }

  private async geminiAction(text: string, idempotencyKey: string): Promise<AiAction> {
    const apiKey = getEnv("GEMINI_API_KEY");
    const model = getEnv("GEMINI_LLM_MODEL", "gemini-3.6-flash");
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text:
                "אתה ממיר פקודות קוליות של בעל עסק בעברית ל-JSON פעולה עבור שרת CRM. " +
                "החזר רק פעולה אחת. אם המשתמש מבקש תזכורת, משימה או לחזור למישהו, השתמש ב-CREATE_TASK. " +
                "אם חסר מידע קריטי, מלא missingFields. אל תמציא מספרי טלפון או לקוחות."
            }
          ]
        },
        contents: [
          {
            role: "user",
            parts: [{ text: `idempotencyKey: ${idempotencyKey}\nפקודה: ${text}` }]
          }
        ],
        generationConfig: {
          response_mime_type: "application/json",
          response_schema: {
            type: "OBJECT",
            required: ["type", "idempotencyKey", "confidence", "requiresConfirmation", "missingFields", "payload"],
            properties: {
              type: {
                type: "STRING",
                enum: [
                  "CREATE_CUSTOMER",
                  "UPDATE_CUSTOMER",
                  "CREATE_JOB",
                  "UPDATE_JOB",
                  "CREATE_APPOINTMENT",
                  "UPDATE_APPOINTMENT",
                  "CANCEL_APPOINTMENT",
                  "CREATE_TASK",
                  "UPDATE_TASK",
                  "COMPLETE_TASK",
                  "ADD_CUSTOMER_NOTE"
                ]
              },
              idempotencyKey: { type: "STRING" },
              confidence: { type: "NUMBER" },
              requiresConfirmation: { type: "BOOLEAN" },
              missingFields: { type: "ARRAY", items: { type: "STRING" } },
              payload: {
                type: "OBJECT",
                properties: {
                  title: { type: "STRING" },
                  description: { type: "STRING" },
                  dueAt: { type: "STRING" },
                  priority: { type: "STRING", enum: ["NORMAL", "URGENT"] },
                  name: { type: "STRING" },
                  phone: { type: "STRING" },
                  customerId: { type: "STRING" },
                  startsAt: { type: "STRING" },
                  endsAt: { type: "STRING" },
                  text: { type: "STRING" }
                }
              }
            }
          }
        }
      })
    });

    const result = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    if (!response.ok) {
      throw new BadGatewayException({
        message: `Gemini LLM failed with ${response.status}`,
        details: result
      });
    }

    const outputText = result.candidates?.flatMap((candidate) => candidate.content?.parts ?? []).find((part) => part.text)?.text;
    if (!outputText) {
      throw new BadGatewayException("Gemini LLM returned empty output");
    }

    const action = JSON.parse(outputText) as AiAction;
    return {
      ...action,
      idempotencyKey
    };
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
