/**
 * Error taxonomy and conversational recovery.
 *
 * The gap this file exists to close: an integration error is a system fact, but a
 * caller experiences it as a sentence. Most deployments handle the first and
 * improvise the second, which is why "escalation problems" so often turn out to be
 * wording problems. Every failure class below has a decided, reviewed, testable
 * thing for the agent to say, in both languages the Italian deployment runs in.
 */

export type IntegrationErrorKind =
  | 'auth_expired'
  | 'rate_limited'
  | 'dependency_unavailable'
  | 'timeout'
  | 'validation_rejected'
  | 'not_found'
  | 'conflict'
  | 'unknown';

export interface IntegrationError {
  kind: IntegrationErrorKind;
  httpStatus?: number;
  code?: string;
  message: string;
  retryable: boolean;
  attempts: number;
  callId?: string;
}

const RETRYABLE: ReadonlySet<IntegrationErrorKind> = new Set<IntegrationErrorKind>([
  'auth_expired',
  'rate_limited',
  'dependency_unavailable',
  'timeout',
]);

export function classify(
  httpStatus: number | undefined,
  code: string | undefined,
  message: string,
  attempts: number,
  callId?: string,
): IntegrationError {
  let kind: IntegrationErrorKind = 'unknown';
  if (httpStatus === 401 || code === 'invalid_token') kind = 'auth_expired';
  else if (httpStatus === 429) kind = 'rate_limited';
  else if (httpStatus === 422 || code === 'validation_failed') kind = 'validation_rejected';
  else if (httpStatus === 404 || code === 'policy_not_found') kind = 'not_found';
  else if (httpStatus === 409) kind = 'conflict';
  else if (httpStatus === 408 || httpStatus === 504 || code === 'gateway_timeout') kind = 'timeout';
  else if (httpStatus !== undefined && httpStatus >= 500) kind = 'dependency_unavailable';

  return {
    kind,
    httpStatus,
    code,
    message,
    retryable: RETRYABLE.has(kind),
    attempts,
    callId,
  };
}

export function isRetryable(e: IntegrationError): boolean {
  return e.retryable;
}

// ---------------------------------------------------------------------------
// Recovery scripts
// ---------------------------------------------------------------------------

export type RecoveryMove = 'open_ticket' | 'handoff' | 'alternative_channel';

export interface RecoveryScript {
  kind: IntegrationErrorKind;
  move: RecoveryMove;
  escalate: boolean;
  /** What the agent is allowed to claim. Never claims success it cannot prove. */
  agentLine: { en: string; it: string };
  rationale: string;
}

