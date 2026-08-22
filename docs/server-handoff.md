# MyClient Server Handoff

Last updated: 2026-08-22

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

### Mobile Server Readiness Status

As of 2026-08-22, the local backend is ready for starting mobile client development against stable product-facing APIs.

Completed for the mobile POC:

- Phone-first auth flow:
  - `User.email` is optional.
  - `User.phoneNumber` exists and is unique when present.
  - Firebase mode reads verified `phone_number`.
  - Mock mode supports `x-mock-phone-number` for local testing.
- `BusinessMember` model and team endpoints:
  - `GET /businesses/:businessId/members`
  - `POST /businesses/:businessId/members`
  - `POST /businesses/:businessId/members/:memberId/disable`
  - `GET /auth/me` can auto-link a pending member by verified phone number.
- Mobile-facing work item APIs:
  - `GET /businesses/:businessId/home`
  - `GET|POST|PATCH|DELETE /businesses/:businessId/callbacks`
  - `POST /businesses/:businessId/callbacks/:callbackId/complete`
  - `GET|POST|PATCH|DELETE /businesses/:businessId/home-visits`
  - `POST /businesses/:businessId/home-visits/:homeVisitId/complete`
  - `GET|POST|PATCH|DELETE /businesses/:businessId/quotes`
  - `POST /businesses/:businessId/quotes/:quoteId/mark-paid`
- Product-facing status mapping:
  - callback: `OPEN` / `DONE`
  - home visit: `OPEN` / `DONE`
  - quote: `OPEN` / `PAID`
- Soft delete for mobile treatment items.
- Quote persistence through a dedicated `Quote` model.
- Customer detail activity feed with callbacks, home visits, quotes and notes.
- Customer merge endpoint:
  - `POST /businesses/:businessId/customers/:sourceCustomerId/merge`
- Calls list now returns a mobile-shaped response:
  - `ivrSelection`
  - `displayStatus`
  - `transcriptPreview`
  - `relatedTask`
  - `customer`
- Notification app flow:
  - list notifications
  - mark one as read
  - mark all as read
  - snooze a notification linked to a callback or quote
- AI pending action aliases for the mobile app:
  - `GET /businesses/:businessId/ai-pending-actions`
  - `PATCH /businesses/:businessId/ai-pending-actions/:id`
  - `POST /businesses/:businessId/ai-pending-actions/:id/approve`
  - `POST /businesses/:businessId/ai-pending-actions/:id/reject`
- Owner voice action allowlist and Core execution now cover the mobile POC action set:
  - create/update customer
  - create/update/complete callback
  - create/update home visit
  - create/update quote
  - mark quote paid
  - add customer note
  - soft-delete treatment item
  - merge customers

Still not complete:

- Real telephony provider integration is not connected yet.
- The telephony service is still mock/Plivo-shaped and should be generalized before Telnyx/Twilio.
- TTS for the IVR is still mocked.
- Usage/cost tracking exists as a model but is not fully wired.
- Admin/debug tooling for a real 10-business POC is still minimal.
- Production hardening is still needed before external users.

### Auth and Registration

- Business registration endpoint exists: `POST /auth/register-business`.
- Current local mode supports mock auth.
- Firebase Auth support was added:
  - Core verifies Firebase ID tokens when `AUTH_PROVIDER=firebase`.
  - Product decision: the mobile POC uses phone number authentication only. In Firebase mode, registration should use `uid`, verified `phone_number`, and optional display name from the verified token.
  - In mock mode, registration still supports local scripts and tests.
- `GET /auth/me` returns the authenticated user, business context, active membership if available, and `onboardingState`.
- `GET /auth/me` auto-links a pending `BusinessMember` row by verified phone number when possible.
- `User.businessId` is now optional and kept for compatibility while business access is moving to membership-based authorization.
- `User.email` is optional. `User.phoneNumber` is unique when present.

Target user identity fields for mobile POC:

```text
User
- id
- firebaseUid unique
- phoneNumber unique for mobile users
- email optional
- displayName optional
```

Email can be collected later for invoices, reports, support, or future Google/Apple login, but it is not part of first-run authentication.

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
  - urgent calls toggle exists technically, but is not exposed in the mobile POC settings screen.
- Customers.
- Customer notes.
- Tasks.
- Appointments.
- Quotes.
- Jobs/service calls exist technically, but there is no standalone service-calls screen in the mobile POC.
- Business phone numbers.
- Incoming call records.
- Call transcripts.
- Pending actions.
- Notifications.
- Audit events.
- Usage events model exists, but real usage tracking is not fully wired.

