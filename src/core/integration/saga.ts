/**
 * Deterministic API chains.
 *
 * Agent platforms describe this as "structured API chains and event-based logic so
 * critical steps happen in the right order". In practice that means a saga: ordered
 * steps, explicit preconditions, and a compensation for every step that has already
 * changed something when a later step fails.
 *
 * The failure this prevents: the agent tells the caller the address was changed,
 * the confirmation email step fails, and nobody notices the two systems now
 * disagree about where the customer lives.
 */
import type { Clock, TraceSink } from './types';
import { noopTrace } from './types';

export interface SagaStep<C> {
  id: string;
  name: string;
  /** A failing critical step aborts the chain and triggers compensation. */
  critical?: boolean;
  /** Event-based precondition. When false the step is skipped, not failed. */
  when?: (ctx: C) => boolean;
  run: (ctx: C) => Promise<void>;
  /** Undo for steps that already changed state. */
  compensate?: (ctx: C) => Promise<void>;
}

export type StepStatus = 'ok' | 'skipped' | 'failed' | 'compensated' | 'compensation_failed';

export interface StepOutcome {
  id: string;
  name: string;
  status: StepStatus;
  latencyMs: number;
  error?: string;
}

export interface SagaResult {
  status: 'completed' | 'compensated' | 'aborted';
  steps: StepOutcome[];
  failedStepId?: string;
}

export interface SagaHooks<C> {
  clock: Clock;
  trace?: TraceSink;
  /** Called after each step resolves, so the console can animate the chain. */
  onStep?: (outcome: StepOutcome, ctx: C) => void;
}

export class Saga<C> {
  constructor(
    public readonly name: string,
    private readonly steps: SagaStep<C>[],
  ) {}

  listSteps(): Array<{ id: string; name: string; critical: boolean }> {
    return this.steps.map((s) => ({ id: s.id, name: s.name, critical: s.critical === true }));
  }

  async run(ctx: C, hooks: SagaHooks<C>): Promise<SagaResult> {
    const trace = hooks.trace ?? noopTrace;
    const outcomes: StepOutcome[] = [];
    const completed: SagaStep<C>[] = [];

    const emit = (o: StepOutcome) => {
      outcomes.push(o);
      hooks.onStep?.(o, ctx);
    };

    for (const step of this.steps) {
      if (step.when && !step.when(ctx)) {
        emit({ id: step.id, name: step.name, status: 'skipped', latencyMs: 0 });
        trace({
          at: hooks.clock.now(),
          kind: 'saga',
          status: 'info',
          label: `${this.name}: ${step.name} skipped`,
          detail: 'Precondition not met.',
        });
        continue;
      }

      const startedAt = hooks.clock.now();
      try {
        await step.run(ctx);
        const outcome: StepOutcome = {
          id: step.id,
          name: step.name,
          status: 'ok',
          latencyMs: hooks.clock.now() - startedAt,
        };
        completed.push(step);
        emit(outcome);
        trace({
          at: hooks.clock.now(),
          kind: 'saga',
          status: 'ok',
          label: `${this.name}: ${step.name}`,
          latencyMs: outcome.latencyMs,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit({
          id: step.id,
          name: step.name,
          status: 'failed',
          latencyMs: hooks.clock.now() - startedAt,
          error: message,
        });
        trace({
          at: hooks.clock.now(),
          kind: 'saga',
          status: 'error',
          label: `${this.name}: ${step.name} failed`,
          detail: message,
        });

        if (!step.critical) continue;

        // Unwind in reverse. A compensation failure is escalated, never swallowed.
        for (const done of [...completed].reverse()) {
          if (!done.compensate) continue;
          try {
            await done.compensate(ctx);
            emit({
              id: `${done.id}:compensate`,
              name: `Undo ${done.name}`,
              status: 'compensated',
              latencyMs: hooks.clock.now() - startedAt,
            });
          } catch (undoErr) {
            emit({
              id: `${done.id}:compensate`,
              name: `Undo ${done.name}`,
              status: 'compensation_failed',
              latencyMs: hooks.clock.now() - startedAt,
              error: undoErr instanceof Error ? undoErr.message : String(undoErr),
            });
            trace({
              at: hooks.clock.now(),
              kind: 'saga',
              status: 'error',
              label: `${this.name}: compensation failed for ${done.name}`,
              detail: 'This requires a human. The console raises a case automatically.',
            });
          }
        }

        return {
          status: completed.length > 0 ? 'compensated' : 'aborted',
          steps: outcomes,
          failedStepId: step.id,
        };
      }
    }

    return { status: 'completed', steps: outcomes };
  }
}
