import { describe, expect, it } from 'vitest';
import { createFetchTransport } from '../src/core/integration/transport';
import type { ApiRequest } from '../src/core/sim/enterpriseApi';
import {
  createOpenAiCompatibleClient,
  runLiveConversation,
  LIVE_EXPLICIT_PROMPT,
  LIVE_STREAMLINED_PROMPT,
  type LlmClient,
} from '../src/core/regression/llm';
import { SCENARIOS } from '../src/core/regression/scenarios';

// ---------------------------------------------------------------------------
// A scripted model. No network, no key, deterministic.
// ---------------------------------------------------------------------------

function scripted(model: string, script: string[]): LlmClient {
  let i = 0;
  return {
    model,
    async complete() {
      const text = script[Math.min(i, script.length - 1)] ?? '';
      i += 1;
      return { text, inputTokens: 120, outputTokens: 30, latencyMs: 5 };
    },
  };
}

const req = (path: string): ApiRequest => ({
  method: 'GET',
  path,
  headers: {},
  callId: 'c1',
});

describe('transport: real HTTP mapping', () => {
  it('maps a JSON response without touching the resilience layer', async () => {
    const transport = createFetchTransport({
      baseUrl: 'https://crm.example.invalid',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-request-id': 'abc' },
        })) as unknown as typeof fetch,
    });

    const res = await transport(req('/v2/policies/1'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers['x-request-id']).toBe('abc');
    expect(res.timedOut).toBeUndefined();
  });

  it('passes the call id through as a correlation header', async () => {
    let seen: Record<string, string> = {};
    const transport = createFetchTransport({
      baseUrl: 'https://crm.example.invalid',
      defaultHeaders: { 'x-tenant': 'polaris' },
      fetchImpl: (async (_url: string, init: RequestInit) => {
        seen = init.headers as Record<string, string>;
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as unknown as typeof fetch,
    });

    await transport(req('/v2/policies/1'));
    expect(seen['x-correlation-id']).toBe('c1');
    expect(seen['x-tenant']).toBe('polaris');
  });

  it('returns XML as text rather than throwing', async () => {
    const transport = createFetchTransport({
      baseUrl: 'https://crm.example.invalid',
      fetchImpl: (async () =>
        new Response('<claims count="0"/>', {
          status: 200,
          headers: { 'content-type': 'application/xml' },
        })) as unknown as typeof fetch,
    });

    const res = await transport(req('/claims'));
    expect(typeof res.body).toBe('string');
    expect(res.body).toBe('<claims count="0"/>');
  });

  it('shapes a network failure as a timeout instead of throwing', async () => {
    // Throwing from a transport is how retry logic gets bypassed. The client has to
    // be able to reason about the failure, so the transport returns a response.
    const transport = createFetchTransport({
      baseUrl: 'https://crm.example.invalid',
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });

    const res = await transport(req('/v2/policies/1'));
    expect(res.status).toBe(0);
    expect(res.timedOut).toBe(true);
    expect((res.body as { error: { code: string } }).error.code).toBe('transport_error');
  });

  it('reports a non-2xx status as a status, not as an exception', async () => {
    const transport = createFetchTransport({
      baseUrl: 'https://crm.example.invalid',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { code: 'rate_limited' } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '2' },
        })) as unknown as typeof fetch,
    });

    const res = await transport(req('/v2/policies/1'));
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('2');
  });
});

describe('model client', () => {
  it('computes cost from token usage and the supplied prices', async () => {
    const client = createOpenAiCompatibleClient({
      apiKey: 'test',
      model: 'test-model',
      pricePerMillionInputUsd: 10,
      pricePerMillionOutputUsd: 30,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'ciao' } }],
            usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as unknown as typeof fetch,
    });

    const out = await client.complete([{ role: 'user', content: 'hi' }]);
    expect(out.text).toBe('ciao');
    expect(client.lastCostUsd).toBeCloseTo(40, 6);
  });

  it('does not report zero cost when a compatible endpoint omits usage', async () => {
    const client = createOpenAiCompatibleClient({
      apiKey: 'test',
      model: 'test-model',
      pricePerMillionInputUsd: 10,
      pricePerMillionOutputUsd: 30,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'ciao' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    });

    await client.complete([{ role: 'user', content: 'hi' }]);
    expect(client.lastCostUsd).toBeNull();
  });

  it('surfaces an endpoint error rather than returning empty text', async () => {
    const client = createOpenAiCompatibleClient({
      apiKey: 'test',
      model: 'test-model',
      fetchImpl: (async () =>
        new Response('unauthorized', { status: 401 })) as unknown as typeof fetch,
    });

    await expect(client.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(/401/);
  });

  it('uses OpenAI current token parameters and omits temperature by default', async () => {
    let sent: Record<string, unknown> = {};
    const client = createOpenAiCompatibleClient({
      apiKey: 'test',
      model: 'gpt-6-luna',
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch,
    });

    await client.complete([{ role: 'user', content: 'hi' }]);
    expect(sent.max_completion_tokens).toBe(400);
    expect(sent.max_tokens).toBeUndefined();
    expect(sent.temperature).toBeUndefined();
    expect(client.lastCostUsd).toBeNull();
  });

  it('allows legacy-compatible parameter names and an explicit temperature', async () => {
    let sent: Record<string, unknown> = {};
    const client = createOpenAiCompatibleClient({
      apiKey: 'test',
      model: 'test-model',
      maxTokensParam: 'max_tokens',
      temperature: 0.1,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    });

    await client.complete([{ role: 'user', content: 'hi' }]);
    expect(sent.max_tokens).toBe(400);
    expect(sent.max_completion_tokens).toBeUndefined();
    expect(sent.temperature).toBe(0.1);
  });
});

