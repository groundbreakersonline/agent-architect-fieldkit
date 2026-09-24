import type { CdrEntry } from '../demo/deployment';

/**
 * The call detail record strip.
 *
 * This is the one element the kit is meant to be remembered by. Every event of the
 * conversation, in order, on one perforated line: authentication, each enterprise
 * call, each retry, the breaker, the guardrail, the recovery. It encodes the whole
 * thesis in a glance - a conversation with an enterprise system is an auditable,
 * timed, ordered sequence of events, not a chat transcript.
 */
export function CdrStrip({
  entries,
  revealed,
  running,
  clockMs,
}: {
  entries: CdrEntry[];
  revealed: number;
  running: boolean;
  clockMs: number;
}) {
  const visible = entries.slice(0, revealed);

  return (
    <div className="cdr">
      <div className="cdr__head">
        <span className="cdr__label">Call detail record / conversation trace</span>
        <span className="cdr__readout">
          <span>
            events <b>{String(visible.length).padStart(2, '0')}</b> /{' '}
            {String(entries.length).padStart(2, '0')}
          </span>
          <span>
            clock <b>{(clockMs / 1000).toFixed(2)}s</b>
          </span>
          <span>
            errors <b>{visible.filter((e) => e.status === 'error').length}</b>
          </span>
          <span>
            retries <b>{visible.filter((e) => e.kind === 'retry').length}</b>
          </span>
        </span>
      </div>
      <div className="cdr__strip" role="list" aria-live="polite">
        {entries.length === 0 ? (
          <p className="cdr__empty">
            No record yet. Run a conversation from the deployment panel.
          </p>
        ) : null}
        {visible.map((e) => (
          <div
            key={`${e.index}-${e.label}`}
            className="cdr__entry"
            data-status={e.status}
            role="listitem"
          >
            <span className="cdr__t">{(e.at / 1000).toFixed(2)}s</span>
            <span className="cdr__name">{e.label}</span>
            <span className="cdr__ms">
              {e.latencyMs !== undefined ? `${e.latencyMs}ms` : e.kind}
              {e.attempt !== undefined && e.attempt > 1 ? ` / try ${e.attempt}` : ''}
            </span>
          </div>
        ))}
        {running && revealed < entries.length ? (
          <div className="cdr__entry" data-status="info" aria-hidden="true">
            <span className="cdr__t">···</span>
            <span className="cdr__name">recording</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
