/** Shared vocabulary for the integration layer and the evidence trail. */

export type TraceKind =
  | 'auth'
  | 'http'
  | 'retry'
  | 'breaker'
  | 'timeout'
  | 'mapping'
  | 'saga'
  | 'agent'
  | 'guardrail'
  | 'compliance';

export type TraceStatus = 'ok' | 'warn' | 'error' | 'info';

export interface TraceEvent {
  /** Virtual milliseconds since the conversation started. */
  at: number;
  kind: TraceKind;
  status: TraceStatus;
  label: string;
  detail?: string;
  latencyMs?: number;
  attempt?: number;
  callId?: string;
  meta?: Record<string, unknown>;
}

export type TraceSink = (event: TraceEvent) => void;

export const noopTrace: TraceSink = () => undefined;

export function collector(): { events: TraceEvent[]; sink: TraceSink } {
  const events: TraceEvent[] = [];
  return { events, sink: (e) => events.push(e) };
}

export interface Clock {
  now(): number;
  advance(ms: number): number;
}

/** Deterministic clock used in tests and in the console. */
export function manualClock(start = 0): Clock {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
      return t;
    },
  };
}
