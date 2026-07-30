import { Settings, saveSettings } from '../core/Config';

type ScreenId = 'loading' | 'title' | 'about' | 'settings' | 'pause' | 'end' | 'none';

const SCREEN_DIVS: Record<Exclude<ScreenId, 'none'>, string> = {
  loading: 'loading-screen', title: 'title-screen', about: 'about-screen',
  settings: 'settings-screen', pause: 'pause-screen', end: 'end-screen',
};

/** DOM menu/HUD controller — screens are styled as part of the game's found-footage world. */
export class Menu {
  private current: ScreenId = 'loading';
  private settingsReturn: ScreenId = 'title';
  settings: Settings;
  onStart: (() => void) | null = null;
  onResume: (() => void) | null = null;
  onQuit: (() => void) | null = null;
  onRestart: (() => void) | null = null;
  onSettingsChanged: ((s: Settings) => void) | null = null;
  onUiClick: (() => void) | null = null;

  private els = new Map<string, HTMLElement>();
  private tapeTimer = 0;

  constructor(settings: Settings) {
    this.settings = settings;
    const ids = ['loading-screen', 'title-screen', 'about-screen', 'settings-screen', 'pause-screen',
      'end-screen', 'hud', 'load-bar', 'load-status', 'tape-counter', 'tape-count', 'interact-prompt',
      'subtitle', 'viewfinder-overlay', 'vf-time', 'rotate-prompt', 'perf-overlay', 'touch-ui',
      'capture-overlay', 'end-title', 'end-detail', 'end-stats'];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) this.els.set(id, el);
    }
    this.bind();
    this.applySettingsToControls();
  }

  private el(id: string): HTMLElement { return this.els.get(id)!; }

  private bind(): void {
    const click = (id: string, fn: () => void) => {
      document.getElementById(id)?.addEventListener('click', () => { this.onUiClick?.(); fn(); });
    };
    click('btn-start', () => this.onStart?.());
    click('btn-settings', () => this.openSettings('title'));
    click('btn-about', () => this.show('about'));
    click('btn-resume', () => this.onResume?.());
    click('btn-pause-settings', () => this.openSettings('pause'));
    click('btn-quit', () => this.onQuit?.());
    click('btn-restart', () => this.onRestart?.());
    click('btn-title', () => this.onQuit?.());
    document.querySelectorAll('[data-back]').forEach(b => {
      b.addEventListener('click', () => {
        this.onUiClick?.();
        this.show(this.settingsReturn === 'pause' ? 'pause' : 'title');
      });
    });

    // settings controls
    const s = this.settings;
    const bindRange = (id: string, fn: (v: number) => void) => {
      document.getElementById(id)?.addEventListener('input', (e) => {
        fn(parseFloat((e.target as HTMLInputElement).value));
        this.commit();
      });
    };
    const bindCheck = (id: string, fn: (v: boolean) => void) => {
      document.getElementById(id)?.addEventListener('change', (e) => {
        fn((e.target as HTMLInputElement).checked);
        this.commit();
      });
    };
    document.getElementById('set-quality')?.addEventListener('change', (e) => {
      s.quality = (e.target as HTMLSelectElement).value as Settings['quality'];
      this.commit();
    });
    bindRange('set-volume', v => { s.volume = v / 100; });
    bindRange('set-sens', v => { s.sensitivity = v / 100; });
    bindRange('set-fov', v => { s.fov = v; });
    bindCheck('set-inverty', v => { s.invertY = v; });
    bindCheck('set-subtitles', v => { s.subtitles = v; });
    bindCheck('set-colorblind', v => { s.colorblind = v; document.body.classList.toggle('cb', v); });
    bindCheck('set-gyro', v => { s.gyro = v; });
  }

  private applySettingsToControls(): void {
    const s = this.settings;
    (document.getElementById('set-quality') as HTMLSelectElement).value = s.quality;
    (document.getElementById('set-volume') as HTMLInputElement).value = String(s.volume * 100);
    (document.getElementById('set-sens') as HTMLInputElement).value = String(s.sensitivity * 100);
    (document.getElementById('set-fov') as HTMLInputElement).value = String(s.fov);
    (document.getElementById('set-inverty') as HTMLInputElement).checked = s.invertY;
    (document.getElementById('set-subtitles') as HTMLInputElement).checked = s.subtitles;
    (document.getElementById('set-colorblind') as HTMLInputElement).checked = s.colorblind;
    (document.getElementById('set-gyro') as HTMLInputElement).checked = s.gyro;
    document.body.classList.toggle('cb', s.colorblind);
  }

  private commit(): void {
    saveSettings(this.settings);
    this.onSettingsChanged?.(this.settings);
  }

  openSettings(from: ScreenId): void {
    this.settingsReturn = from;
    this.show('settings');
  }

  show(id: ScreenId): void {
    for (const key of Object.keys(SCREEN_DIVS) as Exclude<ScreenId, 'none'>[]) {
      this.el(SCREEN_DIVS[key]).classList.toggle('hidden', key !== id);
    }
    this.current = id;
    if (id === 'none') {
      for (const key of Object.keys(SCREEN_DIVS) as Exclude<ScreenId, 'none'>[]) {
        this.el(SCREEN_DIVS[key]).classList.add('hidden');
      }
    }
  }

  get currentScreen(): ScreenId { return this.current; }

  // ---------- loading ----------
  setLoadProgress(frac: number, status: string): void {
    this.el('load-bar').style.width = `${Math.round(frac * 100)}%`;
    this.el('load-status').textContent = status;
  }

  // ---------- HUD ----------
  showHud(on: boolean): void {
    this.el('hud').classList.toggle('hidden', !on);
  }

  showTouchUI(on: boolean): void {
    this.el('touch-ui').classList.toggle('hidden', !on);
  }

  flashTapeCounter(count: number): void {
    this.el('tape-count').textContent = String(count);
    const tc = this.el('tape-counter');
    tc.classList.remove('hidden');
    tc.classList.add('show');
    this.tapeTimer = 3.5;
  }

  setInteractPrompt(visible: boolean, label = 'E — RECOVER TAPE'): void {
    const p = this.el('interact-prompt');
    p.textContent = label;
    p.classList.toggle('hidden', !visible);
  }

  setSubtitle(text: string | null): void {
    const sub = this.el('subtitle');
    if (!text) { sub.classList.add('hidden'); return; }
    sub.textContent = text;
    sub.classList.remove('hidden');
  }

  setViewfinder(on: boolean, secondsBack = 4): void {
    this.el('viewfinder-overlay').classList.toggle('hidden', !on);
    if (on) this.el('vf-time').textContent = `-${Math.floor(secondsBack / 60)}:${String(Math.floor(secondsBack % 60)).padStart(2, '0')}`;
  }

  update(dt: number): void {
    if (this.tapeTimer > 0) {
      this.tapeTimer -= dt;
      if (this.tapeTimer <= 0) this.el('tape-counter').classList.remove('show');
    }
  }

  // ---------- end screens ----------
  showEnd(kind: 'escaped' | 'taken', tapes: number, timeSec: number): void {
    const title = this.el('end-title');
    const detail = this.el('end-detail');
    const stats = this.el('end-stats');
    title.classList.remove('taken', 'escaped');
    const mm = Math.floor(timeSec / 60), ss = Math.floor(timeSec % 60);
    stats.textContent = `TAPES RECOVERED: ${tapes} / 8   ·   TIME: ${mm}:${String(ss).padStart(2, '0')}`;
    if (kind === 'taken') {
      title.textContent = 'SIGNAL LOST';
      title.classList.add('taken');
      detail.textContent = tapes >= 8
        ? 'You had all eight. It didn\'t matter. The tapes were never the way out — they were the way in. Pinebridge has one more data point now.'
        : 'The recording ends here. The forest has your voice now, and it will use it the way it used theirs.';
    } else {
      title.textContent = 'TAPE EJECTED';
      title.classList.add('escaped');
      detail.textContent = tapes >= 8
        ? 'All eight recorders. The whole story. You reach the fire road as the static swallows the treeline behind you — and you do not look back. You never count the trees again.'
        : 'You reach the fire road with empty pockets and a full memory card. Some of the team\'s voices are still out there. The forest is patient. It can wait for you to come back for them.';
    }
    this.show('end');
  }

  /** capture transition overlay */
  async playCaptureTransition(): Promise<void> {
    const ov = this.el('capture-overlay');
    ov.classList.remove('hidden');
    // static burst → white → black
    ov.style.transition = 'none';
    ov.style.background = '#000';
    ov.style.opacity = '0';
    await frame();
    ov.style.transition = 'opacity 0.09s';
    ov.style.background = 'repeating-linear-gradient(0deg, #888 0 2px, #111 2px 4px)';
    ov.style.opacity = '1';
    await wait(160);
    ov.style.background = '#e8e8e8';
    await wait(90);
    ov.style.background = '#000';
    ov.style.transition = 'opacity 0.5s';
    await wait(500);
  }

  hideCaptureOverlay(): void {
    const ov = this.el('capture-overlay');
    ov.style.opacity = '0';
    ov.classList.add('hidden');
  }

  setPerf(text: string | null): void {
    const el = this.el('perf-overlay');
    if (text === null) { el.classList.add('hidden'); return; }
    el.textContent = text;
    el.classList.remove('hidden');
  }

  checkOrientation(): void {
    const portrait = window.innerHeight > window.innerWidth;
    const isMobile = ('ontouchstart' in window) && matchMedia('(pointer: coarse)').matches;
    this.el('rotate-prompt').classList.toggle('hidden', !(portrait && isMobile && this.current === 'none'));
  }
}

function frame(): Promise<void> { return new Promise(r => requestAnimationFrame(() => r())); }
function wait(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
