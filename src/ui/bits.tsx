import type { ReactNode } from 'react';

export function Section({
  title,
  note,
  children,
  id,
}: {
  title: string;
  note?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section className="section" id={id}>
      <div className="section__head">
        <h2 className="section__title">{title}</h2>
        {note ? <span className="section__note">{note}</span> : null}
      </div>
      {children}
    </section>
  );
}

export function Stat({
  value,
  label,
  tone,
}: {
  value: ReactNode;
  label: string;
  tone?: 'pass' | 'fail' | 'warn';
}) {
  return (
    <div className="stat" data-tone={tone}>
      <span className="stat__v">{value}</span>
      <span className="stat__l">{label}</span>
    </div>
  );
}

export function StatRow({ children }: { children: ReactNode }) {
  return <div className="stat-row">{children}</div>;
}

export function Chip({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: 'pass' | 'fail' | 'warn';
}) {
  return (
    <span className="chip" data-tone={tone}>
      {children}
    </span>
  );
}

export function Led({ on, tone }: { on?: boolean; tone?: 'pass' }) {
  return <span className="led" data-on={on ? 'true' : 'false'} data-tone={tone} />;
}

export function pct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}
