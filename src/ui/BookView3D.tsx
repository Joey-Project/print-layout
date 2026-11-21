import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { PaperPlan, Plan, Recipe, Slot } from '../engine';
import type { PanelArt } from './pdfArt';
import {
  logEvent,
  rounded,
  type ViewerDebug,
  type ViewerSnapshot,
  type ViewerState,
} from './debugReport';
import { faceTexture, seamTexture, wasteTexture } from '../viewer/faceTexture';
import { seamStrip } from '../viewer/seams';
import { buildTimeline, type PageTurn, type Seam, type Timeline } from '../viewer/timeline';

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

/** Segments along a fold's curve. */
const SEAM_SEGMENTS = 16;

interface SeamMesh {
  seam: Seam;
  mesh: THREE.Mesh;
  positions: THREE.BufferAttribute;
}

interface FaceMesh {
  mesh: THREE.Mesh;
  slot: Slot | undefined;
  sheet: number;
  side: 'front' | 'back';
  col: number;
  row: number;
}

interface SceneState {
  tl: Timeline;
  groups: THREE.Group[];
  faces: FaceMesh[];
  seams: SeamMesh[];
  /** Blank sections cut off the printed sheets. */
  waste: THREE.Mesh[];
  mats: THREE.Matrix4[];
}

/** A strip of paper with `SEAM_SEGMENTS` quads, reshaped every frame. */
function seamMesh(seam: Seam, sheet: number): SeamMesh {
  const n = SEAM_SEGMENTS;
  const geometry = new THREE.BufferGeometry();
  const positions = new THREE.BufferAttribute(new Float32Array((n + 1) * 2 * 3), 3);
  positions.setUsage(THREE.DynamicDrawUsage);
  const uv = new Float32Array((n + 1) * 2 * 2);
  const index: number[] = [];
  for (let i = 0; i <= n; i++) {
    uv.set([i / n, 0, i / n, 1], i * 4);
    if (i < n) index.push(2 * i, 2 * i + 2, 2 * i + 1, 2 * i + 1, 2 * i + 2, 2 * i + 3);
  }
  geometry.setAttribute('position', positions);
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(index);
  const length = Math.hypot(seam.p1[0] - seam.p0[0], seam.p1[1] - seam.p0[1]);
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshLambertMaterial({
      map: seamTexture(sheet, length),
      side: THREE.DoubleSide,
    }),
  );
  mesh.frustumCulled = false;
  mesh.visible = false;
  return { seam, mesh, positions };
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

interface Three {
  renderer: THREE.WebGLRenderer;
  world: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
}

const vec = (v: THREE.Vector3): [number, number, number] => [v.x, v.y, v.z];

/** Bounds of the visible meshes under `root` (Box3.setFromObject counts hidden ones too). */
function visibleBounds(root: THREE.Object3D, out: THREE.Box3) {
  out.makeEmpty();
  root.traverseVisible((o) => {
    if ((o as THREE.Mesh).isMesh) out.expandByObject(o);
  });
  return out;
}

