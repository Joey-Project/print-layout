import { gangPlan, paperPlan } from '../src/engine';

describe('ganging sheets onto printed sheets', () => {
  it('cut and stack: piles stacked in position order give the sheets in order', () => {
    for (const [sheets, across, down] of [
      [6, 2, 1],
      [7, 2, 2],
      [3, 2, 1],
      [10, 3, 2],
    ] as const) {
      const g = gangPlan(sheets, { across, down, order: 'stack' });
      expect(g.papers).toBe(Math.ceil(sheets / (across * down)));
      // Print the stack (paper 0 on top), cut it into piles by unit position, then stack the
      // piles with position 0's on top: read the sheets top to bottom.
      const stacked: number[] = [];
      for (let row = 0; row < down; row++) {
        for (let col = 0; col < across; col++) {
          for (let p = 0; p < g.papers; p++) {
            const s = g.sheetAt(p, col, row);
            if (s !== null) stacked.push(s);
          }
        }
      }
      expect(stacked).toEqual(Array.from({ length: sheets }, (_, i) => i));
      for (let s = 0; s < sheets; s++) {
        const at = g.placeOf(s);
        expect(g.sheetAt(at.paper, at.col, at.row)).toBe(s);
      }
    }
  });

  it('copies: every unit of a printed sheet is the same sheet', () => {
    const g = gangPlan(3, { across: 2, down: 2, order: 'copies' });
    expect(g.papers).toBe(3);
    expect([0, 1].flatMap((c) => [0, 1].map((r) => g.sheetAt(2, c, r)))).toEqual([2, 2, 2, 2]);
  });
});

describe('dividing the printed sheet into sections', () => {
  const spread = { cols: 2, rows: 1 };

  it('three sections across: one spread and one blank section per side', () => {
    const p = paperPlan(
      4,
      spread,
      { across: 1, down: 1, order: 'stack' },
      {
        across: 3,
        down: 1,
        blank: 'end',
      },
    );
    expect(p.sectioned).toBe(true);
    expect(p.gang.units).toBe(1);
    expect(p.gang.papers).toBe(4);
    expect(p.paper.unitCell(0, 0)).toEqual({ col: 0, row: 0 });
    expect(p.paper.blanks).toEqual([{ col: 2, row: 0, w: 1, h: 1 }]);
    const start = paperPlan(
      4,
      spread,
      { across: 1, down: 1, order: 'stack' },
      {
        across: 3,
        down: 1,
        blank: 'start',
      },
    );
    expect(start.paper.unitCell(0, 0)).toEqual({ col: 1, row: 0 });
    expect(start.paper.blanks).toEqual([{ col: 0, row: 0, w: 1, h: 1 }]);
  });

  it('fits as many whole spreads as the sections allow', () => {
    const p = paperPlan(
      6,
      spread,
      { across: 1, down: 1, order: 'stack' },
      {
        across: 5,
        down: 2,
        blank: 'end',
      },
    );
    expect([p.gang.gang.across, p.gang.gang.down]).toEqual([2, 2]);
    expect(p.paper.unitCell(1, 1)).toEqual({ col: 2, row: 1 });
    expect(p.paper.blanks).toEqual([{ col: 4, row: 0, w: 1, h: 2 }]);
  });
});
