# MyClient Backend POC

Server-side POC monorepo for MyClient: CRM, AI business assistant and virtual receptionist for self-employed professionals.

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
npm run check
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
  -d '{"businessId":"biz_1","userId":"user_1","text":"Call Dani tomorrow"}'
```

Execute the returned action in Core:

```bash
curl -s http://localhost:3000/owner-actions/execute \
  -H 'content-type: application/json' \
  -d '{"businessId":"biz_1","action":{"type":"CREATE_TASK","idempotencyKey":"ai_example_123","confidence":0.9,"requiresConfirmation":false,"missingFields":[],"payload":{"title":"Call Dani tomorrow"}}}'
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
  -d '{"businessId":"biz_1","callId":"call_2","from":"+972501234567","transcript":"Please call me back about the repair","urgent":true}'
```

List created tasks:

```bash
curl -s http://localhost:3000/businesses/biz_1/tasks
```
