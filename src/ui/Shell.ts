import type { QualityPreference } from '../core/types';
import type { PoemDefinition } from '../scenes/types';

export interface ShellActions {
  gust: () => void;
  togglePause: () => void;
  toggleAudio: () => Promise<void>;
  setVolume: (volume: number) => void;
  setSnow: (snow: number) => void;
  setQuality: (quality: QualityPreference) => void;
  reset: () => void;
  share: () => Promise<void>;
  dialogChanged: (dialog: 'poem' | 'settings' | null) => void;
}

export class Shell {
  readonly canvas: HTMLCanvasElement;
  private readonly abort = new AbortController();
  private readonly dialogs: HTMLDialogElement[];
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly sound: HTMLButtonElement;
  private readonly pause: HTMLButtonElement;
  private readonly notice: HTMLElement;
  private readonly loading: HTMLElement;

  constructor(private readonly root: HTMLElement, poem: PoemDefinition, actions: ShellActions) {
    root.innerHTML = `
      <canvas id="landscape" tabindex="0" aria-label="咏雪诗境。拖动观看，轻划起风，也可使用下方起风按钮。"></canvas>
      <div class="vignette" aria-hidden="true"></div>
      <header class="masthead">
        <div class="brand"><h1>云烟集</h1><span lang="en">YUNYANJI</span></div>
        <nav aria-label="诗境工具">
          <button id="sound" aria-pressed="false">声音 <span>关</span></button>
          <button id="read" aria-haspopup="dialog">诗文</button>
          <button id="settings" aria-haspopup="dialog">设置</button>
        </nav>
      </header>
      <aside class="verse" aria-label="诗句"><p id="excerpt"></p><span id="source"></span></aside>
      <footer class="scene-footer">
        <div class="scene-caption"><p><span id="chapter"></span><span class="caption-line"></span><strong id="poem-title"></strong></p><span id="hint">轻划画面，唤一阵风</span></div>
        <div class="scene-actions"><button id="pause" aria-pressed="false">暂停</button><button id="gust" class="gust-button">起风</button></div>
      </footer>
      <div id="loading" role="status"><span>云烟集</span><p>风景正在生成</p></div>
      <p id="notice" class="notice" role="status" aria-live="polite"></p>
      <dialog id="poem-dialog" aria-labelledby="poem-heading">
        <div class="dialog-heading"><span>诗文</span><button data-close aria-label="关闭诗文">关闭</button></div>
        <h2 id="poem-heading"></h2><p id="poem-source" class="muted"></p>
        <p id="poem-text" class="poem-text"></p><p id="poem-note" class="poem-note"></p>
      </dialog>
      <dialog id="settings-dialog" aria-labelledby="settings-heading">
        <div class="dialog-heading"><h2 id="settings-heading">此间</h2><button data-close aria-label="关闭设置">关闭</button></div>
        <label class="setting-row" for="quality"><span>画质</span><select id="quality"><option value="auto">自动</option><option value="high">细腻</option><option value="medium">均衡</option><option value="low">轻盈</option></select></label>
        <label class="setting-row" for="volume"><span>声音</span><input id="volume" type="range" min="0" max="1" step="0.01" value="0.45" aria-label="声音音量" /></label>
        <label class="setting-row" for="snow"><span>雪量</span><input id="snow" type="range" min="0" max="1" step="0.01" value="0.72" aria-label="雪量" /></label>
        <p class="settings-note">开启声音，听风经过庭院。</p>
        <div class="settings-actions"><button id="reset">重看此境</button><button id="share">分享此境</button></div>
        <p class="quiet-line">在诗里的风景中，停留片刻。</p>
      </dialog>`;
    const get = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
    this.canvas = get<HTMLCanvasElement>('#landscape');
    this.sound = get<HTMLButtonElement>('#sound');
    this.pause = get<HTMLButtonElement>('#pause');
    this.notice = get('#notice');
    this.loading = get('#loading');
    this.dialogs = [...root.querySelectorAll<HTMLDialogElement>('dialog')];
    get('#excerpt').textContent = poem.excerpt;
    get('#source').textContent = poem.source;
    get('#poem-source').textContent = poem.source;
    get('#chapter').textContent = poem.subtitle;
    get('#poem-title').textContent = poem.title;
    get('#poem-heading').textContent = poem.title;
    get('#poem-text').textContent = poem.text;
    get('#poem-note').textContent = poem.note;
    const on = (element: Element, event: string, listener: EventListener) => element.addEventListener(event, listener, { signal: this.abort.signal });
    on(get('#gust'), 'click', () => actions.gust());
    on(this.pause, 'click', actions.togglePause);
    on(this.sound, 'click', () => {
      this.sound.disabled = true;
      void actions.toggleAudio().catch(() => this.notify('声音暂时无法开启，请再试一次。')).finally(() => { this.sound.disabled = false; });
    });
    on(get('#volume'), 'input', (event) => actions.setVolume(Number((event.target as HTMLInputElement).value)));
    on(get('#snow'), 'input', (event) => actions.setSnow(Number((event.target as HTMLInputElement).value)));
    on(get('#quality'), 'change', (event) => actions.setQuality((event.target as HTMLSelectElement).value as QualityPreference));
    on(get('#reset'), 'click', () => { actions.reset(); get<HTMLDialogElement>('#settings-dialog').close(); });
    on(get('#share'), 'click', () => { void actions.share().catch(() => this.notify('复制暂不可用，可复制地址栏分享此境。')); });
    on(get('#read'), 'click', () => { get<HTMLDialogElement>('#poem-dialog').showModal(); actions.dialogChanged('poem'); });
    on(get('#settings'), 'click', () => { get<HTMLDialogElement>('#settings-dialog').showModal(); actions.dialogChanged('settings'); });
    for (const dialog of this.dialogs) {
      on(dialog.querySelector('[data-close]')!, 'click', () => dialog.close());
      on(dialog, 'close', () => {
        if (this.notice.parentElement === dialog) this.root.append(this.notice);
        const active = this.dialogs.find((item) => item.open);
        actions.dialogChanged(active ? (active.id === 'poem-dialog' ? 'poem' : 'settings') : null);
      });
      on(dialog, 'click', (event) => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        const e = event as MouseEvent;
        if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) dialog.close();
      });
    }
  }

  ready(): void { this.root.dataset.ready = 'true'; this.loading.hidden = true; }
  setPaused(paused: boolean): void {
    this.pause.textContent = paused ? '继续' : '暂停';
    this.pause.setAttribute('aria-pressed', String(paused));
    this.root.querySelector('#hint')!.textContent = paused ? '已暂停，点继续或起风' : '轻划画面，唤一阵风';
    this.canvas.setAttribute('aria-label', paused
      ? '咏雪诗境已暂停。使用继续或起风按钮观看。'
      : '咏雪诗境。拖动观看，轻划起风，也可使用下方起风按钮。');
  }
  setAudio(enabled: boolean): void { this.sound.querySelector('span')!.textContent = enabled ? '开' : '关'; this.sound.setAttribute('aria-pressed', String(enabled)); }
  setContextLost(lost: boolean): void {
    this.root.dataset.context = lost ? 'lost' : 'ready';
    if (lost) this.notify('画面暂时中断，正在等待恢复。', 0);
    else this.notify('风景已恢复。');
  }
  fail(message: string): void {
    this.root.dataset.ready = 'error';
    this.loading.hidden = false;
    this.loading.querySelector('p')!.textContent = message;
    this.root.querySelectorAll<HTMLButtonElement>('#gust, #pause, #sound, #settings').forEach((button) => { button.disabled = true; });
  }
  notify(text: string, duration = 3200): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    // Native modal dialogs are in the top layer; a larger z-index cannot cover them.
    (this.dialogs.find((dialog) => dialog.open) ?? this.root).append(this.notice);
    this.notice.textContent = text;
    this.notice.classList.add('visible');
    if (duration > 0) this.toastTimer = setTimeout(() => { this.notice.classList.remove('visible'); }, duration);
  }
  dispose(): void { this.abort.abort(); if (this.toastTimer) clearTimeout(this.toastTimer); }
}
