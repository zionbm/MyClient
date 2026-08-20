# Paid Provider Readiness

The backend is ready to start connecting paid providers when these local checks pass:

```bash
npm run check
npm audit --audit-level=high
docker compose config --quiet
docker compose up -d --build
npm run test:integration
DATABASE_URL='postgresql://myclient:myclient@localhost:5432/myclient?schema=public' npx prisma migrate status --schema packages/database/prisma/schema.prisma
```

Current paid-provider boundaries:

- `TelephonyProvider`: Plivo request normalization and call webhooks.
- `SttProvider`: speech-to-text transcription.
- `TtsProvider`: prompt-to-audio generation.
- `LlmProvider`: owner command parsing into structured actions.
- `NotificationProvider`: push/SMS/WhatsApp/email delivery.

Implementation order for paid services:

1. Plivo inbound webhook integration, using existing phone-number-to-business resolution.
2. STT live provider, replacing `/stt/mock` while keeping stored transcripts unchanged.
3. TTS live provider for business IVR prompts.
4. Notification provider for delivery, updating notification status to `SENT` or `FAILED`.
5. LLM provider for owner commands, returning the existing `AiAction` contract.

The business logic should stay inside Core. Paid provider services should translate external payloads into the existing contracts and call Core internal endpoints.
