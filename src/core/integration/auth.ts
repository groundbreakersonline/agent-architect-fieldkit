/**
 * OAuth2 client-credentials with single-flight refresh.
 *
 * The detail that matters in production: when a token expires, every in-flight
 * request discovers it at the same moment. Without single-flight, a fleet of
 * concurrent turns stampedes the identity provider and turns a 300ms blip into a
 * throttling incident.
 */
import type { Transport } from '../sim/enterpriseApi';
import type { Clock, TraceSink } from './types';
import { noopTrace } from './types';

export interface TokenProvider {
  getToken(force?: boolean): Promise<string>;
  invalidate(): void;
  peek(): { expiresAt: number } | null;
}

export interface ClientCredentialsOptions {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  transport: Transport;
  clock: Clock;
  trace?: TraceSink;
  /** Use the conversational turn budget when this provider is owned by a client. */
  spendBudget?: (ms: number, label: string) => void;
  /** Refresh this long before real expiry, to cover clock skew. */
  skewMs?: number;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

export class ClientCredentialsTokenProvider implements TokenProvider {
  private cached: CachedToken | null = null;
  private inFlight: Promise<string> | null = null;
  private readonly skewMs: number;
  private readonly trace: TraceSink;

  constructor(private readonly opts: ClientCredentialsOptions) {
    this.skewMs = opts.skewMs ?? 30_000;
    this.trace = opts.trace ?? noopTrace;
  }

  peek(): { expiresAt: number } | null {
    return this.cached ? { expiresAt: this.cached.expiresAt } : null;
  }

  invalidate(): void {
    this.cached = null;
  }

  async getToken(force = false): Promise<string> {
    const { clock } = this.opts;

    if (!force && this.cached && clock.now() + this.skewMs < this.cached.expiresAt) {
      return this.cached.value;
    }

    // Single-flight: concurrent callers share one refresh, not one each.
    if (this.inFlight) {
      this.trace({
        at: clock.now(),
        kind: 'auth',
        status: 'info',
        label: 'Token refresh joined in flight',
        detail: 'A concurrent turn already triggered the refresh.',
      });
      return this.inFlight;
    }

    this.inFlight = this.fetchToken().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async fetchToken(): Promise<string> {
    const { clock, transport, tokenUrl, clientId, clientSecret } = this.opts;
    const started = clock.now();

    const res = await transport({
      method: 'POST',
      path: tokenUrl,
      callId: 'auth',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${base64(`${clientId}:${clientSecret}`)}`,
      },
      body: 'grant_type=client_credentials',
    });

    if (this.opts.spendBudget) this.opts.spendBudget(res.latencyMs, 'oauth.token');
    else clock.advance(res.latencyMs);

    if (res.status !== 200) {
      this.trace({
        at: clock.now(),
        kind: 'auth',
        status: 'error',
        label: 'Token request rejected',
        detail: `IdP returned ${res.status}.`,
        latencyMs: res.latencyMs,
      });
      throw new Error(`Token endpoint returned ${res.status}`);
    }

    const body = res.body as { access_token: string; expires_in: number };
    this.cached = {
      value: body.access_token,
      // expires_in is seconds; the virtual clock runs in ms.
      expiresAt: clock.now() + body.expires_in * 1000,
    };

    this.trace({
      at: clock.now(),
      kind: 'auth',
      status: 'ok',
      label: 'Access token issued',
      detail: `client_credentials, expires_in=${body.expires_in}s, skew=${this.skewMs}ms`,
      latencyMs: clock.now() - started,
    });

    return this.cached.value;
  }
}

function base64(input: string): string {
  // btoa is global in every browser and in Node 16+. No Buffer, no polyfill.
  return btoa(input);
}
