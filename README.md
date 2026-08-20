# MyClient Backend POC

Server-side POC monorepo for MyClient: CRM, AI business assistant and virtual receptionist for self-employed professionals. Hebrew (`he-IL`) is the default POC language for voice, IVR prompts, callback tasks and notification text.

## Structure

- `services/core` - business logic, validation, task creation and mock notifications.
- `services/ai` - mock LLM provider that returns allowlisted structured action JSON.
- `services/voice` - mock STT/TTS provider.
- `services/telephony` - mock Plivo IVR/webhook flow. It does not call the LLM.
- `services/worker` - background reminder polling service.
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

Firebase Cloud Messaging can be enabled locally by setting `MOCK_FCM_PROVIDER=false` and `GOOGLE_APPLICATION_CREDENTIALS` to the absolute path of a Firebase Admin SDK service account JSON file. The mobile app should register its FCM device token with `POST /businesses/<business-id>/device-tokens`.

Task reminders are processed by the worker. It polls Core every `WORKER_REMINDER_POLL_INTERVAL_MS` milliseconds, finds open tasks whose `dueAt` has passed and `reminderSentAt` is empty, then asks Core to create and send the notification.

Run the full integration flow against Docker:

```bash
npm run test:integration
```

Create demo data for manual testing:

```bash
npm run seed:demo
```

Owner voice commands use server-side OpenAI STT and LLM. A single voice command can produce multiple ordered CRM actions, such as creating a customer and then creating a follow-up task for that customer. AI-created tasks without an explicit time get a default due time: within working hours they are due in two hours, otherwise at the next 09:00 in the business timezone. Set `OPENAI_API_KEY`, record a short `m4a/aac` command in Hebrew, and upload it to:

```bash
curl -s http://localhost:3000/businesses/<business-id>/voice-commands/audio \
  -X POST \
  -H 'authorization: Bearer mock:<firebaseUid>' \
  -H 'content-type: audio/mp4' \
  -H 'x-audio-filename: command.m4a' \
  -H 'x-language-code: he-IL' \
  -H 'x-idempotency-key: voice_cmd_1' \
  --data-binary '@command.m4a'
```

## API Errors

All Nest services return API errors in a consistent JSON shape:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request data",
    "details": [
      {
        "path": "email",
        "message": "Invalid email"
      }
    ]
  }
}
```

Common error codes are `BAD_REQUEST`, `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `DOWNSTREAM_SERVICE_ERROR` and `INTERNAL_ERROR`.

## Authentication

The POC uses Firebase-ready mock bearer tokens. Protected Core endpoints require:

```bash
Authorization: Bearer mock:<firebaseUid>
```

For example, after registering with `firebaseUid` `firebase_demo_1`, call protected business APIs with:

```bash
-H 'authorization: Bearer mock:firebase_demo_1'
```

Core internal endpoints are service-to-service only and require `x-internal-secret`.

## Pre-Paid-Provider Product Surface

The backend now supports the product flows that should exist before connecting paid providers:

- business settings for locale, timezone, IVR prompts, working hours and notification phone.
- mock/Plivo phone numbers assigned to a business.
- incoming calls resolved by the dialed `to` phone number.
- persisted call recordings metadata and STT transcripts.
- callback task and notification creation from recorded calls.
- internal appointments calendar.
- jobs/service calls.
- audit events for business, settings, phone, CRM, appointments, jobs, calls and callback actions.

## Mock Flow Examples

Register a new business owner:

```bash
curl -s http://localhost:3000/auth/register-business \
  -H 'content-type: application/json' \
  -d '{"firebaseUid":"firebase_demo_1","email":"dani@example.com","displayName":"דני כהן","businessName":"דני תיקונים"}'
```

Load the current business context after login:

```bash
curl -s http://localhost:3000/auth/me \
  -H 'authorization: Bearer mock:firebase_demo_1'
```

Get and update business settings:

```bash
curl -s http://localhost:3000/businesses/<business-id-from-register>/settings \
  -H 'authorization: Bearer mock:firebase_demo_1'

curl -s http://localhost:3000/businesses/<business-id-from-register>/settings \
  -X PATCH \
  -H 'authorization: Bearer mock:firebase_demo_1' \
  -H 'content-type: application/json' \
  -d '{"notificationPhone":"+972501111111","greetingText":"שלום, הגעתם לדני תיקונים. לחזרה הקישו 1, הודעה 2, דחוף 3."}'
```

