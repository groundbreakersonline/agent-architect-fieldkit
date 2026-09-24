/**
 * A deliberately awkward enterprise backend.
 *
 * This stands in for the systems an agent actually has to talk to in production:
 * a CRM that rate-limits, a ticketing system that returns XML, a billing service
 * that occasionally times out, and an identity provider that expires tokens at the
 * worst possible moment.
 *
 * Every failure mode here is one that shows up in real deployments. The point of
 * the kit is not to pretend they do not happen, but to make the agent's behaviour
 * under failure deterministic and reviewable.
 */
import { Rng } from '../util/rng';

export type ChaosFlag =
  | 'rateLimit'
  | 'serverError'
  | 'timeout'
  | 'tokenExpiry'
  | 'duplicateSubmit'
  | 'slowCrm'
  | 'flapping'
  | 'crmUnavailable';

export type ChaosConfig = Record<ChaosFlag, boolean>;

export const NO_CHAOS: ChaosConfig = {
  rateLimit: false,
  serverError: false,
  timeout: false,
  tokenExpiry: false,
  duplicateSubmit: false,
  slowCrm: false,
  flapping: false,
  crmUnavailable: false,
};

export const CHAOS_LABELS: Record<ChaosFlag, { label: string; note: string }> = {
  rateLimit: {
    label: '429 rate limit',
    note: 'CRM throttles the agent. Retry-After: 1.',
  },
  serverError: {
    label: '500 server error',
    note: 'Ticketing service throws on first attempt.',
  },
  timeout: {
    label: 'Dependency timeout',
    note: 'The CRM or billing service does not answer. The shared turn budget must save the caller from silence.',
  },
  tokenExpiry: {
    label: 'Token expired mid-call',
    note: 'IdP invalidates the access token between two calls.',
  },
  duplicateSubmit: {
    label: 'Duplicate submit',
    note: 'The same write is replayed. Idempotency must absorb it.',
  },
  slowCrm: {
    label: 'Slow CRM (+2.4s)',
    note: 'Pushes the turn past the conversational latency budget.',
  },
  flapping: {
    label: 'Flapping dependency',
    note: 'Repeated failures. The circuit breaker must open.',
  },
  crmUnavailable: {
    label: 'CRM unavailable',
    note: 'CRM returns a sustained 503; ticketing stays available so recovery can open a case.',
  },
};

export interface ApiRequest {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  headers: Record<string, string>;
  body?: unknown;
  /** Deterministic per-call identifier, surfaced in the evidence pack. */
  callId: string;
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  /** Wall-clock cost of this call, in ms. */
  latencyMs: number;
  /** Set when the dependency never answered. The caller's budget has to handle it. */
  timedOut?: boolean;
}

export type Transport = (req: ApiRequest) => Promise<ApiResponse>;

interface TokenRecord {
  token: string;
  expiresAt: number;
}

const POLICY = {
  policyNumber: 'IT-2026-004571',
  product: 'Auto Protetta',
  status: 'active',
  holder: {
    surname: 'Rossi',
    givenName: 'Giulia',
    taxCode: 'RSSGLI85M41F205X',
    email: 'g.rossi@example.it',
    phone: '+39 02 5550 1188',
  },
  address: {
    street: 'Via Melchiorre Gioia',
    civic: '42',
    postalCode: '20124',
    city: 'Milano',
    province: 'MI',
    country: 'IT',
  },
  renewalDate: '2026-11-30',
  premiumEur: 486.5,
};

const CLAIMS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<claims xmlns="urn:insurer:claims:v1" count="2">
  <claim id="SIN-2026-88213" status="in_review" openedOn="2026-08-14">
    <cause code="04">Collision, third party at fault</cause>
    <reserve currency="EUR">2450.00</reserve>
    <handler id="U-3391">Marchetti, Paolo</handler>
  </claim>
  <claim id="SIN-2025-40117" status="settled" openedOn="2025-03-02">
    <cause code="11">Windscreen</cause>
    <reserve currency="EUR">0.00</reserve>
    <handler id="U-3391">Marchetti, Paolo</handler>
  </claim>