Mobile product decisions that affect Core:

- The first mobile version does not need a standalone tasks screen.
- The main mobile tab is called Home (`בית`), not Agenda / Daily Schedule.
- The mobile product language should use clear field-worker terms:
  - `CALLBACK` / חזרה ללקוח
  - `HOME_VISIT` / ביקור בית, replacing the generic appointment wording in the app
  - `NOTE` / הערה
  - `QUOTE` / הצעת מחיר
- Any dated treatment item, including callback, home visit or quote follow-up, must have a `dueAt`; no undated treatment items in the POC.
- If AI or manual creation does not provide an explicit time, Core should assign the existing default due time.
- The mobile Home screen needs search across agenda/work items: callbacks, home visits, quotes, notifications, customer name, phone and related notes where available.
- Existing `Task` and `Appointment` persistence can be reused internally if that is fastest, but the mobile API should expose product-facing item types rather than generic task/appointment labels.
- Quote support is implemented as a dated work item with title, optional customer, optional description, optional estimated amount and a simple status. A full quote document/PDF is future work.
- Keep mobile-facing statuses intentionally minimal:
  - callback: `OPEN` / `DONE`
  - home visit: `OPEN` / `DONE`
  - quote: `OPEN` / `PAID`
- Do not model "cancelled" as a user-facing status in the mobile POC. If an item is no longer relevant, the user deletes it.
- Treatment item deletion should be soft delete, not hard delete. Hide deleted items from default mobile lists, but keep them for audit/debug.
- The mobile POC requires an active network connection. No offline sync, local mutation queue or conflict resolution is required for the first version.

Mobile POC business settings decisions:

- The app settings screen exposes only business identity, locale/timezone, working hours, virtual receptionist text prompts, owner notification phone and the assigned virtual receptionist phone number as read-only information.
- The owner cannot add, edit, remove or request business phone numbers from the mobile POC.
- Business phone assignment is an internal MyClient/admin responsibility. The mobile app should show only the assigned number, without provider/technical status. If no virtual receptionist number is assigned, the app should show an empty state such as "No virtual number has been assigned yet."
- The app does not expose AI settings. Core/product rules decide which AI actions can be executed automatically and which become pending actions.
- The app does not expose per-business IVR menu editing in the POC. All businesses use the same IVR option structure; only message text can vary.
- The app does not expose urgent-call configuration in the POC. Urgency rules are owned by product/server behavior.
- The app does not expose notification filtering. The owner receives all notification types the product decides to send.

Business phone routing decision:

- A single provider line/account can serve more than one business.
- Core/telephony should route each inbound call to the correct business by the original dialed number, for example the provider `toNumber` / DID.
- The business owner only sees the virtual number assigned to their business.
- Admin/internal tooling must support assigning a virtual number to a business.
- Incoming calls should persist both `fromNumber` and the original `toNumber` so the calls list and routing are auditable.

Mobile WhatsApp decision:

- The mobile POC should support opening WhatsApp / WhatsApp Business for a specific customer when that customer has a phone number.
- This is a client-side deep link action, not server-side message sending in the POC.
- No WhatsApp templates, provider integration or outbound message persistence is required for the first version.

### Calls Screen API Requirements

The mobile Calls screen is an incoming-call log for the virtual receptionist. It is not a generic task list.

Already built:

- `IncomingCall` persists incoming call records.
- `CallTranscript` persists transcripts.
- `GET /businesses/:businessId/calls` lists calls for a business.
- Telephony-created callback tasks use `source="telephony"` and `sourceRef=<provider call id>`.
- Recorded calls can store `CallTranscript.taskId` when a callback task was created.

Implemented mobile response behavior:

- Return a product-shaped calls list response so the app does not need to infer display state from raw persistence fields.
- Include the IVR/menu selection as a stable enum, for example:
  - `CALLBACK_REQUESTED`
  - `MESSAGE_RECORDED`
  - `URGENT_MESSAGE`
  - `NO_SELECTION`
- Include a display status, for example:
  - `TASK_CREATED`
  - `TASK_COMPLETED`
  - `CUSTOMER_LINKED`
  - `NO_ACTION`
- Include `transcriptPreview` when a transcript exists.
- Include `relatedTask` when a callback task was created, including at least `id`, `status`, `dueAt` and `priority`.
- Include `customer` when the caller phone matches or is linked to a known customer.
- Include `durationSeconds` if the telephony provider supplies call duration. The current mock returns `null`.
- Calls with no IVR selection should stay visible in Calls with `NO_SELECTION` / `NO_ACTION`, but should not appear in Home unless a callback/action was created.

