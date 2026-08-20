# MyClient Server Handoff

Last updated: 2026-08-20

This document is the continuity handoff for the backend. In a new chat, read this file first to understand what was built, what product decisions were made, and what still needs to be done.

## Product Direction

MyClient is a Hebrew-first CRM and virtual secretary for small business owners.

The intended product experience:

- A business owner registers in the app and gets a working business workspace.
- The owner can create CRM data manually or by Hebrew voice command.
- Voice commands are sent as audio from the app to the server. The server performs STT, sends the transcript to an LLM, receives structured JSON actions, and executes those actions in Core.
- A virtual receptionist answers customer calls, presents an IVR menu, records messages, transcribes them, creates callback tasks, and notifies the business owner.
- The POC should behave like the real product. We avoid mocks only when the paid service is not connected yet.

Current paid services policy:

- OpenAI STT and LLM are connected for owner voice commands.
- Firebase Cloud Messaging is connected as the notification provider.
- Telephony, IVR provider, and TTS are not connected yet.
- The current telephony code is still mock/Plivo-shaped and should be generalized before connecting a real provider.

## Repository

Local repo:

```text
/Users/zionbm/Downloads/MyClient/dev
```

Remote:

```text
https://github.com/zionbm/MyClient.git
```

Main runtime:

- TypeScript
- NestJS services
- Prisma
- PostgreSQL
- Docker Compose

Services:

- `core` on port `3000`: business logic, persistence, auth boundary, CRM, tasks, notifications, owner voice command orchestration.
- `ai` on port `3001`: LLM action parsing.
- `voice` on port `3002`: STT/TTS provider boundary.
- `telephony` on port `3003`: mock Plivo-like IVR/webhook flow.
- `worker` on port `3004`: due task reminder polling.
- `postgres` on port `5432`.

## Important Environment

Local `.env` is gitignored.

Important variables:

```env
AUTH_PROVIDER=mock
MOCK_FCM_PROVIDER=false
GOOGLE_APPLICATION_CREDENTIALS=/Users/zionbm/Downloads/MyClient/myclient-4f6f8-firebase-adminsdk-fbsvc-d5fe470829.json
OPENAI_API_KEY=...
OPENAI_STT_MODEL=gpt-4o-mini-transcribe
OPENAI_LLM_MODEL=gpt-5-mini
WORKER_REMINDER_POLL_ENABLED=true
WORKER_REMINDER_POLL_INTERVAL_MS=30000
WORKER_REMINDER_BATCH_SIZE=20
```

Auth modes:

- `AUTH_PROVIDER=mock`: local development uses `Authorization: Bearer mock:<firebaseUid>`.
- `AUTH_PROVIDER=firebase`: Core verifies real Firebase Authentication ID tokens with Firebase Admin SDK.

FCM:

- `MOCK_FCM_PROVIDER=false` uses Firebase Cloud Messaging.
- The Firebase service account JSON is outside `dev` and must stay out of git.
- Without a real mobile app FCM device token, Firebase sends will fail or tokens will be deactivated. That is expected.

## What Is Already Built

### Auth and Registration

- Business registration endpoint exists: `POST /auth/register-business`.
- Current local mode supports mock auth.
- Firebase Auth support was added:
  - Core verifies Firebase ID tokens when `AUTH_PROVIDER=firebase`.
  - In Firebase mode, registration uses `uid`, `email`, and display name from the verified token.
  - In mock mode, registration still supports local scripts and tests.
- `GET /auth/me` returns the authenticated user and business context.

### CRM Surface

Core supports:

- Businesses.
- Business settings:
  - locale
  - timezone
  - greeting text
  - callback prompt
  - urgent prompt
  - working hours
  - notification phone
  - urgent calls toggle
- Customers.
- Customer notes.
- Tasks.
- Appointments.
- Jobs/service calls.
- Business phone numbers.
- Incoming call records.
- Call transcripts.
- Pending actions.
- Notifications.
- Audit events.
- Usage events model exists, but real usage tracking is not fully wired.

### Owner Voice Commands

Flow:

```text
App uploads m4a/aac audio
-> Core /businesses/:businessId/voice-commands/audio
-> Voice service OpenAI STT
-> AI service OpenAI LLM structured action parsing
-> Core executes ordered actions
```

Implemented behavior:

- Hebrew audio transcription through OpenAI.
- LLM returns structured actions.
- A single voice command can execute multiple ordered actions.
- Example already tested successfully:
  - "create customer X with phone Y and remind me to call him tomorrow at 14:00"
  - Core created the customer and the task, linked the task to the customer, and handled Israel timezone correctly.
