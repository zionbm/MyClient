# MyClient Backend POC

Server-side POC monorepo for MyClient: CRM, AI business assistant and virtual receptionist for self-employed professionals. Hebrew (`he-IL`) is the default POC language for voice, IVR prompts, callback tasks and notification text.

## Structure

- `services/core` - business logic, validation, task creation and mock notifications.
- `services/ai` - mock LLM provider that returns allowlisted structured action JSON.
- `services/voice` - mock STT/TTS provider.
- `services/telephony` - mock Plivo IVR/webhook flow. It does not call the LLM.
- `services/worker` - mock background queue/scheduler surface.
- `packages/contracts` - shared request/action schemas.
- `packages/common` - shared env, health, logging and idempotency helpers.
- `packages/database` - Prisma schema and database package placeholder.

## Local Setup

```bash
npm install
cp .env.example .env
npm run prisma:generate
npm run check
```

Create and apply local database migrations:

```bash
docker compose up -d postgres
npm run prisma:migrate:dev
```

Run a single service:

```bash
npm run dev:core
npm run dev:ai
npm run dev:voice
npm run dev:telephony
npm run dev:worker
```

Run with Docker Compose:

```bash
docker compose up --build
```

## Mock Flow Examples

Owner text command through AI:

```bash
curl -s http://localhost:3001/intent/parse \
  -H 'content-type: application/json' \
  -d '{"businessId":"biz_1","userId":"user_1","text":"תזכיר לי לחזור לדני מחר"}'
```

Execute the returned action in Core:

```bash
curl -s http://localhost:3000/owner-actions/execute \
  -H 'content-type: application/json' \
  -d '{"businessId":"biz_1","action":{"type":"CREATE_TASK","idempotencyKey":"ai_example_123","confidence":0.9,"requiresConfirmation":false,"missingFields":[],"payload":{"title":"לחזור לדני מחר"}}}'
```

Virtual receptionist callback without LLM:

```bash
curl -s http://localhost:3003/plivo/callback-request \
  -H 'content-type: application/json' \
  -d '{"businessId":"biz_1","callId":"call_1","from":"+972501234567","to":"+97239999999"}'
```

Virtual receptionist recording with mock STT:

```bash
curl -s http://localhost:3003/plivo/recording \
  -H 'content-type: application/json' \
  -d '{"businessId":"biz_1","callId":"call_2","from":"+972501234567","transcript":"אשמח שתחזור אליי לגבי התיקון","urgent":true}'
```

The Core service persists callback tasks, owner-created tasks, notifications and pending actions in PostgreSQL through Prisma. Duplicate callback and owner task requests are detected by `Task.idempotencyKey`, so the protection survives service restarts.

List created tasks:

```bash
curl -s http://localhost:3000/businesses/biz_1/tasks
```

Create a customer:

```bash
curl -s http://localhost:3000/businesses/biz_1/customers \
  -H 'content-type: application/json' \
  -d '{"name":"דני כהן","phone":"+972501111111","email":"dani@example.com","address":"הרצל 10, תל אביב"}'
```

Create a task for a customer:

```bash
curl -s http://localhost:3000/businesses/biz_1/tasks \
  -H 'content-type: application/json' \
  -d '{"customerId":"<customer-id>","title":"לקבוע ביקור","description":"לתאם ביקור לתיקון המזגן","priority":"NORMAL","dueAt":"2026-08-21T09:00:00.000Z"}'
```

Add a customer note:

```bash
curl -s http://localhost:3000/businesses/biz_1/customers/<customer-id>/notes \
  -H 'content-type: application/json' \
  -d '{"text":"לקוח ביקש זמינות בבוקר בלבד"}'
```

Complete a task:

```bash
curl -s http://localhost:3000/businesses/biz_1/tasks/<task-id>/complete -X POST
```
