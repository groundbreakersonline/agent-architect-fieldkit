/**
 * Retry, circuit breaking and call budgets.
 *
 * Deliberately boring, deliberately explicit. The value of this file is not the
 * idea, it is that the policy is written down, identical for every dependency, and
 * measurable afterwards.
 */
import type { Clock, TraceSink } from './types';
import { noopTrace } from './types';

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Full jitter by default: spreads retries so a throttled fleet does not resynchronise. */
  jitter: 'full' | 'none';
  respectRetryAfter: boolean;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 220,
  maxDelayMs: 2400,
  jitter: 'full',
  respectRetryAfter: true,
};

export interface AttemptRecord {
  attempt: number;
  outcome: 'ok' | 'retryable' | 'fatal';
  reason?: string;
  delayMs: number;
}

export interface RetryOutcome<T> {
  value: T;
  attempts: AttemptRecord[];
  totalDelayMs: number;
}

export class RetryExhaustedError<T> extends Error {
  constructor(
    public readonly last: T,
    public readonly attempts: AttemptRecord[],
    public readonly totalDelayMs: number,
  ) {
    super(`Retry budget exhausted after ${attempts.length} attempt(s).`);
    this.name = 'RetryExhaustedError';
  }
}

export interface RetryContext {
  clock: Clock;
  trace?: TraceSink;
  label: string;
  /** Spend backoff against the same turn budget as dependency latency. */
  spendBudget?: (ms: number, label: string) => void;
}

/**
 * Runs `attempt` until it returns a value, or the policy is exhausted.
 * `attempt` signals a retryable failure by throwing `RetryableFailure`.
 */
/**
 * A failure the retry policy is allowed to absorb.
 *
 * It carries the HTTP status and error code, not just the message, because if the
 * retries run out this is the only thing left to classify the failure from. Without
 * them an exhausted 5xx degrades to `unknown` and the recovery script written for
 * that exact case never fires.
 */
export class RetryableFailure extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs?: number,
    public readonly httpStatus?: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'RetryableFailure';
  }
}

export async function withRetry<T>(
  attempt: (attemptNumber: number) => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY,
  ctx: RetryContext,
): Promise<RetryOutcome<T>> {
  const trace = ctx.trace ?? noopTrace;
  const attempts: AttemptRecord[] = [];
  let totalDelayMs = 0;

  for (let n = 1; n <= policy.maxAttempts; n += 1) {
    try {
      const value = await attempt(n);
      attempts.push({ attempt: n, outcome: 'ok', delayMs: 0 });
      return { value, attempts, totalDelayMs };
    } catch (err) {
      if (!(err instanceof RetryableFailure) || n === policy.maxAttempts) {
        attempts.push({
          attempt: n,
          outcome: 'fatal',
          reason: err instanceof Error ? err.message : String(err),
          delayMs: 0,
        });
        throw new RetryExhaustedError(err, attempts, totalDelayMs);
      }

      const exponential = Math.min(policy.baseDelayMs * 2 ** (n - 1), policy.maxDelayMs);
      const honoured =
        policy.respectRetryAfter && err.retryAfterMs !== undefined
          ? Math.min(err.retryAfterMs, policy.maxDelayMs)
          : exponential;
      const delay =
        policy.jitter === 'full' ? Math.floor(Math.random() * honoured) : honoured;

      attempts.push({
        attempt: n,
        outcome: 'retryable',
        reason: err.message,
        delayMs: delay,
      });
      totalDelayMs += delay;
      if (ctx.spendBudget) ctx.spendBudget(delay, `${ctx.label} retry backoff`);
      else ctx.clock.advance(delay);

      trace({
        at: ctx.clock.now(),
        kind: 'retry',
        status: 'warn',
        label: `${ctx.label} retry ${n}/${policy.maxAttempts - 1}`,
        detail: `${err.message} - waiting ${delay}ms${policy.jitter === 'full' ? ' (full jitter)' : ''}`,
        attempt: n,
        latencyMs: delay,
      });
    }
  }

  throw new Error('unreachable');
}