- If AI returns a task `dueAt` without timezone, Core interprets it in the business timezone.
- If a task has vague timing such as "later", Core assigns a default due time:
  - During 09:00-18:59 local time: in two hours, unless that crosses 19:00.
  - Before 09:00: today at 09:00.
  - At or after 19:00: next day at 09:00.
- Owner voice command history is persisted.

### Notifications

- Notification records are persisted.
- FCM device tokens are persisted.
- Endpoint exists to register a device token:

```text
POST /businesses/:businessId/device-tokens
```

- FCM provider is connected through Firebase Admin SDK.
- If no active device token exists, notification is marked `FAILED`.
- Invalid FCM tokens are deactivated.
- Notification status can be updated, including marking as `READ`.

### Reminder Worker

Flow:

```text
Worker interval
-> Core /internal/reminders/due
-> Core finds open tasks with dueAt <= now and reminderSentAt is null
-> Core creates and sends notification
-> Core marks reminderSentAt
```

Implemented:

- Worker service runs in Docker.
- It polls automatically every configured interval.
- Manual test trigger:

```text
POST http://localhost:3004/reminders/run
```

- Status endpoint:

```text
GET http://localhost:3004/reminders/status
```

- Duplicate reminders are prevented with `Task.reminderSentAt`.

### Telephony Mock

Current telephony service is a mock Plivo-like flow.

It supports:

- Incoming call simulation.
- IVR-like menu flow.
- Recording simulation.
- Callback task creation.
- Urgent task handling.
- Notifications from recorded customer messages.
- Phone number to business resolution.

Important product rule:

- IVR customer calls do not go through the LLM.
- Customer recordings do go through STT when a real provider is connected.
- The IVR can create only one task type: callback task.
- If a customer recorded a message, the transcript is included in the notification and task.
- If urgent, the task priority is urgent and notification payload should indicate urgency.

## Real Tests Already Performed

The following real audio tests passed with OpenAI:

- `command1.m4a`: created a customer.
- `command2.m4a`: created a customer and a reminder task for "tomorrow at 14:00"; timezone handling was corrected so Israel 14:00 stores as UTC 11:00.

The audio files are in:

```text
/Users/zionbm/Downloads/MyClient
```

Docker and integration tests have passed after the Firebase Auth infrastructure change:

```bash
npm run check
docker compose up -d --build
npm run test:integration
```

Note: local `npm run test:integration` may require elevated sandbox permissions because it calls Docker services through `localhost`.

## Telephony Provider Decision

Plivo was researched first, but it is probably not the best POC provider for Israeli inbound numbers.

Findings:

- Plivo Voice API pricing for Israel says inbound is not supported.
- Plivo SIP pages show Israel inbound and numbers, but global coverage appears tied to Enterprise or sales-led setup.
- Plivo may require Enterprise for Israel, which can make the real cost too high for POC.

Recommended provider: Telnyx.

Why:

- Telnyx advertises Israel virtual phone numbers.
- Israeli local numbers start around `$3/month`.
- Telnyx supports Voice API/SIP/webhooks.
- It appears more suitable for a low-cost POC.

Second option: Twilio.

Why:

- More mature docs and ecosystem.
- Israel Voice pricing is public.
- Israeli local numbers are around `$5.50/month`.
- Local inbound calls are around `$0.0107/min`.

Provider onboarding caveat:

- For Israeli numbers, providers may require identity/business/user documents.
- For the POC, the desired model is that MyClient owns/manages the numbers and assigns them to businesses.
- Business owners should not open their own Telnyx/Twilio accounts.
- If regulation requires end-user details, collect them inside MyClient onboarding.

Current decision:

- Do not connect telephony yet.
- Before connecting Telnyx/Twilio, generalize the telephony naming and provider abstraction.

## Priority Backlog

### P0: Clean Telephony Abstraction

The code currently still uses Plivo-specific naming in several places.

Change before connecting a real provider:

- Rename `plivoNumber` to generic `phoneNumber` or `providerNumber`.
- Replace `MOCK_PLIVO_PROVIDER` with `TELEPHONY_PROVIDER=mock|telnyx|twilio`.
- Rename mock endpoints and internal contracts where appropriate.
- Keep provider-specific webhook adapters isolated under the telephony service.
- Core should remain provider-agnostic.

Target architecture:

