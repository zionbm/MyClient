import "reflect-metadata";
import { BadGatewayException, Body, Controller, Get, Headers, Module, Post, UnauthorizedException } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ApiExceptionFilter, configureHttpObservability, getEnv, getInternalApiSecret, getPort, health, log, stableIdempotencyKey } from "@myclient/common";
import { ACTION_TYPES, AiActionBatchSchema, type AiAction } from "@myclient/contracts";

type RequestHeaders = Record<string, string | string[] | undefined>;

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

function headerValue(headers: RequestHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()] ?? headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function requireInternalSecret(headers: RequestHeaders): void {
  if (headerValue(headers, "x-internal-secret") !== getInternalApiSecret()) {
    throw new UnauthorizedException("Missing or invalid internal secret");
  }
}

@Controller()
class AiController {
  @Get("health")
  health() {
    return health("ai", { llm: getEnv("OPENAI_LLM_MODEL", "gpt-5-mini") });
  }

  @Post("intent/parse")
  async parseIntent(@Headers() headers: RequestHeaders, @Body() body: { text?: string; businessId?: string; userId?: string; idempotencyKey?: string }) {
    requireInternalSecret(headers);
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
              "אם המשתמש מבקש תזכורת או לחזור למישהו, השתמש ב-CREATE_REMINDER. " +
              "כאשר מוזכר לקוח קיים, חלץ תמיד את שמו לשדה customerName גם אם השם כבר מופיע בתוך title. אל תמציא customerId. " +
              "הבחן בין פעולות על פגישה: 'סגור', 'סיים' או 'הפגישה בוצעה' הם COMPLETE_APPOINTMENT; 'בטל' הוא CANCEL_APPOINTMENT; ורק 'קבע', 'צור' או 'הוסף פגישה' הם CREATE_APPOINTMENT. " +
              "בפעולה על פגישה קיימת החזר customerName וכל פרט מזהה שנאמר, ואל תהפוך אותה ליצירת פגישה חדשה כאשר הרשומה לא ידועה לך. " +
              "אם המשתמש מבקש ביקור בית, התקנה או הגעה לכתובת, השתמש ב-CREATE_HOME_VISIT והכנס כתובת לשדה location. " +
              "אם המשתמש מבקש הצעת מחיר, השתמש ב-CREATE_QUOTE, הכנס את נושא העבודה לשדה title, והכנס סכום ל-estimatedAmount אם נאמר סכום. לדוגמה 'על התקנה של 5 דלתות' חייב להיות title ולא description בלבד. " +
              "השתמש בשמות שדות שתואמים לפעולות השרת: location ו-notes לביקור/פגישה, description למשימה/הצעה, address לכתובת לקוח. " +
              "כל שדה זמן כמו dueAt, startsAt או endsAt חייב להיות ISO datetime בלבד, למשל 2026-08-25T14:30:00+03:00. אל תחזיר תאריך טבעי כמו 'יום רביעי בשעה 14:00' בתוך payload. כאשר המשתמש אומר זמן יחסי כמו 'עוד 10 דקות' או 'בעוד שעה', חשב אותו ביחס לזמן הנוכחי ואל תבחר שעה שרירותית. " +
              "לתזכורת ללא מועד בכלל, או ללא מועד מדויק כמו 'מאוחר יותר' או 'בהמשך', צור CREATE_REMINDER בלי dueAt ובלי requiresConfirmation. " +
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
                        enum: ACTION_TYPES
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
                          status: { type: "string" },
                          name: { type: "string" },
                          phone: { type: "string" },
                          email: { type: "string" },
                          address: { type: "string" },
                          customerId: { type: "string" },
                          customerName: { type: "string" },
                          startsAt: { type: "string" },
                          endsAt: { type: "string" },
                          location: { type: "string" },
                          notes: { type: "string" },
                          text: { type: "string" },
                          reminderId: { type: "string" },
                          appointmentId: { type: "string" },
                          homeVisitId: { type: "string" },
                          quoteId: { type: "string" },
                          estimatedAmount: { type: ["number", "string"] },
                          sourceCustomerId: { type: "string" },
                          targetCustomerId: { type: "string" },
                          itemType: { type: "string", enum: ["reminder", "home_visit", "appointment", "quote", "note"] },
                          itemId: { type: "string" }
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
        type: "CREATE_REMINDER",
        idempotencyKey,
        confidence: 0.2,
        requiresConfirmation: false,
        missingFields: ["text"],
        payload: {}
      }];
    }

    const appointmentCustomerName = text.match(/עם\s+(.+?)(?:[.!?]|$)/)?.[1]?.trim() ??
      text.match(/(?:של|אצל)\s+(.+?)(?:[.!?]|$)/)?.[1]?.trim();
    if (/(?:תסגור|סגור|סיים|סיימתי).*פגישה|פגישה.*(?:בוצעה|הסתיימה)/.test(text)) {
      return [{
        type: "COMPLETE_APPOINTMENT",
        idempotencyKey,
        confidence: 0.9,
        requiresConfirmation: false,
        missingFields: ["appointmentId"],
        payload: appointmentCustomerName ? { customerName: appointmentCustomerName } : {}
      }];
    }

    if (/(?:תבטל|בטל).*פגישה/.test(text)) {
      return [{
        type: "CANCEL_APPOINTMENT",
        idempotencyKey,
        confidence: 0.9,
        requiresConfirmation: true,
        missingFields: ["appointmentId"],
        payload: appointmentCustomerName ? { customerName: appointmentCustomerName } : {}
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

    if (text.includes("תזכורת") || text.includes("תזכיר") || text.includes("להתקשר")) {
      const customerName = text.match(/להתקשר\s+ל(.+?)(?:\s+(?:עוד|בעוד|מחר|היום|בשעה)|[.!?]|$)/)?.[1]?.trim();
      return [{
        type: "CREATE_REMINDER",
        idempotencyKey,
        confidence: 0.88,
        requiresConfirmation: false,
        missingFields: [],
        payload: {
          title: customerName ? `להתקשר ל${customerName}` : text,
          ...(customerName ? { customerName } : {})
        }
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
              type: "CREATE_REMINDER",
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
      type: "CREATE_REMINDER",
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
  const adapter = new FastifyAdapter();
  const app = await NestFactory.create<NestFastifyApplication>(AiModule, adapter);
  configureHttpObservability(adapter.getInstance(), "ai");
  app.useGlobalFilters(new ApiExceptionFilter("ai"));
  const port = getPort("AI_PORT", 3001);
  await app.listen(port, "0.0.0.0");
  log("info", "ai service listening", { port });
}

await bootstrap();
