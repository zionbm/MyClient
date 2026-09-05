import assert from "node:assert/strict";
import test from "node:test";
import { ASSISTANT_TOOL_NAMES } from "@myclient/contracts";
import { ASSISTANT_PLAN_JSON_SCHEMA } from "./assistant-schema.js";

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function assertStrictObjects(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertStrictObjects);
    return;
  }
  const schema = objectValue(value);
  if (schema.type === "object") {
    assert.equal(schema.additionalProperties, false);
    const properties = objectValue(schema.properties);
    assert.deepEqual(schema.required, Object.keys(properties));
  }
  Object.values(schema).forEach(assertStrictObjects);
}

test("AssistantPlan OpenAI schema makes every object strict", () => {
  assertStrictObjects(ASSISTANT_PLAN_JSON_SCHEMA);
});

test("AssistantPlan OpenAI schema has one typed input branch per allowed tool", () => {
  const properties = objectValue(objectValue(ASSISTANT_PLAN_JSON_SCHEMA).properties);
  const steps = objectValue(properties.steps);
  const branches = objectValue(steps.items).anyOf as JsonObject[];
  const tools = branches.map((branch) => {
    const stepProperties = objectValue(objectValue(branch).properties);
    return (objectValue(stepProperties.tool).enum as string[])[0];
  });
  assert.deepEqual(tools, [...ASSISTANT_TOOL_NAMES]);
});

test("AssistantPlan OpenAI schema requires natural reply leads for every execution outcome", () => {
  const properties = objectValue(objectValue(ASSISTANT_PLAN_JSON_SCHEMA).properties);
  const reply = objectValue(properties.assistantReply);
  assert.deepEqual(reply.required, ["completedLead", "partialLead", "needsInputLead"]);
  assert.equal(objectValue(objectValue(reply.properties).completedLead).maxLength, 100);
});
