# Manual Test Flow

Run all services:

```bash
docker compose up -d --build
```

Run the automated integration flow:

```bash
npm run test:integration
```

Create demo data:

```bash
npm run seed:demo
```

The seed command prints `businessId`, `firebaseUid`, `token`, `phoneNumber` and `customerId`. Use them in manual calls.

Check current auth context:

```bash
curl -s http://localhost:3000/auth/me \
  -H 'authorization: Bearer mock:<firebaseUid>'
```

List calls, notifications, pending actions and audit events:

```bash
curl -s http://localhost:3000/businesses/<businessId>/calls \
  -H 'authorization: Bearer mock:<firebaseUid>'

curl -s 'http://localhost:3000/businesses/<businessId>/notifications?status=PENDING' \
  -H 'authorization: Bearer mock:<firebaseUid>'

curl -s 'http://localhost:3000/businesses/<businessId>/pending-actions?status=PENDING' \
  -H 'authorization: Bearer mock:<firebaseUid>'

curl -s http://localhost:3000/businesses/<businessId>/audit-events \
  -H 'authorization: Bearer mock:<firebaseUid>'
```

Simulate a recorded call:

```bash
curl -s http://localhost:3003/plivo/recording \
  -H 'content-type: application/json' \
  -d '{"callId":"manual_call_1","from":"+972501234567","to":"<phoneNumber>","transcript":"אשמח שתחזרו אליי","urgent":true,"recordingUrl":"mock://recording/manual_call_1"}'
```

Mark a notification as read:

```bash
curl -s http://localhost:3000/businesses/<businessId>/notifications/<notificationId> \
  -X PATCH \
  -H 'authorization: Bearer mock:<firebaseUid>' \
  -H 'content-type: application/json' \
  -d '{"status":"READ"}'
```

## Owner Voice Command With Server STT

After setting `OPENAI_API_KEY`, record a short Hebrew command in the app as `m4a/aac` and upload it to Core:

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

List voice command history:

```bash
curl -s http://localhost:3000/businesses/<businessId>/voice-commands \
  -H 'authorization: Bearer mock:<firebaseUid>'
```
