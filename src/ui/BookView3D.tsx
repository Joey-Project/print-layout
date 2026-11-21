import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Plan, Recipe } from '../engine';
import { faceTexture } from '../viewer/faceTexture';
import { buildTimeline, type PageTurn, type Timeline } from '../viewer/timeline';

const PAGE_SHAPES = [
  { label: 'A-series portrait', aspect: Math.SQRT2 },
  { label: 'US Letter portrait', aspect: 11 / 8.5 },
  { label: 'Square', aspect: 1 },
  { label: 'A-series landscape', aspect: 1 / Math.SQRT2 },
];

/** Default camera direction: slightly from below-right and in front, so folds read as 3D. */
const VIEW_DIR = new THREE.Vector3(0.35, -0.75, 1).normalize();

type PlayMode = 'paused' | 'forward' | 'backward';

interface Live {
  time: number;
  mode: PlayMode;
  speed: number;
  explode: number;
  autoFrame: boolean;
  snap: boolean;
  target: number | null;
}

interface SceneState {
  tl: Timeline;
  groups: THREE.Group[];
  mats: THREE.Matrix4[];
}

function disposeTree(root: THREE.Object3D) {
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      const mat = o.material as THREE.MeshLambertMaterial;
      mat.map?.dispose();
      mat.dispose();
    }
  });
  root.clear();
}

