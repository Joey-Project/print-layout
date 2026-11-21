import type { Grid, Plan, Slot } from '../engine';

interface SideProps {
  title: string;
  hint: string;
  grid: Grid;
  slots: Slot[];
  hovered: number | null;
  onHover: (position: number | null) => void;
}

function SideView({ title, hint, grid, slots, hovered, onHover }: SideProps) {
  const cells = new Map(slots.map((s) => [`${s.col},${s.row}`, s]));
  return (
    <figure className="side">
      <figcaption>
        <strong>{title}</strong> <span className="muted">{hint}</span>
      </figcaption>
      <div
        className="sheet-grid"
        style={{ gridTemplateColumns: `repeat(${grid.cols}, var(--panel-w))` }}
      >
        {Array.from({ length: grid.rows }, (_, row) =>
          Array.from({ length: grid.cols }, (_, col) => {
            const s = cells.get(`${col},${row}`);
            if (!s) return <div key={`${col},${row}`} className="panel empty" />;
            const blank = s.page === null;
            return (
              <div
                key={`${col},${row}`}
                className={`panel${blank ? ' blank' : ''}${hovered === s.position ? ' hot' : ''}`}
                onMouseEnter={() => onHover(s.position)}
                onMouseLeave={() => onHover(null)}
                title={
                  blank
                    ? `Blank (reading position ${s.position})`
                    : `Page ${s.page} · reading position ${s.position}` +
                      (s.rotation ? ' · printed upside down' : '')
                }
              >
                <span className="page-no" style={{ rotate: `${blank ? 0 : s.rotation}deg` }}>
                  {blank ? 'blank' : s.page}
                </span>
                <span className="pos">#{s.position}</span>
              </div>
            );
          }),
        )}
      </div>
    </figure>
  );
}

export function PlanView({
  plan,
  hovered,
  onHover,
}: {
  plan: Plan;
  hovered: number | null;
  onHover: (p: number | null) => void;
}) {
  return (
    <div className="sheets">
      {plan.sheets.map((sheet, i) => (
        <section key={i} className="sheet-card">
          <h3>Sheet {i + 1}</h3>
          <div className="sides">
            <SideView
              title="Front"
              hint=""
              grid={plan.grid}
              slots={sheet.front}
              hovered={hovered}
              onHover={onHover}
            />
            {sheet.back.length > 0 ? (
              <SideView
                title="Back"
                hint="(turned over sideways, like a book page)"
                grid={plan.grid}
                slots={sheet.back}
                hovered={hovered}
                onHover={onHover}
              />
            ) : (
              <p className="muted single">Single-sided — back stays blank.</p>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
