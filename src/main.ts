import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";

interface NowPlaying {
  has_session: boolean;
  title: string;
  artist: string;
  album: string;
  is_playing: boolean;
  position_secs: number;
  duration_secs: number;
}

interface VolumeState {
  level: number;
  muted: boolean;
}

// Tamaños de ventana en cada estado (px lógicos). Mismo ancho => la
// transición anima solo el alto (crecimiento vertical, sin reflow horizontal).
const COLLAPSED = { width: 280, height: 68 };
const EXPANDED = { width: 280, height: 360 };
const ANIM_MS = 170;
// Movimiento (px) que distingue un "arrastrar" de un "click".
const DRAG_THRESHOLD = 5;
const DEFAULT_ACCENT = "#7aa2f7";

const appWindow = getCurrentWindow();
const el = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

let expanded = false;
let lastTrackKey = ""; // refresca metadata/marquee solo cuando cambia el tema
let lastArtKey = "";
let draggingVolume = false;
let draggingSeek = false;
let sizeToken = 0; // cancela animaciones de tamaño anteriores

// Estado de la línea de tiempo. Anclamos (posición, momento) en cada poll y
// luego interpolamos localmente, porque el SMTC no refresca Position seguido.
let hasSession = false;
let trackPlaying = false;
let anchorPos = 0; // segundos reportados en el último poll
let anchorAt = 0; // performance.now() de ese poll
let trackDuration = 0;