export function BookView3D({ recipe, plan }: { recipe: Recipe; plan: Plan }) {
  const [shape, setShape] = useState(0);
  const aspect = PAGE_SHAPES[shape]!.aspect;
  const built = useMemo((): { tl: Timeline } | { error: string } => {
    try {
      return { tl: buildTimeline(recipe, plan, aspect) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [recipe, plan, aspect]);
  const tl = 'tl' in built ? built.tl : null;

  const [time, setTime] = useState(0);
  const [mode, setModeState] = useState<PlayMode>('paused');
  const [speed, setSpeed] = useState(1);
  const [explode, setExplode] = useState(1);
  const [autoFrame, setAutoFrame] = useState(true);

  const live = useRef<Live>({
    time: 0,
    mode: 'paused',
    speed: 1,
    explode: 1,
    autoFrame: true,
    snap: true,
    target: null,
  });
  const scene = useRef<SceneState | null>(null);
  const root = useRef<THREE.Group | null>(null);
  const mount = useRef<HTMLDivElement>(null);
  const resetView = useRef<() => void>(() => {});

  const setMode = (m: PlayMode) => {
    live.current.mode = m;
    if (m !== 'paused') live.current.target = null;
    setModeState(m);
  };
  useEffect(() => {
    live.current.speed = speed;
  }, [speed]);
  useEffect(() => {
    live.current.explode = explode;
  }, [explode]);
  useEffect(() => {
    live.current.autoFrame = autoFrame;
  }, [autoFrame]);

  // ---- One-time three.js setup and render loop. ----
  useEffect(() => {
    const el = mount.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(renderer.domElement);

    const world = new THREE.Scene();
    world.add(new THREE.AmbientLight(0xffffff, 1.7));
    const key = new THREE.DirectionalLight(0xffffff, 1.3);
    key.position.set(3, 4, 10);
    const rim = new THREE.DirectionalLight(0xffffff, 0.9);
    rim.position.set(-3, -4, -10);
    world.add(key, rim);
    const group = new THREE.Group();
    world.add(group);
    root.current = group;

    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 500);
    camera.position.copy(VIEW_DIR).multiplyScalar(10);

    // ---- Drag a page to turn it (reading stage). Registered before OrbitControls so a grab on
    // the book wins; a drag anywhere else still orbits. ----
    const canvas = renderer.domElement;
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const bookPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const onPlane = new THREE.Vector3();
    let drag: { rank: number } | null = null;
    const aim = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
    };
    const turnable = () => {
      const pt = scene.current?.tl.pageTurn;
      return pt && live.current.time >= pt.start - 1e-6 ? pt : null;
    };
    /** The leaf rank of the front-most panel under the pointer, if any. */
    const leafUnderPointer = (pt: PageTurn) => {
      const hit = raycaster.intersectObject(group, true)[0];
      if (!hit) return null;
      const panel = hit.object.parent?.userData.panel as number | undefined;
      return (panel === undefined ? undefined : pt.rankOf(panel)) ?? null;
    };
    const overBook = () => raycaster.intersectObject(group, true).length > 0;
    const onDown = (e: PointerEvent) => {
      const pt = turnable();
      if (e.button !== 0 || !pt) return;
      aim(e);
      // Grab the leaf actually under the pointer — not whichever leaf is still settling from the
      // last release, which is what made a quick second flip snap back to the previous page.
      const rank = leafUnderPointer(pt);
      if (rank === null || !raycaster.ray.intersectPlane(bookPlane, onPlane)) return;
      if (rank < 0 || rank >= pt.leafCount) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      drag = { rank };
      setMode('paused');
      live.current.target = null;
      const t = pt.grab(live.current.time, rank);
      live.current.time = t;
      setTime(t);
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
    };
    const onMove = (e: PointerEvent) => {
      const pt = turnable();
      aim(e);
      if (drag && pt) {
        if (!raycaster.ray.intersectPlane(bookPlane, onPlane)) return;
        const t = pt.timeFor(drag.rank, pt.progressAt(onPlane.x, onPlane.y));
        live.current.time = t;
        setTime(t);
      } else if (e.buttons === 0) {
        canvas.style.cursor = pt && overBook() ? 'grab' : '';
      }
    };
    const onUp = (e: PointerEvent) => {
      const pt = turnable();
      if (!drag || !pt) return;
      // Let go: the leaf falls to whichever side it is closer to.
      const frac = live.current.time - pt.start - drag.rank;
      live.current.target = pt.start + drag.rank + (frac > 0.5 ? 1 : 0);
      drag = null;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      canvas.style.cursor = 'grab';
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.addEventListener('start', () => {
      live.current.autoFrame = false;
      setAutoFrame(false);
    });
    resetView.current = () => {
      camera.position.copy(controls.target).add(VIEW_DIR);
      live.current.snap = true;
      live.current.autoFrame = true;
      setAutoFrame(true);
    };

    const resize = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    const box = new THREE.Box3();
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    const dir = new THREE.Vector3();
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const L = live.current;
      const s = scene.current;
      if (s) {
        let t = L.time;
        const step = dt * L.speed * 0.9;
        if (L.target !== null) {
          const d = L.target - t;
          t = Math.abs(d) <= step ? L.target : t + Math.sign(d) * step;
          if (t === L.target) L.target = null;
        } else if (L.mode === 'forward') {
          t = Math.min(s.tl.duration, t + step);
          if (t >= s.tl.duration) setMode('paused');
        } else if (L.mode === 'backward') {
          t = Math.max(0, t - step);
          if (t <= 0) setMode('paused');
        }
        if (t !== L.time) {
          L.time = t;
          setTime(t);
        }
        s.tl.poseAt(t, L.explode, s.mats);
        s.groups.forEach((g, i) => g.matrix.copy(s.mats[i]!));
        group.updateMatrixWorld(true);

        if ((L.autoFrame || L.snap) && !drag) {
          box.setFromObject(group);
          if (!box.isEmpty()) {
            box.getCenter(center);
            box.getSize(size);
            // Fit width and height separately so a long row of sheets fills the view.
            const tanV = Math.tan((camera.fov * Math.PI) / 360);
            const fit =
              Math.max(size.x / 2 / (tanV * camera.aspect), size.y / 2 / tanV) * 1.3 + size.z;
            const k = L.snap ? 1 : 0.08;
            dir.copy(camera.position).sub(controls.target).normalize();
            const dist = camera.position.distanceTo(controls.target);
            controls.target.lerp(center, k);
            camera.position.copy(controls.target).addScaledVector(dir, dist + (fit - dist) * k);
            L.snap = false;
          }
        }
      }
      controls.update();
      renderer.render(world, camera);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      disposeTree(group);
      renderer.dispose();
      renderer.domElement.remove();
      root.current = null;
    };
  }, []);

  // ---- Rebuild panel meshes whenever the timeline changes. ----
  useEffect(() => {
    const group = root.current;
    if (!group) return;
    disposeTree(group);
    scene.current = null;
    if (!tl) return;
    const { cols } = recipe.grid;
    const groups = tl.panels.map((p, i) => {
      const g = new THREE.Group();
      g.matrixAutoUpdate = false;
      const cx = p.col + 0.5;
      const cy = -(p.row + 0.5) * aspect;
      const sheet = plan.sheets[p.sheet]!;
      const frontSlot = sheet.front.find((s) => s.col === p.col && s.row === p.row);
      const backSlot = sheet.back.find((s) => s.col === cols - 1 - p.col && s.row === p.row);
      const front = new THREE.Mesh(
        new THREE.PlaneGeometry(1, aspect).translate(cx, cy, 0.0015),
        new THREE.MeshLambertMaterial({ map: faceTexture(frontSlot, p.sheet, 'front', aspect) }),
      );
      const back = new THREE.Mesh(
        new THREE.PlaneGeometry(1, aspect).rotateY(Math.PI).translate(cx, cy, -0.0015),
        new THREE.MeshLambertMaterial({ map: faceTexture(backSlot, p.sheet, 'back', aspect) }),
      );
      g.add(front, back);
      g.userData.panel = i;
      group.add(g);
      return g;
    });
    scene.current = { tl, groups, mats: tl.panels.map(() => new THREE.Matrix4()) };
    const t = Math.min(live.current.time, tl.duration);
    live.current.time = t;
    live.current.target = null;
    live.current.snap = true;
    setTime(t);
  }, [tl, plan, recipe, aspect]);

  // ---- Transport helpers. ----
  const duration = tl?.duration ?? 0;
  const goTo = (t: number) => {
    setMode('paused');
    live.current.target = Math.min(Math.max(0, t), duration);
  };
  const jump = (t: number) => {
    setMode('paused');
    live.current.target = null;
    live.current.time = t;
    setTime(t);
  };
  const stops = tl?.stops ?? [0];
  const prevStop = () => goTo(stops.filter((s) => s < time - 1e-6).at(-1) ?? 0);
  const nextStop = () => goTo(stops.find((s) => s > time + 1e-6) ?? duration);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === ' ') {
      e.preventDefault();
      setMode(mode === 'paused' ? (time >= duration ? 'backward' : 'forward') : 'paused');
    } else if (e.key === 'ArrowRight') nextStop();
    else if (e.key === 'ArrowLeft') prevStop();
  };

  const stage = useMemo(() => {
    if (!tl) return '';
    if (tl.segments.length === 0)
      return 'This recipe has no fold program yet — showing the flat sheet.';
    if (time <= 1e-6) return 'Printed sheets, laid flat (fronts up)';
    // Once the piece is finished, the closed book belongs to the reading stage.
    const seg =
      (tl.pageTurn && time >= tl.pageTurn.start - 1e-6
        ? tl.segments.find((s) => s.kind === 'read')
        : tl.segments.find((s) => time > s.start && time <= s.end)) ?? tl.segments.at(-1)!;
    if (seg.kind !== 'read') return seg.label;
    const k = Math.round(time - seg.start);
    const pageAt = new Map(
      plan.sheets.flatMap((s) => [...s.front, ...s.back]).map((s) => [s.position, s.page]),
    );
    const name = (pos: number) => {
      const p = pageAt.get(pos);
      return p === undefined ? null : p === null ? 'blank' : String(p);
    };
    const shown = [name(2 * k), name(2 * k + 1)].filter((x) => x !== null);
    return `${seg.label} — ${k === 0 ? 'front cover' : k === tl.leafCount ? 'back cover' : 'spread'}: ${shown.join(' | ')}`;
  }, [tl, time, plan]);

  return (
    <div className="viewer" tabIndex={0} onKeyDown={onKey}>
      <div className="viewer-canvas" ref={mount}>
        {'error' in built && <p className="error overlay">{built.error}</p>}
        <p className="viewer-hint">
          {tl?.pageTurn && time >= tl.pageTurn.start - 1e-6
            ? 'Drag a page to turn it · drag elsewhere to orbit · scroll to zoom · right-drag to pan'
            : 'Drag to orbit · scroll to zoom · right-drag to pan'}
        </p>
      </div>

      <div className="transport">
        <button onClick={() => jump(0)} title="Back to the flat sheets" aria-label="Start">
          ⏮
        </button>
        <button onClick={prevStop} title="Previous step (←)" aria-label="Previous step">
          ◀︎❙
        </button>
        <button
          className={mode === 'backward' ? 'on' : ''}
          onClick={() => setMode(mode === 'backward' ? 'paused' : 'backward')}
          title="Play backwards (unfold / disassemble)"
          aria-label="Play backwards"
        >
          ◀︎
        </button>
        <button
          className={mode === 'forward' ? 'on' : ''}
          onClick={() => setMode(mode === 'forward' ? 'paused' : 'forward')}
          title="Play / pause (space)"
          aria-label={mode === 'forward' ? 'Pause' : 'Play'}
        >
          {mode === 'forward' ? '❚❚' : '▶︎'}
        </button>
        <button onClick={nextStop} title="Next step (→)" aria-label="Next step">
          ❙▶︎
        </button>
        <button onClick={() => jump(duration)} title="Jump to the end" aria-label="End">
          ⏭
        </button>
        <input
          className="scrub"
          type="range"
          min={0}
          max={duration}
          step={0.001}
          value={time}
          onChange={(e) => jump(Number(e.target.value))}
          aria-label="Timeline"
        />
      </div>
      <p className="stage">{stage}</p>

      <div className="viewer-options">
        {tl && tl.leafCount > 0 && (
          <button onClick={() => goTo(tl.foldedAt)} title="Animate to the finished, closed piece">
            Go to finished piece
          </button>
        )}
        <label>
          Speed
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            <option value={0.35}>Slow</option>
            <option value={1}>Normal</option>
            <option value={2.5}>Fast</option>
          </select>
        </label>
        <label>
          Explode layers
          <input
            type="range"
            min={1}
            max={30}
            step={0.5}
            value={explode}
            onChange={(e) => setExplode(Number(e.target.value))}
          />
        </label>
        <label>
          Page shape
          <select value={shape} onChange={(e) => setShape(Number(e.target.value))}>
            {PAGE_SHAPES.map((s, i) => (
              <option key={s.label} value={i}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={autoFrame}
            onChange={(e) => setAutoFrame(e.target.checked)}
          />
          Keep in frame
        </label>
        <button onClick={() => resetView.current()}>Reset view</button>
      </div>
    </div>
  );
}
