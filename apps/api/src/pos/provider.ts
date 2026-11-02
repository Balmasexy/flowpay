export type PosIntegrationMode = "provider_api" | "terminal_sdk" | "terminal_push" | "qr";
export type PosPaymentStatus = "pending" | "succeeded" | "failed" | "cancelled" | "expired";

export type PosProviderCapabilities = {
  providerCode: string;
  displayName: string;
  integrationModes: PosIntegrationMode[];
  supportedPlatforms: Array<"android_phone" | "android_pos" | "linux_pos" | "other">;
  supportedCurrencies: string[];
  paymentMethods: Array<"card" | "qr" | "account_transfer" | "tap_to_phone">;
  sandboxAvailable: boolean;
  liveApprovalRequired: true;
};

export type RegisterTerminalInput = {
  merchantId: string;
  externalTerminalRef: string;
  platform: "android_phone" | "android_pos" | "linux_pos" | "other";
  manufacturer?: string;
  model?: string;
};

export type RegisteredTerminal = {
  providerCode: string;
  externalTerminalRef: string;
  status: "pending" | "connected" | "offline" | "suspended";
  displayLabel?: string;
};

export type CreatePosPaymentInput = {
  merchantId: string;
  flowpayIntentId: string;
  idempotencyKey: string;
  terminalRef: string;
  amountMinor: string;
  currency: string;
  returnReference: string;
};

export type ProviderPaymentResult = {
  providerCode: string;
  providerReference: string;
  status: "pending" | "failed" | "cancelled";
  // A provider adapter must not return "succeeded" from a client/terminal redirect.
  // Success is established only by a verified server-side event or status lookup.
  expiresAt?: string;
};

export type NormalizedPosEvent = {
  providerCode: string;
  providerEventId: string;
  providerReference: string;
  eventType: string;
  status: PosPaymentStatus;
  amountMinor?: string;
  currency?: string;
  occurredAt?: string;
};

export interface PosProviderAdapter {
  readonly capabilities: PosProviderCapabilities;
  registerTerminal(input: RegisterTerminalInput): Promise<RegisteredTerminal>;
  getTerminalStatus(merchantId: string, terminalRef: string): Promise<RegisteredTerminal>;
  createPaymentIntent(input: CreatePosPaymentInput): Promise<ProviderPaymentResult>;
  getPaymentStatus(merchantId: string, providerReference: string): Promise<NormalizedPosEvent>;
  verifyAndNormalizeWebhook(
    rawBody: Uint8Array,
    headers: Record<string, string | string[] | undefined>
  ): Promise<NormalizedPosEvent | null>;
}

export class PosProviderNotConfiguredError extends Error {
  readonly code = "POS_PROVIDER_NOT_CONFIGURED";
  constructor(providerCode: string) {
    super(`POS provider "${providerCode}" is not configured for this environment`);
    this.name = "PosProviderNotConfiguredError";
  }
}

/**
 * Explicit allow-list registry. The default application registry should be empty
 * until a provider's sandbox access and adapter tests have been approved.
 */
export class PosProviderRegistry {
  private readonly adapters = new Map<string, PosProviderAdapter>();

  register(adapter: PosProviderAdapter): void {
    const code = adapter.capabilities.providerCode.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{1,49}$/.test(code)) {
      throw new Error("Invalid POS provider code");
    }
    if (this.adapters.has(code)) {
      throw new Error(`POS provider "${code}" is already registered`);
    }
    this.adapters.set(code, adapter);
  }

  get(providerCode: string): PosProviderAdapter {
    const adapter = this.adapters.get(providerCode.trim().toLowerCase());
    if (!adapter) throw new PosProviderNotConfiguredError(providerCode);
    return adapter;
  }

  listCapabilities(): PosProviderCapabilities[] {
    return [...this.adapters.values()].map((adapter) => adapter.capabilities);
  }
}

/** No provider is enabled by default; never register a mock adapter in production. */
export const posProviderRegistry = new PosProviderRegistry();