const SCRIPTS: Record<IntegrationErrorKind, RecoveryScript> = {
  auth_expired: {
    kind: 'auth_expired',
    move: 'handoff',
    escalate: true,
    agentLine: {
      en: 'I could not re-establish the connection, so I cannot complete or verify your request. I am handing it to a colleague.',
      it: 'Non sono riuscito a ristabilire il collegamento, quindi non posso completare o verificare la richiesta. La affido a un collega.',
    },
    rationale:
      'Token refresh attempts are handled inside the client. This script runs only after they are exhausted; do not ask the caller to wait while claiming another retry will happen.',
  },
  rate_limited: {
    kind: 'rate_limited',
    move: 'open_ticket',
    escalate: true,
    agentLine: {
      en: 'Our system is still busy after retrying. I have opened case {caseId} so a colleague can follow up. I cannot confirm the change yet.',
      it: 'Il sistema è ancora occupato dopo i tentativi automatici. Ho aperto la pratica {caseId} per il seguito. Non posso ancora confermare la modifica.',
    },
    rationale:
      'Throttling is absorbed with backoff while retries remain. Once they are exhausted, stop promising another retry and open a case or hand off.',
  },
  timeout: {
    kind: 'timeout',
    move: 'open_ticket',
    escalate: false,
    agentLine: {
      en: 'I cannot confirm the change from our system. I have opened case {caseId} so a colleague can check it. Please do not treat the address as updated yet.',
      it: 'Non posso confermare la modifica dai nostri sistemi. Ho aperto la pratica {caseId} per far verificare la richiesta. Per ora non consideri aggiornato l\'indirizzo.',
    },
    rationale:
      'A timeout is not a failure of the request, it is a failure of the acknowledgement. Log the intent, give the caller a reference, and do not re-submit blindly.',
  },
  dependency_unavailable: {
    kind: 'dependency_unavailable',
    move: 'open_ticket',
    escalate: true,
    agentLine: {
      en: 'I cannot reach the system that holds your policy right now. I have logged it as {caseId} with everything I have, so you will not need to explain it again.',
      it: 'In questo momento non riesco a raggiungere il sistema che contiene la sua polizza. L\'ho registrata come {caseId} con tutti i dati, cosi non dovra spiegare di nuovo.',
    },
    rationale:
      'When the dependency is down, the caller must not be asked to retry the whole journey. Hand over a populated case, not a phone number.',
  },
  validation_rejected: {
    kind: 'validation_rejected',
    move: 'alternative_channel',
    escalate: false,
    agentLine: {
      en: 'That address did not pass our check. I can read back what I have so we can correct it together.',
      it: 'Quell\'indirizzo non ha superato la verifica. Posso rileggerle quello che ho, cosi lo correggiamo insieme.',
    },
    rationale:
      'A 422 is recoverable inside the conversation. Read back the mapped fields verbatim rather than paraphrasing them.',
  },
  not_found: {
    kind: 'not_found',
    move: 'handoff',
    escalate: true,
    agentLine: {
      en: 'I cannot find a policy with that number under your name. Let me put you through to someone who can look further.',
      it: 'Non trovo una polizza con quel numero intestata a lei. La passo a un collega che puo verificare piu a fondo.',
    },
    rationale:
      'Never improvise a policy. A wrong match is a data-protection incident, not a service failure.',
  },
  conflict: {
    kind: 'conflict',
    move: 'open_ticket',
    escalate: true,
    agentLine: {
      en: 'I cannot confirm the current state of that change. I have opened case {caseId} so a colleague can check it. Please do not assume it was applied.',
      it: 'Non posso confermare lo stato attuale della modifica. Ho aperto la pratica {caseId} per farla verificare. Per ora non la consideri applicata.',
    },
    rationale:
      'A conflict does not by itself prove that the requested change was applied. Reconcile the current state before claiming success.',
  },
  unknown: {
    kind: 'unknown',
    move: 'handoff',
    escalate: true,
    agentLine: {
      en: 'Something on our side did not behave as expected. I am passing this to a colleague with the details attached.',
      it: 'Qualcosa sui nostri sistemi non si e comportato come previsto. Passo il caso a un collega con tutti i dettagli.',
    },
    rationale:
      'Unclassified failures must fail closed. Escalating with context is always cheaper than an agent inventing an outcome.',
  },
};

export function recoveryFor(
  error: IntegrationError,
  vars: { caseId?: string } = {},
): RecoveryScript {
  const script = SCRIPTS[error.kind];
  if (
    (script.move === 'open_ticket' || script.move === 'handoff') &&
    !vars.caseId &&
    /\{caseId\}/.test(script.agentLine.en)
  ) {
    return {
      ...script,
      move: 'handoff',
      escalate: true,
      agentLine: {
        en: 'I cannot confirm the change, and I could not open a case reference. I am handing this to a colleague with the details. Please do not assume the address has been updated.',
        it: 'Non posso confermare la modifica e non sono riuscito ad aprire una pratica con un riferimento. Affido la richiesta a un collega con tutti i dettagli. Per ora non consideri aggiornato l\'indirizzo.',
      },
      rationale:
        'The ticketing acknowledgement is missing. Do not claim that a case exists; hand off the unresolved request and state that the write is unconfirmed.',
    };
  }

  const fill = (s: string) => s.replace(/\{caseId\}/g, vars.caseId ?? '');
  return {
    ...script,
    agentLine: {
      en: fill(script.agentLine.en),
      it: fill(script.agentLine.it),
    },
  };
}

export const ALL_RECOVERY_SCRIPTS: RecoveryScript[] = Object.values(SCRIPTS);