Suggested response shape:

```json
{
  "calls": [
    {
      "id": "call_id",
      "fromNumber": "0521234567",
      "toNumber": "03...",
      "calledAt": "2026-08-21T09:15:00.000Z",
      "durationSeconds": 27,
      "ivrSelection": "URGENT_MESSAGE",
      "displayStatus": "TASK_CREATED",
      "urgent": true,
      "transcriptPreview": "אשמח שתחזרו אליי לגבי התיקון",
      "relatedTask": {
        "id": "task_id",
        "status": "OPEN",
        "dueAt": "2026-08-21T11:15:00.000Z",
        "priority": "URGENT"
      },
      "customer": null
    }
  ]
}
```

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
- Core can execute the mobile POC action set from structured AI actions:
  - create/update customer
  - create/update/complete callback
  - create/update home visit
  - create/update quote
  - mark quote as paid
  - add customer note
  - soft-delete treatment item
  - merge customers
- Ambiguous or risky actions should still be emitted with `requiresConfirmation` or missing fields so Core stores them as pending actions.

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
- Mobile notification snooze is implemented for notifications linked to dated treatment items supported by the current reminder model.
- First presets:
  - `IN_15_MINUTES`
  - `IN_2_HOURS`
  - `TOMORROW_09_00`
- Snoozing updates the linked item/reminder so a new notification is sent at the selected future time.

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
- `command2.m4a`: created a customer and a callback reminder for "tomorrow at 14:00"; timezone handling was corrected so Israel 14:00 stores as UTC 11:00.

The audio files are in:

```text
/Users/zionbm/Downloads/MyClient
```

Docker and integration tests have passed after the Firebase Auth infrastructure and mobile server readiness changes:

```bash
npm run prisma:generate
npm run check
docker compose up -d --build
DATABASE_URL='postgresql://myclient:myclient@localhost:5432/myclient?schema=public' npx prisma migrate deploy --schema packages/database/prisma/schema.prisma
npm run test:integration
```

Note: local `npm run test:integration` may require elevated sandbox permissions because it calls Docker services through `localhost`.

The integration test now covers:

- phone-first registration compatibility
- members list/create
- callbacks
- home visits
- quotes and mark-paid
- Home work item endpoint
- customer activity feed
- AI pending action edit/approve alias
- telephony mock callback flow
- notifications snooze/read
- mobile-shaped calls response

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

### P1: Expand Owner Voice Actions - Completed for Mobile POC

The mobile POC action set is now allowlisted and executable in Core.

Supported now:

- Update customer.
- Create home visit.
- Update home visit.
- Create callback.
- Update callback.
- Complete callback.
- Soft-delete treatment item.
- Create quote.
- Update quote.
- Mark quote as paid.
- Add customer note.
- Merge customers.
- Return pending actions for ambiguous or risky actions through `requiresConfirmation` or missing fields.

Remaining future improvement:

- Smarter find/link existing customer by fuzzy name or phone before creating duplicates. Basic phone matching exists in customer/calls flows, but richer AI disambiguation should continue to use pending actions.

The AI should only emit allowlisted actions. Core validates and enforces business permissions before execution.

Mobile POC note:

- Customer creation must allow name-only customers. `phoneNumber` is optional for CRM customers in the mobile POC.
- There is no customer type/tag requirement in the mobile POC.
- Customer merge flow for fixing duplicate/name-only customers is implemented:
  - Primary POC use case: merge a source customer with no `phoneNumber` into an existing target customer, usually one that has a `phoneNumber`.
  - Move callbacks, home visits, quotes, notes, linked calls/transcripts where applicable, and other customer activity from the source customer to the target customer.
  - Keep an audit/debug trace such as `mergedIntoCustomerId`, `mergedAt`, and `mergedByUserId`, or an equivalent merge event.
  - Hide merged source customers from the default customer list.
  - Do not allow automatic merge of two customers with conflicting phone numbers in the POC.
  - AI may suggest a possible duplicate as a pending action, but final merge must be user-confirmed.
- Endpoint: `POST /businesses/:businessId/customers/:sourceCustomerId/merge` with `targetCustomerId`.
- Service-call/job voice actions are not part of the mobile POC action set.

### P2: Complete Notification Product Flow - Completed for Mobile POC

Implemented:

- List notifications for the app.
- Mark notification as read.
- Mark all as read.
- Add "remind me later" / snooze for notifications linked to dated treatment items supported by the current reminder model.

