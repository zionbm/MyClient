import "reflect-metadata";
import { BadGatewayException, Body, Controller, Get, Module, Post } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ApiExceptionFilter, getEnv, getPort, health, log, stableIdempotencyKey } from "@myclient/common";
import { AiActionBatchSchema, type AiAction } from "@myclient/contracts";

type AiIntent = {
  actions: AiAction[];
};

function normalizeActions(intent: AiIntent, idempotencyKey: string): AiAction[] {
  const actions = intent.actions.map((action, index) => ({
    ...action,
    payload: action.payload ?? {},
    missingFields: action.missingFields ?? [],
    requiresConfirmation: action.requiresConfirmation ?? false,
    idempotencyKey: intent.actions.length === 1 ? idempotencyKey : `${idempotencyKey}:${index + 1}`
  }));
  return AiActionBatchSchema.parse({ actions }).actions;
}

function parseMockCustomerPayload(text: string): Record<string, unknown> {
  const name = text.match(/בשם\s+([^,]+)/)?.[1]?.trim();
  const phone = text.match(/(?:טלפון|מספר טלפון)\s+([0-9+\-\s]+)/)?.[1]?.trim();
  return {
    ...(name ? { name } : { rawText: text }),
    ...(phone ? { phone } : {})
  };
}

@Controller()
class AiController {
  @Get("health")
  health() {
    return health("ai", { llm: getEnv("OPENAI_LLM_MODEL", "gpt-5-mini") });
  }

  @Post("intent/parse")
  async parseIntent(@Body() body: { text?: string; businessId?: string; userId?: string; idempotencyKey?: string }) {
    const text = (body.text ?? "").trim();
    const idempotencyKey = body.idempotencyKey ?? stableIdempotencyKey("ai", `${body.businessId}:${body.userId}:${text}`);

    const actions = getEnv("MOCK_LLM_PROVIDER", "false") === "true"
      ? this.mockActions(text, idempotencyKey)
      : await this.openAiActions(text, idempotencyKey);
    log("info", "intent parsed", { businessId: body.businessId, actionTypes: actions.map((action) => action.type) });
    return {
      provider: getEnv("MOCK_LLM_PROVIDER", "false") === "true" ? "mock-gemini" : "openai",
      action: actions[0],
      actions
    };
  }

  private async openAiActions(text: string, idempotencyKey: string): Promise<AiAction[]> {
    const apiKey = getEnv("OPENAI_API_KEY");
    const model = getEnv("OPENAI_LLM_MODEL", "gpt-5-mini");
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: "system",
            content:
              "אתה ממיר פקודות קוליות של בעל עסק בעברית ל-JSON פעולה עבור שרת CRM. " +
              "החזר מערך actions לפי סדר הביצוע. אם המשתמש מבקש כמה דברים באותו משפט, החזר כמה פעולות. " +
              "אם המשתמש מבקש תזכורת, משימה או לחזור למישהו, השתמש ב-CREATE_TASK. " +
              "לתזכורת ללא מועד בכלל, או ללא מועד מדויק כמו 'מאוחר יותר' או 'בהמשך', צור CREATE_TASK בלי dueAt ובלי requiresConfirmation. " +
              "אם פעולה מאוחרת מתייחסת ללקוח שנוצר בפעולה קודמת, כלול name ו-phone בפעולה המאוחרת כשאפשר. " +
              "מספר טלפון של לקוח הוא אופציונלי: אם המשתמש לא אמר מספר טלפון, אל תוסיף phone ל-missingFields ואל תדרוש אישור בגלל זה. " +
              "מותר ליצור לקוח ותזכורת חזרה גם בלי מספר טלפון. " +
              "אם חסר מידע קריטי, מלא missingFields. אל תמציא מספרי טלפון או לקוחות."
          },
          {
            role: "user",
            content: `idempotencyKey: ${idempotencyKey}\nפקודה: ${text}`
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "ai_action",
            strict: false,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["actions"],
              properties: {
                actions: {
                  type: "array",
                  minItems: 1,
                  maxItems: 5,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["type", "idempotencyKey", "confidence", "requiresConfirmation", "missingFields", "payload"],
                    properties: {
                      type: {
                        type: "string",
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
                      idempotencyKey: { type: "string" },
                      confidence: { type: "number", minimum: 0, maximum: 1 },
                      requiresConfirmation: { type: "boolean" },
                      missingFields: { type: "array", items: { type: "string" } },
                      payload: {
                        type: "object",
                        additionalProperties: true,
                        properties: {
                          title: { type: "string" },
                          description: { type: "string" },
                          dueAt: { type: "string" },
                          priority: { type: "string", enum: ["NORMAL", "URGENT"] },
                          name: { type: "string" },
                          phone: { type: "string" },
                          customerId: { type: "string" },
                          startsAt: { type: "string" },
                          endsAt: { type: "string" },
                          text: { type: "string" }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      })
    });

    const result = (await response.json().catch(() => ({}))) as {
      output_text?: string;
      error?: { message?: string };
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    if (!response.ok) {
      throw new BadGatewayException({
        message: `OpenAI LLM failed with ${response.status}`,
        details: result
      });
    }

    const outputText = result.output_text ?? result.output?.flatMap((item) => item.content ?? []).find((content) => content.text)?.text;
    if (!outputText) {
      throw new BadGatewayException("OpenAI LLM returned empty output");
    }

    return normalizeActions(JSON.parse(outputText) as AiIntent, idempotencyKey);
  }

  private mockActions(text: string, idempotencyKey: string): AiAction[] {
    if (!text) {
      return [{
        type: "CREATE_TASK",
        idempotencyKey,
        confidence: 0.2,
        requiresConfirmation: false,
        missingFields: ["text"],
        payload: {}
      }];
    }

    if (text.includes("פגישה") || text.toLowerCase().includes("appointment")) {
      return [{
        type: "CREATE_APPOINTMENT",
        idempotencyKey,
        confidence: 0.72,
        requiresConfirmation: true,
        missingFields: ["startsAt"],
        payload: { title: text }
      }];
    }

    if (text.includes("לקוח") || text.toLowerCase().includes("customer")) {
      const action: AiAction = {
        type: "CREATE_CUSTOMER",
        idempotencyKey,
        confidence: 0.68,
        requiresConfirmation: false,
        missingFields: text.match(/בשם\s+([^,]+)/) ? [] : ["name"],
        payload: parseMockCustomerPayload(text)
      };
      return text.includes("תזכיר") || text.includes("להתקשר")
        ? [
            { ...action, idempotencyKey: `${idempotencyKey}:1` },
            {
              type: "CREATE_TASK",
              idempotencyKey: `${idempotencyKey}:2`,
              confidence: 0.7,
              requiresConfirmation: false,
              missingFields: [],
              payload: {
                ...parseMockCustomerPayload(text),
                title: text.includes("להתקשר") ? `להתקשר ל${parseMockCustomerPayload(text).name ?? "לקוח"} מאוחר יותר` : text
              }
            }
          ]
        : [action];
    }

    return [{
      type: "CREATE_TASK",
      idempotencyKey,
      confidence: 0.82,
      requiresConfirmation: false,
      missingFields: [],
      payload: {
        title: text,
        description: `Created from owner command: ${text}`
      }
    }];
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