// ---------------------------------------------------------------------------
// Call budget
// ---------------------------------------------------------------------------

export class CallBudgetExceededError extends Error {
  constructor(
    public readonly budgetMs: number,
    public readonly spentMs: number,
  ) {
    super(`Conversational call budget of ${budgetMs}ms exceeded (spent ${spentMs}ms).`);
    this.name = 'CallBudgetExceededError';
  }
}

/**
 * A shared budget across every dependency touched inside one conversational turn.
 * Without this, each dependency happily respects its own timeout while the caller
 * listens to silence.
 */
export class TurnBudget {
  private spent = 0;

  constructor(
    public readonly budgetMs: number,
    private readonly clock: Clock,
    private readonly trace: TraceSink = noopTrace,
  ) {}

  get remainingMs(): number {
    return Math.max(0, this.budgetMs - this.spent);
  }

  /** Returns a timeout in ms that will not exceed the remaining budget. */
  slice(requestedMs: number): number {
    return Math.max(0, Math.min(requestedMs, this.remainingMs));
  }

  spend(ms: number, label: string): void {
    this.spent += ms;
    this.clock.advance(ms);
    if (this.remainingMs <= 0) {
      this.trace({
        at: this.clock.now(),
        kind: 'timeout',
        status: 'error',
        label: 'Turn budget exhausted',
        detail: `${label} consumed the remaining ${ms}ms of a ${this.budgetMs}ms turn.`,
        latencyMs: ms,
      });
      throw new CallBudgetExceededError(this.budgetMs, this.spent);
    }
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  if (timeoutMs <= 0) {
    throw new CallBudgetExceededError(0, 0);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerPolicy {
  failureThreshold: number;
  openMs: number;
  halfOpenProbes: number;
}

export const DEFAULT_BREAKER: BreakerPolicy = {
  failureThreshold: 3,
  openMs: 1500,
  halfOpenProbes: 1,
};

export class CircuitOpenError extends Error {
  constructor(public readonly retryAtMs: number) {
    super('Circuit is open. Failing fast instead of queueing the caller.');
    this.name = 'CircuitOpenError';
  }
}

export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private probes = 0;

  constructor(
    private readonly name: string,
    private readonly policy: BreakerPolicy,
    private readonly clock: Clock,
    private readonly trace: TraceSink = noopTrace,
  ) {}

  get currentState(): BreakerState {
    return this.state;
  }

  private transition(next: BreakerState, reason: string): void {
    if (this.state === next) return;
    const from = this.state;
    this.state = next;
    this.trace({
      at: this.clock.now(),
      kind: 'breaker',
      status: next === 'open' ? 'error' : 'info',
      label: `${this.name} breaker ${from} -> ${next}`,
      detail: reason,
    });
  }

  private checkOpen(): void {
    if (this.state !== 'open') return;
    if (this.clock.now() - this.openedAt >= this.policy.openMs) {
      this.probes = 0;
      this.transition('half_open', 'Cool-down elapsed. Allowing a single probe.');
      return;
    }
    throw new CircuitOpenError(this.openedAt + this.policy.openMs);
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.checkOpen();
    try {
      const value = await fn();
      if (this.state === 'half_open') {
        this.failures = 0;
        this.transition('closed', 'Probe succeeded. Traffic restored.');
      } else {
        this.failures = 0;
      }
      return value;
    } catch (err) {
      this.failures += 1;
      if (this.state === 'half_open') {
        this.probes += 1;
        this.openedAt = this.clock.now();
        this.transition('open', 'Probe failed. Re-opening.');
        throw err;
      }
      if (this.failures >= this.policy.failureThreshold) {
        this.openedAt = this.clock.now();
        this.transition(
          'open',
          `${this.failures} consecutive failures reached threshold ${this.policy.failureThreshold}.`,
        );
      }
      throw err;
    }
  }
}
