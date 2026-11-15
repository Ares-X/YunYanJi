import type { EnvironmentSnapshot, FireState, QualityPreference, WeatherMode } from '../core/types';
import type { LandscapeDefinition } from '../scenes/types';

const WEATHER_NAMES: Record<WeatherMode, string> = {
  clear: '晴天', overcast: '阴天', drizzle: '小雨', rain: '大雨', downpour: '暴雨', snow: '下雪',
};
const FIRE_NOTES: Record<FireState, string> = {
  out: '柴火已熄。可以重新点起。', embers: '余烬还暖，添柴可以续火。',
  small: '守着一点小火。', steady: '柴火慢慢燃着。', roaring: '火正旺，林间也暖了些。',
};

export interface ShellActions {
  gust: () => void;
  togglePause: () => void;
  toggleAudio: () => Promise<void>;
  setVolume: (volume: number) => void;
  setRain: (rain: number) => void;
  setWeather: (mode: WeatherMode) => void;
  setAutomaticThunder: (enabled: boolean) => void;
  thunder: () => void;
  setFire: (state: FireState) => void;
  addWood: () => void;
  setQuality: (quality: QualityPreference) => void;
  reset: () => void;
  share: () => Promise<void>;
  dialogChanged: (dialog: 'settings' | null) => void;
}

export class Shell {
  readonly canvas: HTMLCanvasElement;
  private readonly abort = new AbortController();
  private readonly dialog: HTMLDialogElement;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly sound: HTMLButtonElement;
  private readonly pause: HTMLButtonElement;
  private readonly notice: HTMLElement;
  private readonly loading: HTMLElement;
  private readonly weatherPanel: HTMLElement;
  private readonly weatherToggle: HTMLButtonElement;
  private environmentSignature = '';
  private weatherName = '大雨';
  private paused = false;