Assign a mock Plivo number to the business:

```bash
curl -s http://localhost:3000/businesses/<business-id-from-register>/phone-numbers \
  -H 'authorization: Bearer mock:firebase_demo_1' \
  -H 'content-type: application/json' \
  -d '{"plivoNumber":"+97230000001","displayName":"מספר ראשי"}'
```

Owner text command through AI:

```bash
curl -s http://localhost:3001/intent/parse \
  -H 'content-type: application/json' \
  -d '{"businessId":"biz_1","userId":"user_1","text":"תזכיר לי לחזור לדני מחר"}'
```

Execute the returned action in Core:

```bash
curl -s http://localhost:3000/owner-actions/execute \
  -H 'authorization: Bearer mock:firebase_demo_1' \
  -H 'content-type: application/json' \
  -d '{"businessId":"<business-id-from-register>","action":{"type":"CREATE_TASK","idempotencyKey":"ai_example_123","confidence":0.9,"requiresConfirmation":false,"missingFields":[],"payload":{"title":"לחזור לדני מחר"}}}'
```

Virtual receptionist callback without LLM:

```bash
curl -s http://localhost:3003/plivo/callback-request \
  -H 'content-type: application/json' \
  -d '{"callId":"call_1","from":"+972501234567","to":"+97230000001"}'
```

Virtual receptionist recording with mock STT:

```bash
curl -s http://localhost:3003/plivo/recording \
  -H 'content-type: application/json' \
  -d '{"callId":"call_2","from":"+972501234567","to":"+97230000001","transcript":"אשמח שתחזור אליי לגבי התיקון","urgent":true}'
```

The Core service persists callback tasks, owner-created tasks, notifications and pending actions in PostgreSQL through Prisma. Duplicate callback and owner task requests are detected by `Task.idempotencyKey`, so the protection survives service restarts.

List created tasks:

```bash
curl -s http://localhost:3000/businesses/<business-id-from-register>/tasks \
  -H 'authorization: Bearer mock:firebase_demo_1'
```

Create a customer:

```bash
curl -s http://localhost:3000/businesses/<business-id-from-register>/customers \
  -H 'authorization: Bearer mock:firebase_demo_1' \
  -H 'content-type: application/json' \
  -d '{"name":"דני כהן","phone":"+972501111111","email":"dani@example.com","address":"הרצל 10, תל אביב"}'
```

Create a task for a customer:

```bash
curl -s http://localhost:3000/businesses/<business-id-from-register>/tasks \
  -H 'authorization: Bearer mock:firebase_demo_1' \
  -H 'content-type: application/json' \
  -d '{"customerId":"<customer-id>","title":"לקבוע ביקור","description":"לתאם ביקור לתיקון המזגן","priority":"NORMAL","dueAt":"2026-08-21T09:00:00.000Z"}'
```

Add a customer note:

```bash
curl -s http://localhost:3000/businesses/<business-id-from-register>/customers/<customer-id>/notes \
  -H 'authorization: Bearer mock:firebase_demo_1' \
  -H 'content-type: application/json' \
  -d '{"text":"לקוח ביקש זמינות בבוקר בלבד"}'
```

Create an appointment:

```bash
curl -s http://localhost:3000/businesses/<business-id-from-register>/appointments \
  -H 'authorization: Bearer mock:firebase_demo_1' \
  -H 'content-type: application/json' \
  -d '{"customerId":"<customer-id>","title":"ביקור שירות","startsAt":"2026-08-21T09:00:00.000Z","endsAt":"2026-08-21T10:00:00.000Z"}'
```

Create a job/service call:

```bash
curl -s http://localhost:3000/businesses/<business-id-from-register>/jobs \
  -H 'authorization: Bearer mock:firebase_demo_1' \
  -H 'content-type: application/json' \
  -d '{"customerId":"<customer-id>","title":"תיקון מזגן","description":"המזגן לא מקרר"}'
```

List incoming calls and audit events:

```bash
curl -s http://localhost:3000/businesses/<business-id-from-register>/calls \
  -H 'authorization: Bearer mock:firebase_demo_1'

curl -s http://localhost:3000/businesses/<business-id-from-register>/audit-events \
  -H 'authorization: Bearer mock:firebase_demo_1'
```

Complete a task:

```bash
curl -s http://localhost:3000/businesses/<business-id-from-register>/tasks/<task-id>/complete \
  -H 'authorization: Bearer mock:firebase_demo_1' \
  -X POST
```