Still future:

- Retry failed notifications where appropriate.
- Improve failure reasons.
- Make urgent notification payload explicit.
- Test with a real mobile app FCM token when the app exists.

Suggested snooze endpoint:

```text
POST /businesses/:businessId/notifications/:notificationId/snooze
```

Request:

```json
{
  "preset": "IN_15_MINUTES"
}
```

Supported first presets:

- `IN_15_MINUTES`
- `IN_2_HOURS`
- `TOMORROW_09_00`

Expected behavior:

- Require the notification to belong to the business and be linked to a dated treatment item.
- Use `notificationId` to load the exact notification the user acted on.
- Use the notification's linked `itemType`/`itemId` as the only item that can be snoozed by this request. If the first implementation reuses `taskId`, treat it as an internal detail for callback items.
- Reject the request if the notification has no snoozable linked item, because general notifications cannot be snoozed in the first version.
- Update the linked item's next reminder time. If the implementation reuses `Task.dueAt` for reminders, update `dueAt` and reset `reminderSentAt` to `null`.
- Mark the current notification as `READ` or store a future `SNOOZED` status if the status enum is expanded.
- The reminder worker should send a new notification for that same item when the snoozed time arrives.

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

### P5.5: Business Members by Phone - Completed for Mobile POC

The mobile app needs to support two post-auth flows:

- Owner creates a new business workspace.
- Employee enters an existing business after the owner added their phone number.

Current backend state:

- `User.businessId` is optional and kept for compatibility.
- `POST /auth/register-business` creates the owner and business.
- `BusinessMember` exists.
- Product decision for POC: there are no invite codes. The owner adds an employee phone number. When the employee verifies that number, Core links the user to the business automatically.
- Product decision for POC: employees see the same screens as the owner and can perform the same actions. Detailed permissions and roles are future work.

Target data model:

```text
BusinessMember
- id
- businessId
- userId optional until the employee first signs in
- phoneNumber required
- memberType: OWNER | EMPLOYEE
- status: PENDING | ACTIVE | DISABLED
- addedByUserId optional
- linkedAt optional
- createdAt
- updatedAt
```

Suggested uniqueness:

- unique `(businessId, phoneNumber)`.
- decide whether one phone can belong to multiple businesses later; for the POC, one active business per phone is simpler.

Implemented migration path:

1. Add `phoneNumber` to `User` as required/unique for new mobile users and make `email` optional.
2. Add `BusinessMember` without immediately removing `User.businessId`.
3. Backfill every existing owner user as a `BusinessMember` with `memberType=OWNER` and `status=ACTIVE`.
4. Update `AUTH_PROVIDER=firebase` to read verified `phone_number` from Firebase phone auth tokens.
5. On `GET /auth/me`, if no active membership exists for the user, look for `BusinessMember` rows with matching `phoneNumber`, `userId=null` and `status=PENDING`; link the user and set status to `ACTIVE`.
6. For the POC, authorization can treat `OWNER` and `EMPLOYEE` the same for business actions.
7. Keep `User.businessId` temporarily for compatibility.

Needed Core endpoints:

```text
GET /auth/me
```

Should return:

- authenticated user.
- active business membership if one exists.
- if no active membership exists, Core should auto-link pending `BusinessMember` rows matching the verified phone number.
- onboarding state: `HAS_BUSINESS` or `NEEDS_CHOICE`.

```text
POST /businesses/:businessId/members
```

Owner adds an employee by phone number. This creates a pending member if the user has not signed in yet, or an active member if a user with that verified phone number already exists.

```text
GET /businesses/:businessId/members
```

Owner lists active and pending members.

```text
POST /businesses/:businessId/members/:memberId/disable
```

Owner disables a member.

Initial access policy:

- `OWNER`: full access.
- `EMPLOYEE`: same access as owner for the POC.

Future work:

- detailed roles such as `ADMIN`, `STAFF` and `RECEPTIONIST`.
- per-feature permissions.
- membership audit events.
- support for a user belonging to multiple businesses.

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

The backend is ready for local mobile client development. The best next backend-only development step is:

```text
Clean and generalize the telephony abstraction before implementing Telnyx.
```

Reason:

- The product decision moved away from Plivo as the default.
- Keeping Plivo-specific names now will make the Telnyx/Twilio integration messier.
- Generalizing first keeps Core provider-agnostic and makes provider replacement safer.

The best overall product step is:

```text
Start mobile client development against the local Core APIs, while leaving real telephony provider integration for the next backend phase.
```
