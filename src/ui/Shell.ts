import type { QualityPreference } from '../core/types';
import type { LandscapeDefinition } from '../scenes/types';

export interface ShellActions {
  gust: () => void;
  togglePause: () => void;
  toggleAudio: () => Promise<void>;
  setVolume: (volume: number) => void;
  setRain: (rain: number) => void;
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

  constructor(private readonly root: HTMLElement, landscape: LandscapeDefinition, actions: ShellActions) {
    root.classList.remove('immersive');
    root.dataset.ready = 'loading';
    root.innerHTML = `
      <canvas id="landscape" tabindex="0" aria-label="雨夜与篝火。拖动观察四周，也可使用起风按钮。"></canvas>
      <div class="vignette" aria-hidden="true"></div>
      <header class="masthead">
        <div class="brand"><h1>云烟集</h1><span>独处的风景</span></div>
        <nav aria-label="风景工具">
          <button id="sound" aria-pressed="false">听雨</button>
          <button id="settings" aria-haspopup="dialog">设置</button>
          <button id="immerse" aria-pressed="false" title="收起文字与工具">入境</button>
        </nav>
      </header>
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
        <label class="setting-row" for="rain"><span>雨量</span><input id="rain" type="range" min="0" max="1" step="0.01" value="0.72" aria-label="雨量" /></label>
        <p class="settings-note">近处是火，远处是雨。</p>
        <div class="settings-actions"><button id="reset">重看此境</button><button id="share">分享此境</button></div>
      </dialog>`;
    const get = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
    this.canvas = get<HTMLCanvasElement>('#landscape');
    this.sound = get<HTMLButtonElement>('#sound');
    this.pause = get<HTMLButtonElement>('#pause');
    this.notice = get('#notice');
    this.loading = get('#loading');
    this.dialog = get<HTMLDialogElement>('#settings-dialog');
    get('#scene-subtitle').textContent = landscape.subtitle;
    get('#scene-title').textContent = landscape.title;
    const on = (element: Element, event: string, listener: EventListener) => element.addEventListener(event, listener, { signal: this.abort.signal });
    on(get('#gust'), 'click', () => actions.gust());
    on(this.pause, 'click', actions.togglePause);
    const setImmersive = (immersive: boolean) => {
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
    on(get('#settings'), 'click', () => { this.dialog.showModal(); actions.dialogChanged('settings'); });
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
    this.pause.textContent = paused ? '继续' : '暂停';
    this.pause.setAttribute('aria-pressed', String(paused));
    this.root.querySelector('#hint')!.textContent = paused ? '已暂停，点继续或起风' : '拖动，看一看四周';
    this.canvas.setAttribute('aria-label', paused
      ? '雨夜风景已暂停。使用继续或起风按钮观看。'
      : '雨夜与篝火。拖动观察四周，也可使用起风按钮。');
  }
  setAudio(enabled: boolean): void {
    this.sound.textContent = enabled ? '静音' : '听雨';
    this.sound.setAttribute('aria-pressed', String(enabled));
  }
  setContextLost(lost: boolean): void {
    this.root.dataset.context = lost ? 'lost' : 'ready';
    if (lost) this.notify('画面暂时中断，正在等待恢复。', 0);
    else this.notify('风景已恢复。');
  }
  fail(message: string): void {
    // A native modal is above every ordinary overlay, including this error.
    if (this.dialog.open) this.dialog.close();
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
