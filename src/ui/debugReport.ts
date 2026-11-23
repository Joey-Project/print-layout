/**
 * Bug reports: a JSON snapshot of everything needed to reproduce what the user sees (inputs, viewer
 * and camera state, derived timeline/poses, recent interactions), saved next to a PNG of the canvas.
 * "Load report…" (or `window.printLayoutDebug.load(report)`) puts the app back in that state.
 */
import type { Padding, Recipe } from '../engine';
import type { ImposedOptions } from '../pdf/imposed';
import type { PrintSettings } from './PrintView';

export const REPORT_KIND = 'print-layout/debug-report';

/** Viewer state that a report restores. */
export interface ViewerState {
  time: number;
  mode: 'paused' | 'forward' | 'backward';
  speed: number;
  explode: number;
  autoFrame: boolean;
  shape: number;
  camera: {
    position: [number, number, number];
    target: [number, number, number];
    up: [number, number, number];
    fov: number;
  };
}

export interface ViewerSnapshot {
  state: ViewerState;
  /** Computed, for reading only (not restored): stage caption, timeline summary, poses… */
  derived: Record<string, unknown>;
  /** PNG data URL of the canvas, or null if it could not be captured. */
  screenshot: string | null;
}

export interface ViewerDebug {
  snapshot(): ViewerSnapshot;
}

export interface DebugReport {
  kind: typeof REPORT_KIND;
  version: 1;
  createdAt: string;
  note: string;
  app: { commit: string; mode: string };
  env: {
    userAgent: string;
    language: string;
    devicePixelRatio: number;
    window: [number, number];
  };
  input: {
    selectedId: string;
    /** The recipe editor's text, exactly (it may be an unsaved or invalid edit). */
    recipeText: string;
    /** The recipe actually in use (the last valid one). */
    recipe: Recipe;
    pageCount: number;
    padding: Padding | 'recipe';
    view: '2d' | '3d' | 'print';
    /** Print-export settings (absent in older reports). */
    print?: PrintSettings;
    /** How an imposed PDF is read (absent in older reports). */
    imposed?: ImposedOptions;
    /** A reading-order PDF's pages in another order (absent in older reports and when unmoved). */
    pageOrder?: number[];
  };
  viewer: ViewerState | null;
  derived: Record<string, unknown>;
  /** Recent interactions, oldest first. */
  events: DebugEvent[];
}

export interface DebugEvent {
  /** Milliseconds since the page loaded. */
  at: number;
  type: string;
  [key: string]: unknown;
}

const MAX_EVENTS = 400;
const events: DebugEvent[] = [];

/** Record an interaction for the next bug report (kept in a small ring buffer). */
export function logEvent(type: string, data: Record<string, unknown> = {}) {
  events.push({ at: Math.round(performance.now()), type, ...data });
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

export const recentEvents = () => events.slice();

/** Round numbers so reports stay readable (and diffable) without losing anything that matters. */
export function rounded<T>(value: T, digits = 6): T {
  const f = 10 ** digits;
  return JSON.parse(
    JSON.stringify(value, (_k, v: unknown) =>
      typeof v === 'number' && Number.isFinite(v) ? Math.round(v * f) / f : v,
    ),
  ) as T;
}

export function isDebugReport(x: unknown): x is DebugReport {
  return (
    typeof x === 'object' &&
    x !== null &&
    (x as { kind?: unknown }).kind === REPORT_KIND &&
    typeof (x as { input?: unknown }).input === 'object'
  );
}

function download(name: string, href: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Save the report as `<base>.json`, plus `<base>.png` when there is a screenshot. */
export function saveReport(report: DebugReport, screenshot: string | null) {
  const stamp = report.createdAt.replace(/[:.]/g, '-');
  const base = `print-layout-report-${stamp}`;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
  );
  download(`${base}.json`, url);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  if (screenshot) download(`${base}.png`, screenshot);
}