export function BookView3D({
  recipe,
  plan,
  debug,
  restore,
  onRestored,
  art = null,
  artVersion = 0,
  pdfAspect = null,
  pdfAspectLabel = 'From PDF',
  gang = null,
}: {
  recipe: Recipe;
  plan: Plan;
  /** Page artwork from a loaded PDF (null: numbered placeholders). */
  art?: PanelArt | null;
  /** Changes whenever more artwork is available. */
  artVersion?: number;
  /** Page height / width of the loaded PDF (or of the print sections); offered as a page shape. */
  pdfAspect?: number | null;
  /** Name of that page shape in the menu. */
  pdfAspectLabel?: string;
  /**
   * How sheets are printed (from the print settings): several per printed sheet, or sections with
   * blank ones. The model then starts by cutting the printed sheets.
   */
  gang?: PaperPlan | null;
  /** Filled with a handle that snapshots the viewer for bug reports. */
  debug?: React.RefObject<ViewerDebug | null>;
  /** Viewer state to restore (from a loaded bug report); `onRestored` fires once applied. */
  restore?: ViewerState | null;
  onRestored?: () => void;
}) {
  // Page shape: an index into PAGE_SHAPES, or -1 for the loaded PDF's own shape.
  const [shape, setShape] = useState(pdfAspect ? -1 : 0);
  useEffect(() => {
    if (pdfAspect) setShape(-1);
    else setShape((s) => (s === -1 ? 0 : s));
  }, [pdfAspect]);
  const aspect = shape === -1 && pdfAspect ? pdfAspect : PAGE_SHAPES[Math.max(0, shape)]!.aspect;
  const built = useMemo((): { tl: Timeline } | { error: string } => {
    try {
      return { tl: buildTimeline(recipe, plan, aspect, gang) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [recipe, plan, aspect, gang]);
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
  const three = useRef<Three | null>(null);
  /** The artwork function and image each face was last drawn with. */
  const artApplied = useRef<PanelArt | null>(null);
  const artSeen = useRef(new Map<THREE.Mesh, unknown>());

  const setMode = (m: PlayMode) => {
    if (m !== live.current.mode) logEvent('mode', { mode: m, time: live.current.time });
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
    /**
     * The leaf being dragged: how far out from the spine it was grabbed (so it turns at the
     * pointer's rate) and the offset between where the pointer maps and where the leaf actually was
     * (so it does not jump when grabbed away from its outer edge, or while lifted).
     */
    let drag: { rank: number; reach: number; offset: number } | null = null;
    const aim = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
    };
    const turnable = () => {
      const pt = scene.current?.tl.pageTurn;
      return pt && live.current.time >= pt.start - 1e-6 ? pt : null;
    };
    /** The leaf of the front-most panel under the pointer, and where it was hit. */
    const leafUnderPointer = (pt: PageTurn) => {
      // Folds (seam strips) are not grabbable; look past them to the first page.
      const hit = raycaster
        .intersectObject(group, true)
        .find((h) => h.object.parent?.userData.panel !== undefined);
      if (!hit) return null;
      const panel = hit.object.parent?.userData.panel as number | undefined;
      const rank = panel === undefined ? undefined : pt.rankOf(panel);
      return rank === undefined ? null : { rank, point: hit.point };
    };
    const overBook = () => raycaster.intersectObject(group, true).length > 0;
    const onDown = (e: PointerEvent) => {
      const pt = turnable();
      if (e.button !== 0 || !pt) return;
      aim(e);
      // Grab the leaf actually under the pointer — not whichever leaf is still settling from the
      // last release, which is what made a quick second flip snap back to the previous page.
      const grabbed = leafUnderPointer(pt);
      if (grabbed === null || !raycaster.ray.intersectPlane(bookPlane, onPlane)) return;
      const { rank, point } = grabbed;
      if (rank < 0 || rank >= pt.leafCount) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      const explode = live.current.explode;
      // Measured with the pose the hit point was taken from (before any settling leaf lands).
      const reach = pt.reachAt(rank, live.current.time, point.x, point.y, point.z, explode);
      const startTime = pt.grab(live.current.time, rank);
      const offset = pt.progressOf(startTime, rank) - pt.progressAt(onPlane.x, onPlane.y, reach);
      drag = { rank, reach, offset };
      logEvent('grab', {
        rank,
        time: live.current.time,
        settlingTo: live.current.target,
        pointer: [onPlane.x, onPlane.y],
        reach,
        offset,
      });
      setMode('paused');
      live.current.target = null;
      live.current.time = startTime;
      setTime(startTime);
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
    };
    const onMove = (e: PointerEvent) => {
      const pt = turnable();
      aim(e);
      if (drag && pt) {
        if (!raycaster.ray.intersectPlane(bookPlane, onPlane)) return;
        const progress = pt.progressAt(onPlane.x, onPlane.y, drag.reach) + drag.offset;
        const t = pt.timeFor(drag.rank, Math.min(1, Math.max(0, progress)));
        logEvent('drag', { rank: drag.rank, time: t, pointer: [onPlane.x, onPlane.y] });
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
      logEvent('release', {
        rank: drag.rank,
        time: live.current.time,
        settleTo: live.current.target,
      });
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
    three.current = { renderer, world, camera, controls };
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
        s.waste.forEach((mesh, i) => {
          mesh.visible = s.tl.wasteAt(i, t, mesh.matrix);
        });
        for (const sm of s.seams) {
          // Each section's folds wrap round that section's own spine axis.
          const axis = s.tl.spineAxisAt(t, L.explode, sm.seam.a);
          const arr = sm.positions.array as Float32Array;
          const gap = seamStrip(
            sm.seam,
            s.mats[sm.seam.a]!,
            s.mats[sm.seam.b]!,
            SEAM_SEGMENTS,
            arr,
            axis,
          );
          sm.mesh.visible = t < sm.seam.cutAt && gap > 1e-6;
          if (!sm.mesh.visible) continue;
          sm.positions.needsUpdate = true;
          sm.mesh.geometry.computeVertexNormals();
          sm.mesh.geometry.computeBoundingBox();
        }
        group.updateMatrixWorld(true);

        if ((L.autoFrame || L.snap) && !drag) {
          // Only what is shown: cut-off waste and cut seams stay in the group, hidden.
          visibleBounds(group, box);
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
      // Keep the whole scene between the clipping planes, however far out the camera is (a long
      // column of printed sheets can need a camera hundreds of units away).
      if (s) {
        box.setFromObject(root.current ?? world);
        if (!box.isEmpty()) {
          box.getCenter(center);
          const far = Math.max(
            50,
            (camera.position.distanceTo(center) + box.getSize(size).length() / 2) * 1.5,
          );
          if (Math.abs(far - camera.far) > camera.far * 0.05) {
            camera.far = far;
            camera.near = Math.max(0.01, far / 20000);
            camera.updateProjectionMatrix();
          }
        }
      }
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
      three.current = null;
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
    const faces: FaceMesh[] = [];
    const groups = tl.panels.map((p, i) => {
      const g = new THREE.Group();
      g.matrixAutoUpdate = false;
      const cx = p.col + 0.5;
      const cy = -(p.row + 0.5) * aspect;
      const sheet = plan.sheets[p.sheet]!;
      const frontSlot = sheet.front.find((s) => s.col === p.col && s.row === p.row);
      const backSlot = sheet.back.find((s) => s.col === cols - 1 - p.col && s.row === p.row);
      const backCol = cols - 1 - p.col;
      const front = new THREE.Mesh(
        new THREE.PlaneGeometry(1, aspect).translate(cx, cy, 0.0015),
        new THREE.MeshLambertMaterial({
          map: faceTexture(
            frontSlot,
            p.sheet,
            'front',
            aspect,
            art?.(p.sheet, 'front', p.col, p.row),
          ),
        }),
      );
      const back = new THREE.Mesh(
        new THREE.PlaneGeometry(1, aspect).rotateY(Math.PI).translate(cx, cy, -0.0015),
        new THREE.MeshLambertMaterial({
          map: faceTexture(
            backSlot,
            p.sheet,
            'back',
            aspect,
            art?.(p.sheet, 'back', backCol, p.row),
          ),
        }),
      );
      faces.push(
        { mesh: front, slot: frontSlot, sheet: p.sheet, side: 'front', col: p.col, row: p.row },
        { mesh: back, slot: backSlot, sheet: p.sheet, side: 'back', col: backCol, row: p.row },
      );
      g.add(front, back);
      g.userData.panel = i;
      group.add(g);
      return g;
    });
    const seams = tl.seams.map((seam) => seamMesh(seam, tl.panels[seam.a]!.sheet));
    for (const sm of seams) group.add(sm.mesh);
    const waste = tl.waste.map((w) => {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(w.w, w.h * aspect).translate(w.w / 2, (-w.h * aspect) / 2, 0),
        new THREE.MeshLambertMaterial({
          map: wasteTexture(w.w, w.h * aspect),
          side: THREE.DoubleSide,
        }),
      );
      mesh.matrixAutoUpdate = false;
      mesh.visible = false;
      group.add(mesh);
      return mesh;
    });
    scene.current = {
      tl,
      groups,
      faces,
      seams,
      waste,
      mats: tl.panels.map(() => new THREE.Matrix4()),
    };
    artApplied.current = art;
    artSeen.current = new Map(
      faces.map((f) => [f.mesh, art?.(f.sheet, f.side, f.col, f.row) ?? null] as const),
    );
    const t = Math.min(live.current.time, tl.duration);
    live.current.time = t;
    live.current.target = null;
    live.current.snap = true;
    setTime(t);
    // Artwork that arrives later is swapped in by the effect below; a rebuild only follows the
    // timeline (so it does not reset time or camera as pages render).
  }, [tl, plan, recipe, aspect]);

  // ---- Swap in page artwork as it renders, without rebuilding (keeps the camera and time). ----
  useEffect(() => {
    const s = scene.current;
    if (!s) return;
    if (artApplied.current !== art) artSeen.current = new Map();
    artApplied.current = art;
    for (const f of s.faces) {
      const image = art?.(f.sheet, f.side, f.col, f.row) ?? null;
      if (artSeen.current.get(f.mesh) === image) continue;
      artSeen.current.set(f.mesh, image);
      const mat = f.mesh.material as THREE.MeshLambertMaterial;
      mat.map?.dispose();
      mat.map = faceTexture(f.slot, f.sheet, f.side, aspect, image);
      mat.needsUpdate = true;
    }
  }, [art, artVersion, aspect, tl]);

  // ---- Bug reports: restore a reported state, and expose a snapshot of the current one. ----
  useEffect(() => {
    if (!restore || !tl) return;
    if (restore.shape !== shape) {
      setShape(restore.shape); // the timeline rebuilds, then this runs again
      return;
    }
    const L = live.current;
    Object.assign(L, {
      time: Math.min(Math.max(0, restore.time), tl.duration),
      mode: 'paused',
      speed: restore.speed,
      explode: restore.explode,
      autoFrame: restore.autoFrame,
      snap: false,
      target: null,
    });
    setModeState('paused');
    setSpeed(restore.speed);
    setExplode(restore.explode);
    setAutoFrame(restore.autoFrame);
    setTime(L.time);
    const t3 = three.current;
    if (t3) {
      t3.camera.position.fromArray(restore.camera.position);
      t3.camera.up.fromArray(restore.camera.up);
      t3.camera.fov = restore.camera.fov;
      t3.camera.updateProjectionMatrix();
      t3.controls.target.fromArray(restore.camera.target);
      t3.controls.update();
    }
    logEvent('restored', { time: L.time });
    onRestored?.();
  }, [restore, tl, shape, onRestored]);

  useEffect(() => {
    if (!debug) return;
    debug.current = {
      snapshot(): ViewerSnapshot {
        const L = live.current;
        const t3 = three.current;
        const s = scene.current;
        let screenshot: string | null = null;
        if (t3) {
          // Render now so the drawing buffer still holds the frame when it is read back.
          t3.renderer.render(t3.world, t3.camera);
          try {
            screenshot = t3.renderer.domElement.toDataURL('image/png');
          } catch {
            screenshot = null;
          }
        }
        const state: ViewerState = {
          time: L.time,
          mode: L.mode,
          speed: L.speed,
          explode: L.explode,
          autoFrame: L.autoFrame,
          shape,
          camera: t3
            ? {
                position: vec(t3.camera.position),
                target: vec(t3.controls.target),
                up: vec(t3.camera.up),
                fov: t3.camera.fov,
              }
            : { position: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], fov: 35 },
        };
        const derived = s
          ? {
              stage,
              settlingTo: L.target,
              aspect,
              canvas: t3
                ? {
                    css: [t3.renderer.domElement.clientWidth, t3.renderer.domElement.clientHeight],
                    pixelRatio: t3.renderer.getPixelRatio(),
                  }
                : null,
              timeline: {
                duration: s.tl.duration,
                foldedAt: s.tl.foldedAt,
                leafCount: s.tl.leafCount,
                readStart: s.tl.pageTurn?.start ?? null,
                segments: s.tl.segments,
                stops: s.tl.stops,
              },
              spineAxis: s.tl.spineAxisAt(L.time, L.explode),
              panels: s.tl.panels.map((p, i) => ({
                ...p,
                leaf: s.tl.pageTurn?.rankOf(i) ?? null,
                matrix: s.mats[i]!.elements.slice(),
              })),
              seams: s.seams.map((sm) => ({
                a: sm.seam.a,
                b: sm.seam.b,
                spine: sm.seam.spine,
                cutAt: Number.isFinite(sm.seam.cutAt) ? sm.seam.cutAt : null,
                visible: sm.mesh.visible,
              })),
            }
          : { error: 'error' in built ? built.error : 'no timeline' };
        return { state: rounded(state), derived: rounded(derived), screenshot };
      },
    };
    return () => {
      debug.current = null;
    };
  });

  // ---- Transport helpers. ----
  const duration = tl?.duration ?? 0;
  const goTo = (t: number) => {
    logEvent('goTo', { to: t, time: live.current.time });
    setMode('paused');
    live.current.target = Math.min(Math.max(0, t), duration);
  };
  const jump = (t: number) => {
    logEvent('jump', { to: t, time: live.current.time });
    setMode('paused');
    live.current.target = null;
    live.current.time = t;
    setTime(t);
  };
  const stops = tl?.stops ?? [0];
  const prevStop = () => goTo(stops.filter((s) => s < time - 1e-6).at(-1) ?? 0);
  const nextStop = () => goTo(stops.find((s) => s > time + 1e-6) ?? duration);

  const onKey = (e: React.KeyboardEvent) => {
    // Leave keys to focused controls (Space toggles a checkbox, arrows move a slider…).
    const el = e.target as HTMLElement;
    if (el !== e.currentTarget && el.closest('input, select, textarea, button, a')) return;
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
          <select
            value={speed}
            onChange={(e) => {
              logEvent('speed', { value: Number(e.target.value) });
              setSpeed(Number(e.target.value));
            }}
          >
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
            onChange={(e) => {
              logEvent('explode', { value: Number(e.target.value) });
              setExplode(Number(e.target.value));
            }}
          />
        </label>
        <label>
          Page shape
          <select
            value={shape}
            onChange={(e) => {
              logEvent('shape', { value: Number(e.target.value) });
              setShape(Number(e.target.value));
            }}
          >
            {pdfAspect && <option value={-1}>{pdfAspectLabel}</option>}
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
