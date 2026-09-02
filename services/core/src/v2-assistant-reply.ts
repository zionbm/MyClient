import type { AssistantPlan } from "@myclient/contracts";

type ReplyState = "COMPLETED" | "PARTIALLY_COMPLETED" | "WAITING";

const MAX_LEAD_LENGTH = 100;
const UNSAFE_LEAD = /[\r\n\d{}]|https?:\/\/|www\.|[₪$€£]|\b(?:id|uuid)\b/iu;
const SAFE_LEAD_WORDS = new Set([
  "אני", "את", "אפשר", "בזה", "בטח", "בדקתי", "בשביל", "בשמחה", "הבקשה", "התחלתי", "הנה", "הצלחתי",
  "השלמתי", "טיפלתי", "יופי", "יש", "כדי", "כמובן", "לבצע", "להמשיך", "להשלים", "לי",
  "לטפל", "מה", "מהבקשה", "ממך", "ממשיכים", "מעולה", "מצוין", "נשאר", "סגור", "סידרתי", "זה",
  "עכשיו", "עוד", "פרט", "קדימה", "קטן", "קצר", "רק", "שאמשיך", "שאלה", "שאפשר", "שמצאתי",
  "שנמשיך", "שנשאר", "שצריך", "צריך", "צריכה", "חלק", "ונשאר", "וכדי"
]);

function fallbackLead(state: ReplyState, requestKind: AssistantPlan["requestKind"]): string {
  if (state === "WAITING") return "כדי שאמשיך, חסר לי פרט קצר:";
  if (state === "PARTIALLY_COMPLETED") return "טיפלתי במה שאפשר, וכדי להמשיך:";
  if (requestKind === "QUESTION") return "בשמחה —";
  if (requestKind === "MIXED") return "טיפלתי בזה —";
  return "סגור —";
}

function wordsIn(value: string): string[] {
  return value.match(/[\p{L}\p{M}]+/gu) ?? [];
}

function safeLead(candidate: string | undefined, fallback: string, verifiedText: string): string {
  const normalized = candidate?.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > MAX_LEAD_LENGTH || UNSAFE_LEAD.test(normalized)) return fallback;
  const verifiedWords = new Set(wordsIn(verifiedText));
  const words = wordsIn(normalized);
  if (words.length === 0 || words.some((word) => !SAFE_LEAD_WORDS.has(word) && !verifiedWords.has(word))) return fallback;
  return normalized;
}

function uniqueText(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

export function composeAssistantSummary(input: {
  plan: AssistantPlan;
  state: ReplyState;
  completedCount: number;
  messages: Array<string | undefined>;
  questions: Array<string | undefined>;
  warnings: Array<string | undefined>;
}): string {
  const verifiedParts = uniqueText([...input.messages, ...input.questions]);
  const verifiedSummary = verifiedParts.join(" ") || (input.state === "COMPLETED"
    ? input.completedCount === 1 ? "הפעולה בוצעה בהצלחה." : `בוצעו ${input.completedCount} פעולות בהצלחה.`
    : input.state === "PARTIALLY_COMPLETED"
      ? "ביצעתי את הפעולות הברורות ושמרתי שאלה להשלמה."
      : "אני צריך עוד פרט לפני שאוכל לבצע את הבקשה.");
  const fallback = fallbackLead(input.state, input.plan.requestKind);
  const candidate = input.state === "COMPLETED"
    ? input.plan.assistantReply?.completedLead
    : input.state === "PARTIALLY_COMPLETED"
      ? input.plan.assistantReply?.partialLead
      : input.plan.assistantReply?.needsInputLead;
  const lead = safeLead(candidate, fallback, verifiedSummary);
  return [lead, verifiedSummary, ...uniqueText(input.warnings)].join(" ");
}
