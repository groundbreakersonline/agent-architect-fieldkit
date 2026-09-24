/**
 * The enterprise client an agent actually calls.
 *
 * Everything above this file is infrastructure. This is the surface the agent
 * touches, and it is deliberately the only surface: no raw HTTP, no token handling,
 * no retry logic leaking into prompt design.
 *
 * Every operation returns an Outcome rather than throwing, because an agent needs a
 * decision, not a stack trace.
 */
import type { Transport } from '../sim/enterpriseApi';
import { ClientCredentialsTokenProvider, type TokenProvider } from './auth';
import { classify, type IntegrationError } from './errors';
import { IdempotencyLedger } from './idempotency';
import { parseXml, findAll, type FieldMap } from './mapping';
import {
  CallBudgetExceededError,
  CircuitBreaker,
  DEFAULT_BREAKER,
  DEFAULT_RETRY,
  RetryableFailure,
  RetryExhaustedError,
  TurnBudget,
  withRetry,
  type AttemptRecord,
  type BreakerPolicy,
  type RetryPolicy,
} from './resilience';
import type { Clock, TraceSink } from './types';
import { noopTrace } from './types';

export type Outcome<T> =
  | {
      ok: true;
      value: T;
      attempts: AttemptRecord[];
      replayed: boolean;
      latencyMs: number;
    }
  | {
      ok: false;
      error: IntegrationError;
      attempts: AttemptRecord[];
      latencyMs: number;
    };

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  body?: unknown;
  /** Stable, intent-derived. Required for every write. */
  idempotencyKey?: string;
  /** Which breaker and metric bucket this call belongs to. */
  dependency: string;
  label: string;
  accept?: 'json' | 'xml';
}

export interface EnterpriseClientOptions {
  baseUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  transport: Transport;
  clock: Clock;
  trace?: TraceSink;
  budget: TurnBudget;
  ledger?: IdempotencyLedger;
  retry?: RetryPolicy;
  breaker?: BreakerPolicy;
}

export class EnterpriseClient {
  readonly tokens: TokenProvider;
  readonly ledger: IdempotencyLedger;
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly trace: TraceSink;
  private readonly retry: RetryPolicy;
  private readonly breakerPolicy: BreakerPolicy;
  private callSeq = 0;

  constructor(private readonly opts: EnterpriseClientOptions) {
    this.trace = opts.trace ?? noopTrace;
    this.retry = opts.retry ?? DEFAULT_RETRY;
    this.breakerPolicy = opts.breaker ?? DEFAULT_BREAKER;
    this.ledger = opts.ledger ?? new IdempotencyLedger();
    this.tokens = new ClientCredentialsTokenProvider({
      tokenUrl: opts.tokenUrl,
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      transport: opts.transport,
      clock: opts.clock,
      trace: this.trace,
      spendBudget: (ms, label) => opts.budget.spend(ms, label),
    });
  }

  private breakerFor(dependency: string): CircuitBreaker {
    let b = this.breakers.get(dependency);
    if (!b) {
      b = new CircuitBreaker(dependency, this.breakerPolicy, this.opts.clock, this.trace);
      this.breakers.set(dependency, b);
    }
    return b;
  }

  breakerState(dependency: string): string {
    return this.breakers.get(dependency)?.currentState ?? 'closed';
  }

