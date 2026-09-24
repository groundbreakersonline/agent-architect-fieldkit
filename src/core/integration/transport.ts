/**
 * A fetch-based HTTP transport adapter.
 *
 * The integration layer in this kit does not know or care what is behind the
 * `Transport` interface. Everything above it - retries, breaking, budgets,
 * idempotency and the saga - are transport-agnostic. This adapter exercises the
 * transport seam with fetch. A production CRM still needs its own authentication,
 * endpoint/schema mapping, data controls and interoperability testing.
 *
 * This is reference code, not a production-validated CRM connector.
 */
import type { ApiRequest, ApiResponse, Transport } from '../sim/enterpriseApi';

export interface FetchTransportOptions {
  baseUrl: string;
  /** Injected so the transport is testable without a network. */
  fetchImpl?: typeof fetch;
  /** Hard ceiling for one attempt. The turn budget still governs the whole turn. */
  timeoutMs?: number;
  /** Applied to every request. Useful for correlation ids in real deployments. */
  defaultHeaders?: Record<string, string>;
  /** Called with the raw response so a deployment can log or redact it. */
  onResponse?: (req: ApiRequest, res: ApiResponse) => void;
}

export class HttpTransportError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'HttpTransportError';
  }
}

/**
 * Maps HTTP onto the transport contract the client expects.
 *
 * Note what it does with a network failure: it does not throw. It returns a response
 * shaped like a gateway timeout, because that is what the resilience layer knows how
 * to reason about. Throwing from a transport is how retry logic gets bypassed.
 */
export function createFetchTransport(options: FetchTransportOptions): Transport {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error('No fetch implementation available. Pass fetchImpl explicitly.');
  }
  const timeoutMs = options.timeoutMs ?? 8000;
  const base = options.baseUrl.replace(/\/+$/, '');

  return async (req: ApiRequest): Promise<ApiResponse> => {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = {
      ...options.defaultHeaders,
      ...req.headers,
      'x-correlation-id': req.callId,
    };

    try {
      const res = await fetchImpl(`${base}${req.path}`, {
        method: req.method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: controller.signal,
      });

      const latencyMs = Date.now() - started;
      const contentType = res.headers.get('content-type') ?? '';
      const text = await res.text();
      const body = contentType.includes('json') ? safeJson(text) : text;

      const out: ApiResponse = {
        status: res.status,
        headers: headersToObject(res.headers),
        body,
        latencyMs,
      };
      options.onResponse?.(req, out);
      return out;
    } catch (err) {
      const latencyMs = Date.now() - started;
      const aborted = err instanceof Error && err.name === 'AbortError';
      const out: ApiResponse = {
        status: 0,
        headers: {},
        body: {
          error: {
            code: aborted ? 'gateway_timeout' : 'transport_error',
            message: aborted
              ? `No response inside ${timeoutMs}ms.`
              : err instanceof Error
                ? err.message
                : String(err),
          },
        },
        latencyMs: aborted ? timeoutMs : latencyMs,
        timedOut: true,
      };
      options.onResponse?.(req, out);
      return out;
    } finally {
      clearTimeout(timer);
    }
  };
}

function safeJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}
