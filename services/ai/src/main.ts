import "reflect-metadata";
import { BadGatewayException, Body, Controller, Get, Headers, Module, Post, UnauthorizedException } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ApiExceptionFilter, configureHttpObservability, getEnv, getInternalApiSecret, getPort, health, log } from "@myclient/common";
import {
  AssistantPlanSchema,
  ASSISTANT_TOOL_NAMES,
  type AssistantPlan
} from "@myclient/contracts";
import { normalizeAssistantPlan } from "./v2-assistant-plan.js";

type RequestHeaders = Record<string, string | string[] | undefined>;

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

  @Post("v2/assistant/plan")
  async planV2(@Headers() headers: RequestHeaders, @Body() body: { transcript?: string; context?: unknown }) {
    requireInternalSecret(headers);
    const startedAt = Date.now();
    const transcript = (body.transcript ?? "").trim();
    const mock = getEnv("MOCK_LLM_PROVIDER", "false") === "true";
    const plan = mock
      ? this.mockV2Plan(transcript)
      : await this.openAiV2Plan(transcript, body.context);
    log("info", "v2 assistant plan completed", { provider: mock ? "mock" : "openai", model: mock ? undefined : getEnv("OPENAI_LLM_MODEL", "gpt-5-mini"), stepCount: plan.steps.length, durationMs: Date.now() - startedAt });
    return {
      provider: mock ? "mock" : "openai",
      plan: AssistantPlanSchema.parse(plan)
    };
  }

  @Post("v2/assistant/summarize")
  async summarizeV2(@Headers() headers: RequestHeaders, @Body() body: { transcript?: string; receipt?: unknown }) {
    requireInternalSecret(headers);
    const startedAt = Date.now();
    if (getEnv("MOCK_LLM_PROVIDER", "false") === "true") {
      log("info", "v2 assistant summary completed", { provider: "mock", durationMs: Date.now() - startedAt });
      return { textSummary: "הבקשה טופלה לפי התוצאה המוצגת.", spokenSummary: "הבקשה טופלה." };
    }
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${getEnv("OPENAI_API_KEY")}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: getEnv("OPENAI_LLM_MODEL", "gpt-5-mini"),
        input: [
          { role: "system", content: "נסח סיכום עברי טבעי וקצר אך ורק לפי קבלת הביצוע. אסור להוסיף פעולה, ישות, סכום או תוצאה שאינם בקבלה. אין להציג למשתמש UUID, מזהה פנימי או pendingActionId. חובה לכלול כל warning שמופיע בקבלה, ובפרט קביעה מחוץ לשעות העבודה." },
          { role: "user", content: `תמלול: ${body.transcript ?? ""}\nקבלה: ${JSON.stringify(body.receipt ?? {})}` }
        ],
        text: { format: { type: "json_schema", name: "assistant_summary_v2", strict: true, schema: { type: "object", additionalProperties: false, required: ["textSummary", "spokenSummary"], properties: { textSummary: { type: "string" }, spokenSummary: { type: "string" } } } } }
      })
    });
    const result = (await response.json().catch(() => ({}))) as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
    if (!response.ok) throw new BadGatewayException(`OpenAI V2 summary failed with ${response.status}`);
    const text = result.output_text ?? result.output?.flatMap((item) => item.content ?? []).find((content) => content.text)?.text;
    if (!text) throw new BadGatewayException("OpenAI V2 summary returned empty output");
    log("info", "v2 assistant summary completed", { provider: "openai", model: getEnv("OPENAI_LLM_MODEL", "gpt-5-mini"), durationMs: Date.now() - startedAt });
    return JSON.parse(text) as { textSummary: string; spokenSummary: string };
  }

  private mockV2Plan(transcript: string): AssistantPlan {
    if (transcript.includes("זמינ") || transcript.includes("פנוי")) {
      return {
        version: "2",
        requestKind: "QUESTION",
        language: "he-IL",
        extractedFacts: {},
        steps: [{
          stepId: "availability",
          kind: "READ",
          tool: "GET_AVAILABILITY",
          dependsOn: [],
          input: { date: new Date().toISOString().slice(0, 10), durationMinutes: 60 },
          confidence: 0.8,
          requiresExplicitConfirmation: false
        }]
      };
    }
    if (transcript.includes("הפעילות הבאה") || transcript.includes("מה הבא")) {
      const from = new Date();
      const to = new Date(from.getTime() + 30 * 24 * 60 * 60 * 1000);
      return {
        version: "2",
        requestKind: "QUESTION",
        language: "he-IL",
        extractedFacts: {},
        steps: [{
          stepId: "next_activity",
          kind: "READ",
          tool: "GET_SCHEDULE",
          dependsOn: [],
          input: { from: from.toISOString(), to: to.toISOString(), limit: 1 },
          confidence: 0.9,
          requiresExplicitConfirmation: false
        }]
      };
    }
    const customerName = transcript.match(/(?:לקוח\s+)?בשם\s+(.+?)(?=\s+ו(?:תזכיר|תוסיף|תיצר|תיצור)|[,.;]|$)/)?.[1]?.trim();
    const taskText = transcript.match(/(?:תזכירי?\s+לי|תוסיף(?:י)?\s+משימה)\s+(.+?)(?:[.;]|$)/)?.[1]?.trim();
    const steps: AssistantPlan["steps"] = [];
    if (customerName) {
      steps.push({
        stepId: "create_customer",
        kind: "WRITE",
        tool: "CREATE_CUSTOMER",
        dependsOn: [],
        input: { name: customerName },
        confidence: 0.95,
        requiresExplicitConfirmation: false
      });
    }
    if (taskText) {
      steps.push({
        stepId: "create_task",
        kind: "WRITE",
        tool: "CREATE_TASK",
        dependsOn: customerName ? ["create_customer"] : [],
        input: {
          title: taskText,
          ...(customerName ? { customerRef: { stepId: "create_customer", outputField: "entityId" } } : {})
        },
        confidence: 0.9,
        requiresExplicitConfirmation: false
      });
    }
    if (steps.length === 0) {
      steps.push({
        stepId: "clarify_request",
        kind: "CLARIFY",
        tool: "ASK_CLARIFICATION",
        dependsOn: [],
        input: { question: "מה תרצה שאוסיף?" },
        confidence: 1,
        requiresExplicitConfirmation: false
      });
    }
    return {
      version: "2",
      requestKind: "ACTION",
      language: "he-IL",
      extractedFacts: { ...(customerName ? { customerName } : {}), ...(taskText ? { taskText } : {}) },
      steps
    };
  }

  private async openAiV2Plan(transcript: string, context: unknown): Promise<AssistantPlan> {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${getEnv("OPENAI_API_KEY")}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: getEnv("OPENAI_LLM_MODEL", "gpt-5-mini"),
        input: [
          {
            role: "system",
            content:
              "אתה מתכנן פעולות עבור MyClient V2. החזר AssistantPlan בעברית he-IL בלבד. " +
              "תכנן רק כלים מתוך ה-allowlist. לפני שינוי ישות קיימת השתמש ב-FIND_CUSTOMERS וב-FIND_TASKS/FIND_JOBS/FIND_VISITS לפי הצורך, ואז העבר entityRef מובנה לשלב הכתיבה. כאשר המשתמש מבקש במפורש ליצור לקוח חדש, צור אותו ישירות ואל תחפש לקוח קיים לפני היצירה. " +
              "יצירה רגילה, עדכון, השלמה, ביטול ודיווח סיום אינם דורשים אישור נוסף. מחיקה, מיזוג, Undo ועקיפת התנגשות דורשים requiresExplicitConfirmation=true. " +
              "חוזי input מדויקים: CREATE/UPDATE_CUSTOMER משתמשים ב-name,email,generalNotes; ADD_CUSTOMER_PHONE משתמש ב-customerId או customerRef וב-phone,label,isPrimary; ADD_SERVICE_ADDRESS משתמש ב-customerId או customerRef וב-addressText,label; CREATE/UPDATE_TASK משתמשים ב-customerId או customerRef וב-title,description,dueAt; CREATE/UPDATE_JOB ו-CREATE/UPDATE_VISIT משתמשים ב-customerId או customerRef וב-title,description,startsAt,endsAt,serviceAddressId,locationSnapshot; SET_ACTIVITY_AMOUNT משתמש ב-entityId או entityRef וב-totalAmount,paidAmount; ADD_PAYMENT משתמש ב-entityId או entityRef וב-amount. אל תשתמש ב-scheduledStart, scheduledEnd או amount במקום totalAmount. " +
              "לקוח חדש דורש name בלבד; Task דורשת title בלבד; Job/Visit דורשים לקוח ו-title. אל תניח שהיה או לא היה חיוב בסיום פעילות. " +
              "אל תשאל על שדות אופציונליים שלא נמסרו. בפרט, שעה ו-dueAt אופציונליים ב-Task: אם נאמר יום יחסי ללא שעה, אל תעכב את היצירה כדי לבקש שעה; אפשר ליצור ללא dueAt ולשמר את ניסוח היום ב-description. " +
              "ב-Job/Visit, כאשר המשתמש אומר טווח מפורש של התחלה וסיום החזר את שניהם. כאשר נאמרה רק שעת התחלה החזר startsAt בלבד ואל תמציא endsAt; Core יחיל ברירת מחדל דטרמיניסטית של שעתיים ל-Job ושעה ל-Visit. " +
              "פתור ביטויי זמן רק לפי environment.now, environment.timezone ו-environment.workingHours שב-context: מחר הוא היום הקלנדרי הבא; יום בשבוע הוא המופע העתידי הקרוב; שעה שכבר חלפה היום דורשת clarification לגבי מחר; זמן מפורש בעבר אינו מוזז. החזר זמנים כ-ISO עם offset. " +
              "GET_AVAILABILITY דורש date בפורמט YYYY-MM-DD ו-durationMinutes. GET_SCHEDULE דורש from ו-to כ-ISO datetime; לשאלת הפעילות הבאה הוסף limit=1. " +
              "אם שלב תלוי בישות שנמצאה או נוצרה בשלב קודם, הוסף את stepId ל-dependsOn והשתמש ב-customerRef או entityRef עם אותו stepId ו-outputField=entityId בלבד. אין להפנות לשלב מאוחר או לשלב שאינו מחזיר ישות. " +
              "אם context כולל readResults, זהו סבב שני: השתמש ב-entityId הקונקרטי שבתוצאות, אל תחזיר שוב את שלב הקריאה ואל תפנה ב-dependsOn או Ref ל-stepId חיצוני שאינו בתוכנית החדשה. " +
              "אם context כולל recentTurns ו-pendingActions, התייחס לתמלול הקצר כהמשך טבעי כשהוא עונה על השאלה האחרונה: השלם את הפעולה המקורית בעזרת המועמד/הפרטים/האישור שניתנו. במקרה כזה העתק את id של הפעולה הממתינה אל extractedFacts.resolvesPendingActionId. אל תדרוש מהמשתמש לחזור על כל הבקשה. " +
              "לשאלת הבהרה השתמש kind=CLARIFY ו-tool=ASK_CLARIFICATION; ASK_CLARIFICATION אינו ערך חוקי של kind. אל תמציא מזהים. עד 10 צעדים וללא מעגלים."
          },
          { role: "user", content: `context: ${JSON.stringify(context ?? {})}\nתמלול מאושר: ${transcript}` }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "assistant_plan_v2",
            strict: false,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["version", "requestKind", "language", "extractedFacts", "steps"],
              properties: {
                version: { type: "string", enum: ["2"] },
                requestKind: { type: "string", enum: ["QUESTION", "ACTION", "MIXED"] },
                language: { type: "string", enum: ["he-IL"] },
                extractedFacts: { type: "object", additionalProperties: true },
                steps: {
                  type: "array",
                  minItems: 1,
                  maxItems: 10,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["stepId", "kind", "tool", "dependsOn", "input", "confidence", "requiresExplicitConfirmation"],
                    properties: {
                      stepId: { type: "string" },
                      kind: { type: "string", enum: ["READ", "WRITE", "CLARIFY", "RESPOND"] },
                      tool: { type: "string", enum: ASSISTANT_TOOL_NAMES },
                      dependsOn: { type: "array", items: { type: "string" } },
                      input: { type: "object", additionalProperties: true },
                      confidence: { type: "number", minimum: 0, maximum: 1 },
                      requiresExplicitConfirmation: { type: "boolean" }
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
      throw new BadGatewayException({ message: `OpenAI V2 planning failed with ${response.status}`, details: result });
    }
    const outputText = result.output_text ?? result.output?.flatMap((item) => item.content ?? []).find((content) => content.text)?.text;
    if (!outputText) throw new BadGatewayException("OpenAI V2 planning returned empty output");
    return normalizeAssistantPlan(JSON.parse(outputText), context, transcript);
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