```text
Telnyx/Twilio webhook
-> Telephony adapter normalizes provider payload
-> Core internal endpoint
-> Core business logic
```

### P1: Expand Owner Voice Actions

Current voice commands work, but the action set should grow.

Add support for:

- Update customer.
- Create appointment.
- Update appointment.
- Create job/service call.
- Update job/service call.
- Complete task.
- Cancel task.
- Add customer note.
- Find/link existing customer by phone/name.
- Return `requiresConfirmation` for ambiguous or risky actions.

The AI should only emit allowlisted actions. Core must validate and enforce permissions before execution.

### P2: Complete Notification Product Flow

Server pieces exist, but product flow needs tightening:

- List notifications for the app.
- Mark notification as read.
- Possibly mark all as read.
- Retry failed notifications where appropriate.
- Improve failure reasons.
- Make urgent notification payload explicit.
- Test with a real mobile app FCM token when the app exists.

### P3: Usage and Cost Tracking

The `UsageEvent` model exists but is not fully wired.

Track per business:

- OpenAI STT audio duration or request count.
- OpenAI LLM request count and token usage if available.
- FCM send attempts.
- Future TTS usage.
- Future telephony minutes.
- Future recording minutes.

This is needed to understand POC cost per business.

### P4: Admin and Debug Tools

For a 10-business POC, add simple internal admin/debug endpoints or scripts.

Useful views:

- List businesses.
- List users.
- List assigned phone numbers.
- Recent owner voice commands.
- Recent calls and transcripts.
- Recent tasks.
- Failed notifications.
- Audit events.
- Provider errors.

Keep these protected by an internal secret or admin role.

### P5: Onboarding Details

Improve registration/onboarding data:

- Business category.
- Business public phone.
- Owner contact phone.
- Working hours.
- Greeting text.
- Urgent-call preferences.
- Notification preferences.
- Future telephony compliance details.

### P6: Real Telephony Provider

Start with Telnyx unless a blocker appears.

Steps:

- Open Telnyx account.
- Try to purchase one Israeli number first.
- Complete required compliance documents.
- Add `TELEPHONY_PROVIDER=telnyx`.
- Implement Telnyx webhook adapter.
- Implement IVR response format for Telnyx.
- Implement recording callback handling.
- Download recording audio if needed.
- Send recording audio to STT.
- Create callback task and notification.
- Test full real phone call flow.

If Telnyx has a blocking issue, switch to Twilio.

### P7: TTS for IVR

TTS is still mocked.

Options:

- Use provider-native text-to-speech if Hebrew sounds acceptable.
- Use OpenAI TTS if Hebrew quality/cost is better.
- Cache generated greeting audio per business/settings version.

Do not regenerate static greeting audio on every call.

### P8: Hardening Before External POC

Before giving access to real business owners:

- More integration tests for voice commands.
- Permission tests between businesses.
- Idempotency tests.
- Timezone tests.
- Notification retry/failure tests.
- Provider webhook signature validation.
- Rate limiting for public endpoints.
- Better structured logs with request IDs.
- Error monitoring plan.

## Useful Commands

Start all services:

```bash
docker compose up -d --build
```

Stop services while keeping DB volume:

```bash
docker compose down
```

Run checks:

```bash
npm run check
npm audit --audit-level=high
docker compose config --quiet
npm run test:integration
```

Run migrations:

```bash
DATABASE_URL='postgresql://myclient:myclient@localhost:5432/myclient?schema=public' npx prisma migrate deploy --schema packages/database/prisma/schema.prisma
```

Create demo data:

```bash
npm run seed:demo
```

Manual reminder run:

```bash
curl -s http://localhost:3004/reminders/run -X POST
```

Upload owner voice command audio:

```bash
curl -s http://localhost:3000/businesses/<businessId>/voice-commands/audio \
  -X POST \
  -H 'authorization: Bearer mock:<firebaseUid>' \
  -H 'content-type: audio/mp4' \
  -H 'x-audio-filename: command.m4a' \
  -H 'x-language-code: he-IL' \
  -H 'x-idempotency-key: voice_cmd_manual_1' \
  --data-binary '@command.m4a'
```

## Current Next Best Step

The best next backend development step is:

```text
Clean and generalize the telephony abstraction before implementing Telnyx.
```

Reason:

- The product decision moved away from Plivo as the default.
- Keeping Plivo-specific names now will make the Telnyx/Twilio integration messier.
- Generalizing first keeps Core provider-agnostic and makes provider replacement safer.
