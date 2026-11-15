import { ProceduralAmbience } from './audio/ProceduralAmbience';
import { readSeed, sceneLink } from './core/location';
import type { QualityPreference } from './core/types';
import { WeatherSimulation } from './core/WeatherSimulation';
import { resolveQuality } from './render/quality';
import { WorldRenderer } from './render/WorldRenderer';
import { getLandscape } from './scenes/registry';
import { Shell } from './ui/Shell';
import './ui/styles.css';

async function start(): Promise<() => void> {
  const root = document.querySelector<HTMLElement>('#app')!;
  const seed = readSeed(window.location.search);
  const landscape = getLandscape();
  const weather = new WeatherSimulation(seed);
  const audio = new ProceduralAmbience(seed);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const coarsePointer = window.matchMedia('(pointer: coarse)');
  const events = new AbortController();
  let quality: QualityPreference = 'auto';
  let manualPause = reducedMotion.matches;
  let activeDialog: 'settings' | null = null;
  let contextLost = false;
  let restoring = false;
  let disposed = false;
  let prepared = false;
  let world: WorldRenderer | undefined;
  let raf = 0;
  let stillRaf = 0;
  let lastTime = 0;
  let frameCount = 0;
  let lastFrameMs = 0;
  weather.reducedMotion = reducedMotion.matches;
  const suspended = () => manualPause || activeDialog !== null || document.hidden || contextLost || disposed;
  // Keep an already-enabled ambience audible while adjusting its volume.
  const audioSuspended = () => manualPause || document.hidden || contextLost || disposed;

  const renderStill = () => {
    return world && prepared && !contextLost && !disposed
      ? world.render(weather.snapshot()) : true;
  };

  // A settings/resize event should update state immediately without compiling a
  // new shader variant inside the input handler. Merge static redraws into the
  // next frame; the active animation loop already covers an unpaused scene.
  const scheduleStill = () => {
    if (!prepared || contextLost || disposed || stillRaf || (!suspended() && raf)) return;
    stillRaf = requestAnimationFrame(() => {
      stillRaf = 0;
      if (!renderStill()) scheduleStill();
    });
  };

  const frame = (now: number) => {
    raf = 0;
    if (suspended()) return;
    const delta = lastTime === 0 ? 0 : (now - lastTime) / 1000;
    lastTime = now;
    const snapshot = weather.advance(delta);
    const begin = performance.now();
    if (world?.render(snapshot)) {
      lastFrameMs = performance.now() - begin;
      frameCount += 1;
    }
    audio.update(snapshot);
    ui.setEnvironment(snapshot);
    raf = requestAnimationFrame(frame);
  };

  const syncPlayback = (redraw = true) => {
    cancelAnimationFrame(raf);
    cancelAnimationFrame(stillRaf);
    raf = 0;
    stillRaf = 0;
    lastTime = 0;
    audio.update(weather.snapshot());
    void audio.setSuspended(audioSuspended()).catch(() => ui.notify('声音暂时中断，可重新开启。'));
    ui.setPaused(manualPause);
    if (!suspended() && world && prepared) raf = requestAnimationFrame(frame);
    else if (redraw) scheduleStill();
  };

  const triggerGust = (direction = 1, strength = 1) => {
    weather.gust(direction, strength);
    if (manualPause) {
      manualPause = false;
      syncPlayback();
    }
    ui.notify('风起了。', 1800);
  };

  const ui = new Shell(root, landscape, {
    gust: triggerGust,
    togglePause: () => { manualPause = !manualPause; syncPlayback(); },
    toggleAudio: async () => {
      try {
        await audio.setEnabled(!audio.enabled);
        ui.setAudio(audio.enabled);
      } catch (error) {
        ui.setAudio(false);
        throw error;
      }
    },
    setVolume: (value) => audio.setVolume(value),
    setRain: (value) => {
      weather.setPrecipitation(value);
      audio.update(weather.snapshot());
      ui.setEnvironment(weather.snapshot());
      scheduleStill();
    },
    setWeather: (mode) => {
      weather.setWeather(mode, suspended());
      const snapshot = weather.snapshot();
      audio.update(snapshot); ui.setEnvironment(snapshot); scheduleStill();
    },
    setAutomaticThunder: (enabled) => {
      weather.setAutomaticThunder(enabled);
      const snapshot = weather.snapshot();
      audio.update(snapshot); ui.setEnvironment(snapshot); scheduleStill();
    },
    thunder: () => {
      if (!weather.triggerThunder()) { ui.notify('雷声还在山间回荡。', 1600); return; }
      if (manualPause) { manualPause = false; syncPlayback(); }
      audio.update(weather.snapshot()); scheduleStill();
      ui.notify(weather.reducedMotion ? '远处要响雷了。' : '远处一道闪电，雷声稍后到来。', 2800);
    },
    setFire: (state) => {
      weather.setFireState(state, suspended());
      const snapshot = weather.snapshot();
      audio.update(snapshot); ui.setEnvironment(snapshot); scheduleStill();
    },
    addWood: () => {
      if (!weather.addWood()) { ui.notify('柴堆已经放满了。', 1800); return; }
      const snapshot = weather.snapshot();
      audio.update(snapshot); ui.setEnvironment(snapshot); scheduleStill();
      ui.notify(snapshot.fire.state === 'out' ? '柴放好了，选择火势即可点燃。'
        : manualPause ? '添了一根柴，继续后看它慢慢燃起。' : '添了一根柴，等它慢慢燃起来。');
    },
    setQuality: (value) => { quality = value; resize(); },
    reset: () => {
      weather.reset(); world?.resetView();
      const snapshot = weather.snapshot();
      audio.update(snapshot); ui.setEnvironment(snapshot); scheduleStill();
      ui.notify('回到初见时。');
    },
    share: async () => {
      const link = sceneLink(window.location.href, seed);
      window.history.replaceState(null, '', link);
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(link);
      ui.notify('此境的链接已复制。');
    },
    dialogChanged: (value) => { activeDialog = value; syncPlayback(); },
  });
  ui.setPaused(manualPause);
  ui.setEnvironment(weather.snapshot());
  audio.update(weather.snapshot());

  const resize = () => {
    if (!world || disposed || contextLost) return;
    const bounds = root.getBoundingClientRect();
    world.setQuality(resolveQuality(quality, bounds.width, coarsePointer.matches));
    world.resize(bounds.width, bounds.height);
    scheduleStill();
  };

  const resizeObserver = new ResizeObserver(resize);
  let down: { x: number; y: number; lastX: number; lastY: number; id: number } | undefined;
  const options = { signal: events.signal };
  ui.canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || suspended()) return;
    down = { x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, id: event.pointerId };
    ui.canvas.setPointerCapture(event.pointerId);
    ui.canvas.focus({ preventScroll: true });
  }, options);
  ui.canvas.addEventListener('pointermove', (event) => {
    if (!down || down.id !== event.pointerId) return;
    world?.moveView((event.clientX - down.lastX) / 180, (down.lastY - event.clientY) / 220);
    down.lastX = event.clientX;
    down.lastY = event.clientY;
  }, options);
  const release = (event: PointerEvent, cancelled: boolean) => {
    if (!down || down.id !== event.pointerId) return;
    const distance = event.clientX - down.x;
    down = undefined;
    if (ui.canvas.hasPointerCapture(event.pointerId)) ui.canvas.releasePointerCapture(event.pointerId);
    if (!cancelled && Math.abs(distance) > 12) triggerGust(Math.sign(distance), Math.min(1, Math.abs(distance) / 170));
  };
  ui.canvas.addEventListener('pointerup', (event) => release(event, false), options);
  ui.canvas.addEventListener('pointercancel', (event) => release(event, true), options);
  ui.canvas.addEventListener('lostpointercapture', () => { down = undefined; }, options);
  document.addEventListener('keydown', (event) => {
    if (activeDialog !== null || event.repeat || (event.target !== document.body && event.target !== ui.canvas)) return;
    if (event.code === 'Space') { event.preventDefault(); triggerGust(); }
    if (event.code === 'KeyP') { manualPause = !manualPause; syncPlayback(); }
  }, options);
  document.addEventListener('visibilitychange', () => syncPlayback(), options);
  reducedMotion.addEventListener('change', (event) => {
    weather.reducedMotion = event.matches;
    // Leaving reduced motion preserves manual pause and any pending settings
    // redraw. The active loop already reads the updated preference.
    if (event.matches) {
      manualPause = true;
      syncPlayback();
    }
  }, options);
  window.addEventListener('resize', resize, options);
  coarsePointer.addEventListener('change', resize, options);

  ui.canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    contextLost = true;
    prepared = false;
    world?.forgetPendingFrame();
    down = undefined;
    ui.setContextLost(true);
    syncPlayback();
  }, options);
  ui.canvas.addEventListener('webglcontextrestored', () => {
    if (disposed || restoring) return;
    restoring = true;
    void (async () => {
      try {
        // This listener precedes Three.js' restoration listener. Native event
        // callbacks can have a microtask checkpoint between them, so a resolved
        // Promise is too early: Three would discard our newly rendered targets.
        // A new task guarantees its GL caches are ready before regenerating them.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (disposed) return;
        world?.rebuildEnvironment();
        await world?.prepare();
        if (disposed) return;
        prepared = true;
        contextLost = false;
        resize();
        renderStill();
        ui.setContextLost(false);
        syncPlayback(false);
      } catch {
        ui.fail('画面未能恢复，请刷新页面重试。');
      } finally { restoring = false; }
    })();
  }, options);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    cancelAnimationFrame(stillRaf);
    events.abort();
    resizeObserver.disconnect();
    ui.dispose();
    world?.dispose();
    void audio.dispose();
  };
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) dispose();
    else { cancelAnimationFrame(raf); void audio.setSuspended(true); }
  }, options);
  window.addEventListener('pageshow', () => { if (!disposed) syncPlayback(); }, options);

  if (new URLSearchParams(location.search).get('debug') === '1') {
    // Explicit opt-in diagnostic readout, absent from the visitor interface.
    window.__YUNYANJI__ = {
      getState: () => {
        const snapshot = weather.snapshot();
        return { seed, scene: landscape.id, elapsed: snapshot.elapsed, gust: snapshot.gust,
          rain: snapshot.weather.rain, snow: snapshot.weather.snow, weather: snapshot.weather,
          lightning: snapshot.lightning, fire: snapshot.fire,
          paused: manualPause, suspended: suspended(), disposed, contextLost,
          frames: frameCount, lastRenderCpuMs: lastFrameMs,
          audioEnabled: audio.enabled, audioState: audio.state, audioContext: audio.contextState, audioVolume: audio.volume,
          ...audio.diagnostics(), ...world?.diagnostics() };
      },
      dispose,
    };
  }

  let scene;
  try {
    scene = landscape.create({ seed, quality: resolveQuality(quality, root.clientWidth, coarsePointer.matches) });
    world = new WorldRenderer(ui.canvas, scene, resolveQuality(quality, root.clientWidth, coarsePointer.matches));
    resizeObserver.observe(root);
    resize();
    await world.prepare();
    prepared = true;
    if (!disposed) { renderStill(); ui.ready(); syncPlayback(false); }
  } catch (error) {
    console.error('Unable to create YunYanJi landscape', error);
    if (!world) scene?.dispose();
    else world.dispose();
    world = undefined;
    resizeObserver.disconnect();
    ui.fail('此浏览器暂时无法呈现风景，请使用支持 WebGL 2 的浏览器重试。');
  }
  return dispose;
}

void start().then((dispose) => { import.meta.hot?.dispose(dispose); }).catch((error: unknown) => {
  console.error(error);
  const root = document.querySelector('#app');
  if (root) root.textContent = '云烟集暂时未能打开，请刷新页面重试。';
});