/* ---------------- Estado expandido / colapsado (con animación) ---------------- */

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function animateSize(
  from: { width: number; height: number },
  to: { width: number; height: number },
  ms: number,
): Promise<void> {
  const token = ++sizeToken;
  const start = performance.now();
  return new Promise<void>((resolve) => {
    const step = () => {
      if (token !== sizeToken) return resolve(); // otra animación tomó el control
      const t = Math.min(1, (performance.now() - start) / ms);
      const e = easeInOutQuad(t);
      const width = Math.round(from.width + (to.width - from.width) * e);
      const height = Math.round(from.height + (to.height - from.height) * e);
      void appWindow.setSize(new LogicalSize(width, height));
      if (t < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

async function setExpanded(value: boolean): Promise<void> {
  if (expanded === value) return;
  const from = expanded ? EXPANDED : COLLAPSED;
  const to = value ? EXPANDED : COLLAPSED;
  expanded = value;

  if (value) {
    // Mostramos el contenido y crecemos (se revela de arriba hacia abajo).
    document.body.classList.add("expanded");
    void refreshArt(true);
    void refreshVolume(true);
    await animateSize(from, to, ANIM_MS);
  } else {
    // Encogemos y recién al final volvemos al layout compacto.
    await animateSize(from, to, ANIM_MS);
    document.body.classList.remove("expanded");
  }

  requestAnimationFrame(() => requestAnimationFrame(updateMarquees));
}

/* ---------------- Marquee para texto que desborda ---------------- */

function updateMarquee(wrap: HTMLElement, inner: HTMLElement): void {
  inner.classList.remove("marquee");
  inner.style.removeProperty("--mq-dist");
  inner.style.removeProperty("--mq-dur");
  wrap.style.removeProperty("text-align");

  const overflow = inner.scrollWidth - wrap.clientWidth;
  if (overflow > 2) {
    const speed =
      Number(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--marquee-speed",
        ),
      ) || 35;
    const duration = overflow / speed + 2.5; // +2.5s para las pausas en los extremos
    inner.style.setProperty("--mq-dist", `-${overflow}px`);
    inner.style.setProperty("--mq-dur", `${duration}s`);
    // Mientras scrollea, alineamos a la izquierda para arrancar desde el inicio.
    wrap.style.textAlign = "left";
    inner.classList.add("marquee");
  }
}

function updateMarquees(): void {
  updateMarquee(el("title-wrap"), el("title"));
  updateMarquee(el("artist-wrap"), el("artist"));
}

/* ---------------- Color de acento dinámico (de la carátula) ---------------- */

function applyAccentFromArt(img: HTMLImageElement): void {
  try {
    const n = 16;
    const canvas = document.createElement("canvas");
    canvas.width = n;
    canvas.height = n;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(img, 0, 0, n, n);
    const { data } = ctx.getImageData(0, 0, n, n);

    // Elegimos el pixel más "colorido" (mayor croma) con brillo razonable.
    let best = { score: -1, r: 122, g: 162, b: 247 };
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (data[i + 3] < 128) continue;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const score = (mx - mn) * (mx / 255);
      if (score > best.score && mx > 50 && mx < 250) {
        best = { score, r, g, b };
      }
    }
    document.documentElement.style.setProperty(
      "--accent",
      `rgb(${best.r}, ${best.g}, ${best.b})`,
    );
  } catch {
    // Canvas "tainted" u otro error — dejamos el acento actual.
  }
}

function resetAccent(): void {
  document.documentElement.style.setProperty("--accent", DEFAULT_ACCENT);
}

/* ---------------- Datos: metadata, carátula, timeline, volumen ---------------- */

function fmtTime(secs: number): string {
  if (!isFinite(secs) || secs < 0) secs = 0;
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function updateTimeline(position: number, duration: number): void {
  const pct = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;
  el("bar-fill").style.width = `${pct}%`;
  el("time-cur").textContent = fmtTime(position);
  el("time-dur").textContent = fmtTime(duration);
}

// Avanza la barra de forma fluida entre polls, extrapolando desde el ancla.
function tickTimeline(): void {
  if (!expanded || !hasSession || draggingSeek) return;
  let pos = anchorPos;
  if (trackPlaying) pos += (performance.now() - anchorAt) / 1000;
  if (trackDuration > 0) pos = Math.min(pos, trackDuration);
  updateTimeline(pos, trackDuration);
}

function setArt(dataUrl: string | null): void {
  const img = el<HTMLImageElement>("art-img");
  const fallback = el("art-fallback");
  if (dataUrl) {
    if (dataUrl !== lastArtKey) {
      img.onload = () => applyAccentFromArt(img);
      img.src = dataUrl;
      lastArtKey = dataUrl;
    }
    img.hidden = false;
    fallback.hidden = true;
  } else {
    img.hidden = true;
    fallback.hidden = false;
    lastArtKey = "";
    resetAccent();
  }
}

async function refreshArt(force = false): Promise<void> {
  if (!expanded && !force) return;
  try {
    const art = await invoke<string | null>("get_art");
    setArt(art);
  } catch {
    setArt(null);
  }
}

async function refreshNowPlaying(): Promise<void> {
  const np = await invoke<NowPlaying>("get_now_playing");
  const title = el("title");
  const artist = el("artist");
  const play = el("play");

  if (!np.has_session) {
    title.textContent = "Nada sonando";
    artist.textContent = "—";
    play.textContent = "▶";
    hasSession = false;
    trackPlaying = false;
    anchorPos = 0;
    trackDuration = 0;
    updateTimeline(0, 0);
    if (lastTrackKey !== "") {
      lastTrackKey = "";
      setArt(null);
      updateMarquees();
    }
    return;
  }

  title.textContent = np.title || "—";
  artist.textContent = np.artist || "—";
  play.textContent = np.is_playing ? "⏸" : "▶";

  // Anclamos para que tickTimeline interpole suave entre polls.
  hasSession = true;
  anchorPos = np.position_secs;
  anchorAt = performance.now();
  trackPlaying = np.is_playing;
  trackDuration = np.duration_secs;

  const key = `${np.title}|${np.artist}`;
  if (key !== lastTrackKey) {
    lastTrackKey = key;
    updateMarquees();
    if (expanded) void refreshArt(true);
  }
}

async function refreshVolume(force = false): Promise<void> {
  if ((!expanded && !force) || draggingVolume) return;
  try {
    const state = await invoke<VolumeState>("get_volume");
    el<HTMLInputElement>("vol").value = String(Math.round(state.level * 100));
    el("mute").textContent = state.muted ? "🔇" : "🔊";
  } catch {
    // Sin endpoint de audio — dejamos la UI como está.
  }
}

/* ---------------- Controles ---------------- */

function wireControls(): void {
  el("prev").addEventListener("click", () => {
    void invoke("media_prev").catch(() => {});
  });

  el("next").addEventListener("click", () => {
    void invoke("media_next").catch(() => {});
  });

  el("play").addEventListener("click", async () => {
    await invoke("media_play_pause").catch(() => {});
    void refreshNowPlaying();
  });

  el("mute").addEventListener("click", async () => {
    await invoke("toggle_mute").catch(() => {});
    void refreshVolume(true);
  });

  const vol = el<HTMLInputElement>("vol");
  vol.addEventListener("input", () => {
    draggingVolume = true;
    void invoke("set_volume", { level: Number(vol.value) / 100 }).catch(() => {});
  });
  vol.addEventListener("change", () => {
    draggingVolume = false;
  });
}

/* ---------------- Seek: arrastrar / clickear la línea de tiempo ---------------- */

function setupSeek(): void {
  const bar = el("bar");
  let scrubbing = false;

  const posFromEvent = (e: MouseEvent): number => {
    const rect = bar.getBoundingClientRect();
    const frac =
      rect.width > 0
        ? Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
        : 0;
    return frac * trackDuration;
  };

  bar.addEventListener("mousedown", (e) => {
    if (trackDuration <= 0) return;
    e.stopPropagation(); // que no dispare expand/drag de la tarjeta
    scrubbing = true;
    draggingSeek = true;
    updateTimeline(posFromEvent(e), trackDuration);
  });

  window.addEventListener("mousemove", (e) => {
    if (!scrubbing) return;
    updateTimeline(posFromEvent(e), trackDuration);
  });

  window.addEventListener("mouseup", (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    const pos = posFromEvent(e);
    void invoke("media_seek", { position: pos }).catch(() => {});
    // Re-anclamos localmente para feedback inmediato.
    anchorPos = pos;
    anchorAt = performance.now();
    draggingSeek = false;
  });
}

/* ---------------- Gestos: click = expandir, arrastrar = mover ---------------- */

function setupCardGestures(): void {
  const card = el("card");
  let downX = 0;
  let downY = 0;
  let pressing = false;
  let dragStarted = false;

  card.addEventListener("mousedown", (e) => {
    const target = e.target as HTMLElement;
    // Controles y línea de tiempo se manejan solos: ni arrastran ni expanden.
    if (target.closest("button, input, .timeline")) return;
    if (e.button !== 0) return;
    pressing = true;
    dragStarted = false;
    downX = e.clientX;
    downY = e.clientY;
  });

  window.addEventListener("mousemove", (e) => {
    if (!pressing || dragStarted) return;
    if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > DRAG_THRESHOLD) {
      dragStarted = true;
      void appWindow.startDragging();
    }
  });

  window.addEventListener("mouseup", () => {
    if (pressing && !dragStarted) {
      void setExpanded(!expanded);
    }
    pressing = false;
    dragStarted = false;
  });
}

/* ---------------- Menú contextual (click derecho) ---------------- */

function setupContextMenu(): void {
  const menu = el("ctx-menu");
  const card = el("card");
  const hideMenu = () => {
    menu.hidden = true;
  };

  card.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    menu.hidden = false;
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const x = Math.min(e.clientX, window.innerWidth - mw - 4);
    const y = Math.min(e.clientY, window.innerHeight - mh - 4);
    menu.style.left = `${Math.max(4, x)}px`;
    menu.style.top = `${Math.max(4, y)}px`;
  });

  el("ctx-hide").addEventListener("click", () => {
    hideMenu();
    void appWindow.hide();
  });

  el("ctx-quit").addEventListener("click", () => {
    hideMenu();
    void invoke("quit_app");
  });

  // Cerrar el menú al hacer click en cualquier lado o al perder foco.
  window.addEventListener("click", hideMenu);
  window.addEventListener("blur", hideMenu);
}

/* ---------------- Init ---------------- */

window.addEventListener("DOMContentLoaded", async () => {
  wireControls();
  setupSeek();
  setupCardGestures();
  setupContextMenu();

  // Arranca colapsado.
  await appWindow.setSize(new LogicalSize(COLLAPSED.width, COLLAPSED.height));

  await refreshNowPlaying();
  setInterval(refreshNowPlaying, 1000);
  setInterval(() => void refreshVolume(), 1000);
  setInterval(tickTimeline, 250);

  // Re-medir el marquee cuando cambia el tamaño real del webview.
  window.addEventListener("resize", updateMarquees);
});
