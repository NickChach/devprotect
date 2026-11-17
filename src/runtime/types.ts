export type Actor = 'shell' | 'javascript' | 'loader';
export interface RuntimeEvent {
  sequence: number;
  actor: Actor;
  operation: string;
  target: string;
  outcome: 'simulated' | 'denied' | 'unsupported' | 'failed';
  body?: string;
}
export interface RuntimeGap { kind: 'denied' | 'unsupported' | 'execution'; reason: string }
export interface RuntimeResult {
  status: 'completed' | 'failed' | 'timed-out' | 'cancelled' | 'protocol-error' | 'unavailable';
  error?: string;
  events: RuntimeEvent[];
  coverage: { status: 'incomplete'; gaps: RuntimeGap[] };
}
export interface CapabilityPolicy {
  read: readonly string[];
  write: readonly string[];
  network: Readonly<Record<string, { status: number; body: string }>>;
}
export interface BrokerResponse { type: 'response'; ok: boolean; value?: unknown; error?: string }