  async request<T = unknown>(req: RequestOptions): Promise<Outcome<T>> {
    const { clock, transport } = this.opts;
    const startedAt = clock.now();
    const callId = `c${++this.callSeq}`;
    const breaker = this.breakerFor(req.dependency);

    const execute = async (): Promise<{ value: T; replayed: boolean; attempts: AttemptRecord[] }> => {
      const retryOutcome = await withRetry(
        async (attemptNumber) => {
          const token = await this.tokens.getToken();

          const res = await transport({
            method: req.method,
            path: req.path,
            callId,
            headers: {
              authorization: `Bearer ${token}`,
              accept: req.accept === 'xml' ? 'application/xml' : 'application/json',
              ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}),
              ...(req.idempotencyKey ? { 'idempotency-key': req.idempotencyKey } : {}),
            },
            body: req.body,
          });

          // TurnBudget advances the shared clock and spends this dependency latency.
          this.opts.budget.spend(res.latencyMs, req.label);

          if (res.timedOut) {
            this.trace({
              at: clock.now(),
              kind: 'timeout',
              status: 'error',
              label: `${req.method} ${req.path}`,
              detail: `No response inside the per-attempt ceiling of ${res.latencyMs}ms.`,
              latencyMs: res.latencyMs,
              attempt: attemptNumber,
              callId,
              meta: { dependency: req.dependency, status: 0 },
            });
            throw new RetryableFailure(
              'Dependency did not answer inside the attempt ceiling.',
              undefined,
              504,
              'attempt_ceiling',
            );
          }

          this.trace({
            at: clock.now(),
            kind: 'http',
            status: res.status < 400 ? 'ok' : 'warn',
            label: `${req.method} ${req.path}`,
            detail:
              res.status < 400
                ? `${res.status} in ${res.latencyMs}ms`
                : `${res.status} ${String((res.body as { error?: { code?: string } })?.error?.code ?? '')}`,
            latencyMs: res.latencyMs,
            attempt: attemptNumber,
            callId,
            meta: { dependency: req.dependency, status: res.status },
          });

          if (res.status === 401) {
            // Expired token is infrastructure noise. Refresh and retry, silently.
            this.tokens.invalidate();
            throw new RetryableFailure('Access token expired; refreshed.', 0, 401, 'invalid_token');
          }

          if (res.status === 429) {
            const retryAfter = Number(res.headers['retry-after'] ?? '1') * 1000;
            throw new RetryableFailure('Rate limited by dependency.', retryAfter, 429, 'rate_limited');
          }

          if (res.status >= 500) {
            const code = (res.body as { error?: { code?: string } })?.error?.code;
            throw new RetryableFailure(
              `Dependency error ${res.status} ${code ?? ''}`.trim(),
              undefined,
              res.status,
              code,
            );
          }

          if (res.status >= 400) {
            // 4xx other than 401/429 is a decision, not a transient fault.
            const body = res.body as { error?: { code?: string; message?: string } };
            const error = classify(
              res.status,
              body?.error?.code,
              body?.error?.message ?? `HTTP ${res.status}`,
              attemptNumber,
              callId,
            );
            const fatal = new Error(error.message);
            Object.assign(fatal, { integrationError: error });
            throw fatal;
          }

          const replayed = res.headers['x-idempotent-replay'] === 'true';
          return { value: res.body as T, replayed };
        },
        this.retry,
        {
          clock,
          trace: this.trace,
          label: req.label,
          spendBudget: (ms, label) => this.opts.budget.spend(ms, label),
        },
      );

