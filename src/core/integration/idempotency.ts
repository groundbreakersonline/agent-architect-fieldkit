/**
 * Idempotency.
 *
 * The design decision worth arguing about: keys are derived from the *intent*
 * (operation + subject + the turn that expressed it), not from a random UUID
 * generated at request time. A random key protects you against a retry inside one
 * process. An intent-derived key protects you against the retry that happens after
 * a pod restart, a queue redelivery, or a well-meaning engineer replaying the turn
 * from a support console - which is where duplicate refunds actually come from.
 */

export interface IdempotentResult<T> {
  value: T;
  replayed: boolean;
}

export interface LedgerEntry {
  key: string;
  intent: string;
  subject: string;
  firstSeenAt: number;
  accepted: boolean;
}

export class IdempotencyLedger {
  private readonly seen = new Map<string, LedgerEntry>();

  derive(intent: string, subject: string, turnId: string): string {
    // Stable, human-readable, and collision-resistant enough for this domain.
    return `${intent}:${subject}:${turnId}`;
  }

  /** Returns false when this intent has already been accepted for this subject. */
  claim(key: string, intent: string, subject: string, at: number): boolean {
    if (this.seen.has(key)) return false;
    this.seen.set(key, { key, intent, subject, firstSeenAt: at, accepted: true });
    return true;
  }

  has(key: string): boolean {
    return this.seen.has(key);
  }

  entries(): LedgerEntry[] {
    return [...this.seen.values()];
  }

  /** How many duplicate writes were absorbed. A number worth putting on a dashboard. */
  get suppressedCount(): number {
    return [...this.seen.values()].filter((e) => e.firstSeenAt > 0).length > 0
      ? this.duplicateAttempts
      : 0;
  }

  duplicateAttempts = 0;

  noteDuplicate(): void {
    this.duplicateAttempts += 1;
  }

  clear(): void {
    this.seen.clear();
    this.duplicateAttempts = 0;
  }
}
