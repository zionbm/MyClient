export type ProviderHealth = {
  provider: string;
  mode: "mock" | "live";
};

export type TelephonyIncomingCall = {
  callId: string;
  from?: string;
  to: string;
  digit?: string;
};

export type TelephonyProvider = {
  health(): ProviderHealth;
  normalizeIncomingCall(input: unknown): TelephonyIncomingCall;
};

export type SttRequest = {
  recordingUrl?: string;
  transcript?: string;
  languageCode?: string;
};

export type SttResult = {
  provider: string;
  languageCode: string;
  transcript: string;
  confidence: number;
};

export type SttProvider = {
  health(): ProviderHealth;
  transcribe(input: SttRequest): Promise<SttResult>;
};

export type TtsRequest = {
  text: string;
  voice?: string;
};

export type TtsResult = {
  provider: string;
  voice: string;
  audioObjectUri: string;
};

export type TtsProvider = {
  health(): ProviderHealth;
  synthesize(input: TtsRequest): Promise<TtsResult>;
};

export type LlmIntentRequest = {
  businessId?: string;
  userId?: string;
  text: string;
  idempotencyKey?: string;
};

export type LlmIntentResult<TAction> = {
  provider: string;
  action: TAction;
};

export type LlmProvider<TAction> = {
  health(): ProviderHealth;
  parseIntent(input: LlmIntentRequest): Promise<LlmIntentResult<TAction>>;
};

export type NotificationRequest = {
  businessId: string;
  notificationId: string;
  title: string;
  body: string;
  payload?: unknown;
};

export type NotificationResult = {
  provider: string;
  status: "SENT" | "FAILED";
  failureReason?: string;
};

export type NotificationProvider = {
  health(): ProviderHealth;
  send(input: NotificationRequest): Promise<NotificationResult>;
};