      return {
        value: retryOutcome.value.value,
        replayed: retryOutcome.value.replayed,
        attempts: retryOutcome.attempts,
      };
    };

    try {
      const result = await breaker.execute(execute);
      return {
        ok: true,
        value: result.value,
        attempts: result.attempts,
        replayed: result.replayed,
        latencyMs: clock.now() - startedAt,
      };
    } catch (err) {
      const attempts =
        err instanceof RetryExhaustedError
          ? (err.attempts as AttemptRecord[])
          : ([{ attempt: 1, outcome: 'fatal', reason: String(err), delayMs: 0 }] as AttemptRecord[]);

      const carried = (err as { integrationError?: IntegrationError }).integrationError;
      const wrapped = err instanceof RetryExhaustedError ? err.last : err;
      const inner = (wrapped as { integrationError?: IntegrationError }).integrationError;
      // A retryable failure carries its own status and code, so an exhausted 5xx is
      // still classified as a dependency failure instead of falling through to
      // `unknown`.
      const retryable = wrapped as { httpStatus?: number; code?: string };

      // A turn that ran out of budget is a timeout from the caller's point of view,
      // regardless of which dependency ate the milliseconds.
      const budgetBlown =
        wrapped instanceof CallBudgetExceededError || err instanceof CallBudgetExceededError;

      const error: IntegrationError = budgetBlown
        ? classify(
            504,
            'turn_budget_exceeded',
            `The turn spent its whole ${this.opts.budget.budgetMs}ms budget.`,
            attempts.length,
            callId,
          )
        : (inner ??
          carried ??
          classify(
            retryable.httpStatus,
            retryable.code ?? (breaker.currentState === 'open' ? 'circuit_open' : undefined),
            wrapped instanceof Error ? wrapped.message : String(err),
            attempts.length,
            callId,
          ));

      this.trace({
        at: clock.now(),
        kind: 'http',
        status: 'error',
        label: `${req.label} gave up`,
        detail: `${error.kind} after ${attempts.length} attempt(s): ${error.message}`,
        callId,
      });

      return { ok: false, error, attempts, latencyMs: clock.now() - startedAt };
    }
  }

  // -------------------------------------------------------------------------
  // Domain operations
  // -------------------------------------------------------------------------

  async lookupPolicy(policyNumber: string): Promise<Outcome<Record<string, unknown>>> {
    return this.request<Record<string, unknown>>({
      method: 'GET',
      path: `/crm/v2/policies/${encodeURIComponent(policyNumber)}`,
      dependency: 'crm',
      label: 'crm.lookupPolicy',
    });
  }

  async updateAddress(
    policyNumber: string,
    address: Record<string, string>,
    turnId: string,
  ): Promise<Outcome<{ accepted: boolean }>> {
    const key = this.ledger.derive('crm.updateAddress', policyNumber, turnId);
    return this.request<{ accepted: boolean }>({
      method: 'POST',
      path: `/crm/v2/policies/${encodeURIComponent(policyNumber)}/address`,
      body: { address },
      idempotencyKey: key,
      dependency: 'crm',
      label: 'crm.updateAddress',
    });
  }

  async getClaims(policyNumber: string): Promise<Outcome<Array<Record<string, unknown>>>> {
    const res = await this.request<unknown>({
      method: 'GET',
      path: `/claims/v1/claims?policyNumber=${encodeURIComponent(policyNumber)}`,
      dependency: 'claims',
      label: 'claims.list',
      accept: 'xml',
    });

    if (!res.ok) return res;

    // The XML boundary is where a lot of deployments quietly lose attributes.
    const doc = parseXml(String(res.value));
    const claims = findAll(doc, 'claim').map((node) => {
      const cause = findAll(node, 'cause')[0];
      const reserve = findAll(node, 'reserve')[0];
      const handler = findAll(node, 'handler')[0];
      return {
        id: node.attributes.id,
        status: node.attributes.status,
        openedOn: node.attributes.openedOn,
        causeCode: cause?.attributes.code,
        cause: cause?.text,
        reserveEur: Number(reserve?.text ?? 0),
        handlerId: handler?.attributes.id,
      };
    });

    return { ...res, value: claims };
  }

  async openCase(
    input: { subject: string; body: string; priority?: string },
    turnId: string,
  ): Promise<Outcome<{ caseId: string }>> {
    const key = this.ledger.derive('ticketing.openCase', input.subject, turnId);
    return this.request<{ caseId: string }>({
      method: 'POST',
      path: '/ticketing/v1/cases',
      body: input,
      idempotencyKey: key,
      dependency: 'ticketing',
      label: 'ticketing.openCase',
    });
  }

  async issueRefund(
    input: { policyNumber: string; amountEur: number; reason: string },
    turnId: string,
  ): Promise<Outcome<{ refundId: string }>> {
    const key = this.ledger.derive('billing.refund', input.policyNumber, turnId);
    return this.request<{ refundId: string }>({
      method: 'POST',
      path: '/billing/v1/refunds',
      body: input,
      idempotencyKey: key,
      dependency: 'billing',
      label: 'billing.issueRefund',
    });
  }
}

/** Slot contract the agent is allowed to read. Nothing else crosses the boundary. */
export const POLICY_SLOTS: FieldMap[] = [
  { to: 'policyNumber', from: 'policyNumber', required: true },
  { to: 'product', from: 'product' },
  { to: 'policyStatus', from: 'status' },
  { to: 'callerLastName', from: 'holder.surname', transform: 'titleCase', required: true },
  { to: 'callerFirstName', from: 'holder.givenName', transform: 'titleCase' },
  { to: 'taxCodeMasked', from: 'holder.taxCode', transform: 'maskTaxCode' },
  { to: 'addressOnFile', from: 'address', transform: 'joinAddress' },
  { to: 'renewalDateIt', from: 'renewalDate', transform: 'isoToItDate' },
  { to: 'premiumEur', from: 'premiumEur', transform: 'eur' },
];