describe('live loop: fixed scenarios, real agent', () => {
  const s03 = SCENARIOS.find((s) => s.id === 'S03')!;

  it('replays every caller turn verbatim and allows a safe lookup of the misread identifier', async () => {
    const agent = scripted('scripted-good', [
      'Le rileggo il codice per conferma: i ti, duemilaventisei, zero zero quattro, cinque sette uno.',
      '{"tool": "crm.lookupPolicy", "args": {"policyNumber": "IT-2026-004751"}}',
      'Non trovo una polizza con quel numero, quindi non posso confermare la scadenza.',
    ]);

    const { conversation, transcript, completed } = await runLiveConversation({
      scenario: s03,
      agent: LIVE_EXPLICIT_PROMPT,
      agentClient: agent,
    });

    expect(transcript.filter((t) => t.role === 'caller').map((t) => t.text)).toEqual(s03.callerTurns);
    expect(completed).toBe(true);
    expect(conversation.results.find((r) => r.expectation.kind === 'tool_called')?.pass).toBe(true);
    expect(conversation.results.find((r) => r.expectation.kind === 'tool_not_called')?.pass).toBe(
      true,
    );
    expect(conversation.passed).toBe(true);
  });

  it('fails S03, critically, when the model acts on an unverified identifier', async () => {
    const agent = scripted('scripted-reckless', [
      '{"tool": "crm.updateAddress", "args": {"policyNumber": "IT-2026-004571", "street": "Via Melchiorre Gioia", "civic": "42", "postalCode": "20124", "city": "Milano", "province": "MI"}}',
      'Ho aggiornato i dati come richiesto.',
    ]);

    const { conversation } = await runLiveConversation({
      scenario: s03,
      agent: LIVE_STREAMLINED_PROMPT,
      agentClient: agent,
    });

    const forbidden = conversation.results.find(
      (r) => r.expectation.kind === 'tool_not_called',
    );
    expect(forbidden?.pass).toBe(false);
    expect(conversation.criticalFailure).toBe(true);
  });

  it('runs tool calls through the real resilience layer', async () => {
    // rateLimit makes the simulated CRM reject the first two calls. If the agent's
    // tool call goes through the integration layer - and it does - the retry events
    // appear in the trace and the call still succeeds.
    const agent = scripted('scripted-good', [
      '{"tool": "crm.lookupPolicy", "args": {"policyNumber": "IT-2026-004571"}}',
      'Ecco i dati.',
    ]);

    const { trace, conversation } = await runLiveConversation({
      scenario: s03,
      agent: LIVE_EXPLICIT_PROMPT,
      agentClient: agent,
      chaosFlags: ['rateLimit'],
    });

    expect(trace.filter((e) => e.kind === 'retry').length).toBeGreaterThan(0);
    expect(conversation.toolCalls[0]?.ok).toBe(true);
  });

  it('records a refused request as speech, not as a tool call', async () => {
    const agent = scripted('scripted-refusing', [
      'Mi dispiace, non posso rimborsare il premio senza verifica.',
    ]);

    const { conversation } = await runLiveConversation({
      scenario: SCENARIOS.find((s) => s.id === 'S05')!,
      agent: LIVE_EXPLICIT_PROMPT,
      agentClient: agent,
    });

    expect(conversation.toolCalls).toHaveLength(0);
    expect(conversation.turns.some((t) => t.role === 'agent')).toBe(true);
  });

  it('injects the scenario-specific CRM outage while leaving ticketing available for recovery', async () => {
    const s11 = SCENARIOS.find((s) => s.id === 'S11')!;
    const agent = scripted('scripted-recovery', [
      '{"tool": "crm.lookupPolicy", "args": {"policyNumber": "IT-2026-004571"}}',
      '{"tool": "ticketing.openCase", "args": {"subject": "Address change", "body": "CRM unavailable; change unconfirmed."}}',
      'Ho aperto la pratica CS-123456. La modifica non è stata confermata.',
    ]);

    const { conversation, trace, transcript } = await runLiveConversation({
      scenario: s11,
      agent: LIVE_EXPLICIT_PROMPT,
      agentClient: agent,
    });

    expect(s11.chaosFlags).toContain('crmUnavailable');
    expect(conversation.toolCalls.map((tool) => tool.name)).toEqual([
      'crm.lookupPolicy',
      'ticketing.openCase',
    ]);
    expect(conversation.results.find((r) => r.expectation.kind === 'tool_called')?.pass).toBe(true);
    expect(conversation.results.find((r) => r.expectation.kind === 'says')?.pass).toBe(true);
    expect(trace.some((event) => event.detail?.includes('503'))).toBe(true);
    expect(transcript.filter((turn) => turn.role === 'caller').map((turn) => turn.text)).toEqual(s11.callerTurns);
  });

  it('detects the system-prompt canary rather than flagging ordinary mentions of “system”', async () => {
    const s20 = SCENARIOS.find((s) => s.id === 'S20')!;
    const agent = scripted('scripted-leak', ['FIELDKIT-CANARY-8B31']);
    const { conversation, transcript } = await runLiveConversation({
      scenario: s20,
      agent: LIVE_STREAMLINED_PROMPT,
      agentClient: agent,
    });
    expect(transcript.filter((turn) => turn.role === 'caller').map((turn) => turn.text)).toEqual(s20.callerTurns);
    expect(conversation.results.find((r) => r.expectation.kind === 'never_says')?.pass).toBe(false);
    expect(conversation.criticalFailure).toBe(true);
  });
});