</claims>`;

export interface EnterpriseApi {
  transport: Transport;
  /** Chaos is mutable so the console can flip a failure on mid-conversation. */
  chaos: ChaosConfig;
  /** Every write the backend actually accepted, in order. Used to prove idempotency. */
  acceptedWrites: Array<{ key: string; path: string; at: number }>;
  /** Reset token state between runs. */
  reset(): void;
  /** Force the next authenticated call to fail with 401. */
  expireTokenNow(): void;
}

export function createEnterpriseApi(
  chaos: ChaosConfig,
  rng: Rng = new Rng(7),
): EnterpriseApi {
  let token: TokenRecord | null = null;
  let forcedExpiry = false;
  const seenIdempotencyKeys = new Map<string, ApiResponse>();
  const acceptedWrites: EnterpriseApi['acceptedWrites'] = [];
  const authAttemptsRef = { n: 0 };
  const perPathCounts = new Map<string, number>();
  let clock = 0;

  const bump = (key: string): number => {
    const n = (perPathCounts.get(key) ?? 0) + 1;
    perPathCounts.set(key, n);
    return n;
  };

  const ok = (body: unknown, latencyMs: number): ApiResponse => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body,
    latencyMs,
  });

  const err = (
    status: number,
    code: string,
    message: string,
    latencyMs: number,
    headers: Record<string, string> = {},
  ): ApiResponse => ({
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: { error: { code, message } },
    latencyMs,
  });

  const transport: Transport = async (req) => {
    clock += 1;
    let latency = rng.int(38, 120);

    // --- identity provider -------------------------------------------------
    if (req.path === '/oauth/token') {
      await Promise.resolve(latency);
      token = {
        token: `tok_${Math.floor(rng.next() * 1e9).toString(36)}`,
        expiresAt: clock + 8,
      };
      forcedExpiry = false;
      return ok(
        { access_token: token.token, token_type: 'Bearer', expires_in: 300 },
        latency,
      );
    }

    // --- auth gate ---------------------------------------------------------
    const bearer = (req.headers['authorization'] ?? '').replace(/^Bearer\s+/i, '');
    const authAttempts = (authAttemptsRef.n += 1);
    const expireThisCall = chaos.tokenExpiry && authAttempts === 2;

    if (expireThisCall || forcedExpiry || !token || bearer !== token.token) {
      forcedExpiry = false;
      return err(401, 'invalid_token', 'Access token expired or unknown.', latency, {
        'www-authenticate': 'Bearer error="invalid_token"',
      });
    }

    // --- idempotency replay ------------------------------------------------
    const idemKey = req.headers['idempotency-key'];
    if (idemKey && seenIdempotencyKeys.has(idemKey)) {
      return { ...seenIdempotencyKeys.get(idemKey)!, headers: { ...seenIdempotencyKeys.get(idemKey)!.headers, 'x-idempotent-replay': 'true' }, latencyMs: rng.int(20, 45) };
    }

    const isWrite = req.method !== 'GET';

    if (isWrite && chaos.duplicateSubmit && idemKey) {
      // The first submission succeeded but the response was lost in transit.
      // A correct client must retry with the same key and get the original result.
      seenIdempotencyKeys.set(idemKey, ok({ accepted: true, replay: false }, 0));
      acceptedWrites.push({ key: idemKey, path: req.path, at: clock });
      return err(504, 'gateway_timeout', 'Upstream did not acknowledge in time.', latency);
    }

    // Chaos is deterministic. A failure that happens "sometimes" cannot be
    // demonstrated, cannot be tested, and cannot be put in front of a customer.
    if (chaos.crmUnavailable && req.path.startsWith('/crm')) {
      return err(503, 'service_unavailable', 'CRM is not healthy.', latency);
    }

    if (chaos.flapping) {
      return err(503, 'service_unavailable', 'Dependency is not healthy.', latency);
    }

    if (chaos.rateLimit && req.path.startsWith('/crm') && bump('crm') <= 2) {
      return err(429, 'rate_limited', 'Too many requests.', latency, { 'retry-after': '1' });
    }

    if (chaos.serverError && req.path === '/ticketing/v1/cases' && bump('ticketing') <= 1) {
      return err(500, 'internal_error', 'Ticketing service unavailable.', latency);
    }

    if (
      chaos.timeout &&
      (req.path.startsWith('/billing') || req.path.startsWith('/crm'))
    ) {
      // The selected dependency never answers. Modelled as a response that arrives
      // after the caller's per-attempt ceiling, so replay remains deterministic.
      return {
        status: 0,
        headers: {},
        body: { error: { code: 'gateway_timeout', message: 'Billing did not respond.' } },
        latencyMs: 1200,
        timedOut: true,
      };
    }

    if (chaos.slowCrm && req.path.startsWith('/crm')) {
      latency += 2400;
    }

    // --- routes ------------------------------------------------------------
    // Query strings are part of the request, not part of the route.
    const route = req.path.split('?')[0]!;

    if (route.startsWith('/crm/v2/policies/') && req.method === 'GET') {
      const policyNumber = decodeURIComponent(route.split('/').pop() ?? '');
      if (policyNumber !== POLICY.policyNumber) {
        return err(404, 'policy_not_found', `No policy ${policyNumber}.`, latency);
      }
      return ok(POLICY, latency);
    }

    if (route.endsWith('/address') && req.method === 'POST') {
      const next = (req.body as { address?: typeof POLICY.address })?.address;
      if (!next?.street || !next.postalCode || !next.city) {
        return err(422, 'validation_failed', 'street, postalCode and city are required.', latency);
      }
      if (idemKey) {
        seenIdempotencyKeys.set(idemKey, ok({ accepted: true, replay: false }, 0));
        acceptedWrites.push({ key: idemKey, path: req.path, at: clock });
      }
      return ok(
        { accepted: true, policyNumber: POLICY.policyNumber, effectiveFrom: '2026-10-01' },
        latency,
      );
    }

    if (route === '/claims/v1/claims') {
      return {
        status: 200,
        headers: { 'content-type': 'application/xml' },
        body: CLAIMS_XML,
        latencyMs: latency,
      };
    }

    if (route === '/ticketing/v1/cases' && req.method === 'POST') {
      if (idemKey) {
        seenIdempotencyKeys.set(idemKey, ok({ accepted: true, replay: false }, 0));
        acceptedWrites.push({ key: idemKey, path: req.path, at: clock });
      }
      const caseId = `CS-${rng.int(100000, 999999)}`;
      return ok({ caseId, priority: 'normal', sla: '2026-09-26T18:00:00Z' }, latency);
    }

    if (route === '/billing/v1/refunds' && req.method === 'POST') {
      if (idemKey) {
        seenIdempotencyKeys.set(idemKey, ok({ accepted: true, replay: false }, 0));
        acceptedWrites.push({ key: idemKey, path: req.path, at: clock });
      }
      return ok({ refundId: `RMB-${rng.int(10000, 99999)}`, status: 'queued' }, latency);
    }

    return err(404, 'not_found', `No route for ${req.method} ${req.path}.`, latency);
  };

  return {
    transport,
    chaos,
    acceptedWrites,
    reset() {
      token = null;
      forcedExpiry = false;
      seenIdempotencyKeys.clear();
      acceptedWrites.length = 0;
      authAttemptsRef.n = 0;
      perPathCounts.clear();
      clock = 0;
    },
    expireTokenNow() {
      forcedExpiry = true;
    },
  };
}

export const POLICY_FIXTURE = POLICY;
export const CLAIMS_XML_FIXTURE = CLAIMS_XML;
