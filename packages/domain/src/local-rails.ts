import { REMIT_CORRIDORS, SANDBOX_KINDS, sampleEcgToken, sandboxOutcome, sandboxQuote, type SandboxKind, type SandboxQuote, type SandboxRequest } from './sandbox';

export type RailStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'REVIEW';

export interface RailIntent {
  id: string;
  kind: SandboxKind;
  provider: string;
  target: string;
  amountUnits: bigint;
  providerRef: string | null;
}

export interface RailEvidence {
  providerRef: string;
  status: RailStatus;
  token: string | null;
  simulated: boolean;
}

export interface LocalRailProvider {
  readonly name: string;
  readonly live: boolean;
  quote(req: SandboxRequest): SandboxQuote;
  validateRecipient(kind: SandboxKind, target: string): boolean;
  initiate(intent: RailIntent): { providerRef: string; status: 'PENDING' };
  inquire(intent: RailIntent, tokenDigits: () => string): RailEvidence;
  verifyEvidence(intent: RailIntent, evidence: RailEvidence): boolean;
  refund(intent: RailIntent): { status: 'RELEASED' };
  reconcile(intents: RailIntent[]): Array<{ id: string; reason: string }>;
}

export class SimulatedRailProvider implements LocalRailProvider {
  readonly live = false;

  constructor(
    readonly name: string,
    private readonly simulatedGhsPerUsd: string,
  ) {}

  quote(req: SandboxRequest): SandboxQuote {
    return sandboxQuote(req, this.simulatedGhsPerUsd);
  }

  validateRecipient(kind: SandboxKind, target: string): boolean {
    try {
      sandboxQuote({ kind, provider: SANDBOX_KINDS[kind].providers[0], target, amountGhs: '1', productId: null }, this.simulatedGhsPerUsd);
      return true;
    } catch {
      return false;
    }
  }

  initiate(intent: RailIntent): { providerRef: string; status: 'PENDING' } {
    return { providerRef: `SIM-${intent.id}`, status: 'PENDING' };
  }

  inquire(intent: RailIntent, tokenDigits: () => string): RailEvidence {
    const status = sandboxOutcome(intent.target);
    return {
      providerRef: intent.providerRef ?? `SIM-${intent.id}`,
      status,
      token: status === 'SUCCEEDED' && intent.kind === 'ECG' ? sampleEcgToken(tokenDigits()) : null,
      simulated: true,
    };
  }

  verifyEvidence(intent: RailIntent, evidence: RailEvidence): boolean {
    return evidence.simulated && evidence.providerRef === (intent.providerRef ?? `SIM-${intent.id}`);
  }

  refund(): { status: 'RELEASED' } {
    return { status: 'RELEASED' };
  }

  reconcile(): Array<{ id: string; reason: string }> {
    return [];
  }
}

export function localRailProvider(kind: SandboxKind, provider: string, simulatedGhsPerUsd: string): LocalRailProvider {
  const known = SANDBOX_KINDS[kind]?.providers.includes(provider) || Object.values(REMIT_CORRIDORS).some((c) => c.methods.some((m) => m.kind === kind && m.providers.includes(provider)));
  if (!known) throw new Error(`no rail provider ${provider} for ${kind}`);
  return new SimulatedRailProvider(`sandbox:${provider}`, simulatedGhsPerUsd);
}