  constructor(private readonly root: HTMLElement, landscape: LandscapeDefinition, actions: ShellActions) {
    root.classList.remove('immersive');
    root.dataset.ready = 'loading';
    root.innerHTML = `
      <canvas id="landscape" tabindex="0" aria-label="林间与篝火。拖动观察四周，也可使用起风按钮。"></canvas>
      <div class="vignette" aria-hidden="true"></div>
      <header class="masthead">
        <div class="brand"><h1>云烟集</h1><span>独处的风景</span></div>
        <nav aria-label="风景工具">
          <button id="sound" aria-pressed="false">听声</button>
          <button id="weather" aria-controls="weather-panel" aria-expanded="false">天候</button>
          <button id="settings" aria-haspopup="dialog">设置</button>
          <button id="immerse" aria-pressed="false" title="收起文字与工具">入境</button>
        </nav>
      </header>
      <section id="weather-panel" class="weather-panel" aria-labelledby="weather-heading" hidden>
        <div class="panel-heading"><h2 id="weather-heading">天候与柴火</h2><button id="close-weather" aria-label="收起天候面板">收起</button></div>
        <fieldset><legend>天气</legend><div class="weather-grid">
          ${Object.entries(WEATHER_NAMES).map(([mode, name]) => `<button type="button" data-weather="${mode}" aria-pressed="${mode === 'rain'}">${name}</button>`).join('')}
        </div></fieldset>
        <div class="thunder-row"><label for="automatic-thunder"><input id="automatic-thunder" type="checkbox" />间或雷鸣</label><button id="thunder">打雷</button></div>
        <fieldset class="fire-controls"><legend>篝火</legend>
          <label class="fire-setting" for="fire-state"><span>火势</span><select id="fire-state"><option value="out">熄灭</option><option value="embers">余烬</option><option value="small">小火</option><option value="steady" selected>中火</option><option value="roaring">旺火</option></select></label>
          <button id="add-wood" aria-label="添柴"><span aria-hidden="true">＋</span> 添一根柴</button>
          <p id="fire-note" class="panel-note">柴火慢慢燃着。</p>
        </fieldset>
      </section>
      <footer class="scene-footer">
        <div class="scene-caption">
          <p id="scene-subtitle"></p>
          <h2 id="scene-title"></h2>
          <span id="hint">拖动，看一看四周</span>
        </div>
        <div class="scene-actions">
          <button id="pause" aria-pressed="false">暂停</button>
          <button id="gust">起风<span aria-hidden="true">↗</span></button>
        </div>
      </footer>
      <div id="loading" role="status"><span>云烟集</span><p>稍候</p></div>
      <p id="notice" class="notice" role="status" aria-live="polite"></p>
      <dialog id="settings-dialog" aria-labelledby="settings-heading">
        <div class="dialog-heading"><h2 id="settings-heading">此间</h2><button data-close aria-label="关闭设置">关闭</button></div>
        <label class="setting-row" for="quality"><span>画质</span><select id="quality"><option value="auto">自动</option><option value="high">细腻</option><option value="medium">均衡</option><option value="low">轻盈</option></select></label>
        <label class="setting-row" for="volume"><span>声音</span><input id="volume" type="range" min="0" max="1" step="0.01" value="0.45" aria-label="声音音量" /></label>
        <label class="setting-row" for="rain"><span id="precipitation-label">雨量</span><input id="rain" type="range" min="0" max="1" step="0.01" value="0.72" aria-label="雨量" /></label>
        <p class="settings-note">听风、听雨，或守着一场雪。<br />在「天候」里换天气、照料柴火。</p>
        <div class="settings-actions"><button id="reset">重看此境</button><button id="share">分享此境</button></div>
      </dialog>`;
    const get = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
    this.canvas = get<HTMLCanvasElement>('#landscape');
    this.sound = get<HTMLButtonElement>('#sound');
    this.pause = get<HTMLButtonElement>('#pause');
    this.notice = get('#notice');
    this.loading = get('#loading');
    this.dialog = get<HTMLDialogElement>('#settings-dialog');
    this.weatherPanel = get('#weather-panel');
    this.weatherToggle = get<HTMLButtonElement>('#weather');
    get('#scene-subtitle').textContent = landscape.subtitle;
    get('#scene-title').textContent = landscape.title;
    const on = (element: Element, event: string, listener: EventListener) => element.addEventListener(event, listener, { signal: this.abort.signal });
    const closeWeather = (focus = false) => {
      this.weatherPanel.hidden = true;
      this.weatherToggle.setAttribute('aria-expanded', 'false');
      if (focus) this.weatherToggle.focus();
    };
    on(this.weatherToggle, 'click', () => {
      const open = this.weatherPanel.hidden;
      this.weatherPanel.hidden = !open;
      this.weatherToggle.setAttribute('aria-expanded', String(open));
      if (open) this.weatherPanel.querySelector<HTMLButtonElement>('[data-weather][aria-pressed="true"]')?.focus();
    });
    on(get('#close-weather'), 'click', () => closeWeather(true));
    on(this.canvas, 'pointerdown', () => closeWeather());
    for (const button of this.weatherPanel.querySelectorAll<HTMLButtonElement>('[data-weather]')) {
      on(button, 'click', () => actions.setWeather(button.dataset.weather as WeatherMode));
    }
    on(get('#automatic-thunder'), 'change', (event) => actions.setAutomaticThunder((event.target as HTMLInputElement).checked));
    on(get('#thunder'), 'click', actions.thunder);
    on(get('#fire-state'), 'change', (event) => actions.setFire((event.target as HTMLSelectElement).value as FireState));
    on(get('#add-wood'), 'click', actions.addWood);
    on(get('#gust'), 'click', () => actions.gust());
    on(this.pause, 'click', actions.togglePause);
    const setImmersive = (immersive: boolean) => {
      if (immersive) closeWeather();
      root.classList.toggle('immersive', immersive);
      const toggle = get<HTMLButtonElement>('#immerse');
      toggle.textContent = immersive ? '显字' : '入境';
      toggle.setAttribute('aria-pressed', String(immersive));
      toggle.title = immersive ? '显示文字与工具' : '收起文字与工具';
      for (const element of root.querySelectorAll<HTMLElement>('.brand, .scene-footer, nav button:not(#immerse)')) {
        element.inert = immersive;
        if (immersive) element.setAttribute('aria-hidden', 'true');
        else element.removeAttribute('aria-hidden');
      }
    };
    on(get('#immerse'), 'click', () => setImmersive(!root.classList.contains('immersive')));
    on(root, 'keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Escape' && !this.weatherPanel.hidden) {
        event.preventDefault(); closeWeather(true); return;
      }
      if ((event as KeyboardEvent).key === 'Escape' && root.classList.contains('immersive')) {
        setImmersive(false);
        get('#immerse').focus();
      }
    });
    on(this.sound, 'click', () => {
      this.sound.disabled = true;
      void actions.toggleAudio().catch(() => this.notify('声音暂时无法开启，请再试一次。')).finally(() => { this.sound.disabled = false; });
    });
    on(get('#volume'), 'input', (event) => actions.setVolume(Number((event.target as HTMLInputElement).value)));
    on(get('#rain'), 'input', (event) => actions.setRain(Number((event.target as HTMLInputElement).value)));
    on(get('#quality'), 'change', (event) => actions.setQuality((event.target as HTMLSelectElement).value as QualityPreference));
    on(get('#reset'), 'click', () => { actions.reset(); this.dialog.close(); });
    on(get('#share'), 'click', () => { void actions.share().catch(() => this.notify('复制暂不可用，可复制地址栏分享此境。')); });
    on(get('#settings'), 'click', () => { closeWeather(); this.dialog.showModal(); actions.dialogChanged('settings'); });
    on(this.dialog.querySelector('[data-close]')!, 'click', () => this.dialog.close());
    on(this.dialog, 'close', () => {
      if (this.notice.parentElement === this.dialog) this.root.append(this.notice);
      actions.dialogChanged(null);
    });
    on(this.dialog, 'click', (event) => {
      if (event.target !== this.dialog) return;
      const rect = this.dialog.getBoundingClientRect();
      const e = event as MouseEvent;
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) this.dialog.close();
    });
  }

  ready(): void { this.root.dataset.ready = 'true'; this.loading.hidden = true; }
  setPaused(paused: boolean): void {
    this.paused = paused;
    this.pause.textContent = paused ? '继续' : '暂停';
    this.pause.setAttribute('aria-pressed', String(paused));
    this.root.querySelector('#hint')!.textContent = paused ? '已暂停，点继续或起风' : '拖动，看一看四周';
    this.updateCanvasLabel();
  }
  setAudio(enabled: boolean): void {
    this.sound.textContent = enabled ? '静音' : '听声';
    this.sound.setAttribute('aria-pressed', String(enabled));
  }
  setEnvironment(frame: EnvironmentSnapshot): void {
    const range = this.root.querySelector<HTMLInputElement>('#rain')!;
    const snowfall = frame.weather.mode === 'snow';
    // Follow a preset's crossfade, without moving a slider under the user's hand.
    if (document.activeElement !== range) range.value = String(snowfall ? frame.weather.snow : frame.weather.rain);
    const signature = `${frame.weather.revision}:${frame.fire.revision}:${frame.fire.state}`;
    if (signature === this.environmentSignature) return;
    this.environmentSignature = signature;
    this.weatherName = WEATHER_NAMES[frame.weather.mode];
    this.root.querySelector('#scene-subtitle')!.textContent = `山林 · ${this.weatherName}`;
    for (const button of this.weatherPanel.querySelectorAll<HTMLButtonElement>('[data-weather]')) {
      button.setAttribute('aria-pressed', String(button.dataset.weather === frame.weather.mode));
    }
    this.root.querySelector<HTMLInputElement>('#automatic-thunder')!.checked = frame.weather.automaticThunder;
    this.root.querySelector<HTMLSelectElement>('#fire-state')!.value = frame.fire.state;
    this.root.querySelector('#fire-note')!.textContent = FIRE_NOTES[frame.fire.state];
    const label = snowfall ? '雪量' : '雨量';
    range.disabled = frame.weather.mode === 'clear' || frame.weather.mode === 'overcast';
    range.setAttribute('aria-label', label);
    this.root.querySelector('#precipitation-label')!.textContent = label;
    this.updateCanvasLabel();
  }
  private updateCanvasLabel(): void {
    this.canvas.setAttribute('aria-label', this.paused
      ? `${this.weatherName}中的林间风景已暂停。使用继续或起风按钮观看。`
      : `${this.weatherName}与篝火。拖动观察四周，天候面板可改变天气和柴火。`);
  }
  setContextLost(lost: boolean): void {
    this.root.dataset.context = lost ? 'lost' : 'ready';
    if (lost) this.notify('画面暂时中断，正在等待恢复。', 0);
    else this.notify('风景已恢复。');
  }
  fail(message: string): void {
    // A native modal is above every ordinary overlay, including this error.
    if (this.dialog.open) this.dialog.close();
    this.weatherPanel.hidden = true;
    this.root.dataset.ready = 'error';
    this.loading.hidden = false;
    this.loading.querySelector('p')!.textContent = message;
    this.root.querySelectorAll<HTMLButtonElement>('button').forEach((button) => { button.disabled = true; });
  }
  notify(text: string, duration = 3200): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    (this.dialog.open ? this.dialog : this.root).append(this.notice);
    this.notice.textContent = text;
    this.notice.classList.add('visible');
    if (duration > 0) this.toastTimer = setTimeout(() => { this.notice.classList.remove('visible'); }, duration);
  }
  dispose(): void { this.abort.abort(); if (this.toastTimer) clearTimeout(this.toastTimer); }
}
