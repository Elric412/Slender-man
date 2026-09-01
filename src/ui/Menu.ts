import { Settings, saveSettings } from '../core/Config';
import type { TellMode, TellState } from '../world/ProximityTell';

type ScreenId = 'loading' | 'title' | 'about' | 'settings' | 'pause' | 'end' | 'advisory' | 'none';

const SCREEN_DIVS: Record<Exclude<ScreenId, 'none'>, string> = {
  loading: 'loading-screen', title: 'title-screen', about: 'about-screen',
  settings: 'settings-screen', pause: 'pause-screen', end: 'end-screen',
  advisory: 'advisory-screen',
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
  /** Fired once the player acknowledges the content advisory. */
  onAdvisoryAck: (() => void) | null = null;

  private els = new Map<string, HTMLElement>();
  private tapeTimer = 0;
  /** Last band pushed to the tell element, so we only touch classes on change. */
  private tellBand: TellState['band'] = 'none';
  /** Last needle angle in whole degrees — same reason. */
  private tellDeg = 0;
  /** Last intensity, quantised, for the same write-avoidance. */
  private tellIntensity = -1;

  constructor(settings: Settings) {
    this.settings = settings;
    const ids = ['loading-screen', 'title-screen', 'about-screen', 'settings-screen', 'pause-screen',
      'end-screen', 'hud', 'load-bar', 'load-status', 'tape-counter', 'tape-count', 'interact-prompt',
      'subtitle', 'viewfinder-overlay', 'vf-time', 'rotate-prompt', 'perf-overlay', 'touch-ui',
      'capture-overlay', 'end-title', 'end-detail', 'end-stats',
      'advisory-screen', 'audio-cue',
      'hud-chrome', 'hud-clock', 'hud-batt', 'pickup-flash',
      'proximity-tell', 'pt-needle', 'pt-label',
      'map-overlay', 'map-canvas', 'map-status'];
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
    // Master is mirrored into both the legacy field and the audio bus group, so
    // an old saved profile and a new one converge on the same behaviour.
    bindRange('set-volume', v => { s.volume = v / 100; s.audio.master = v / 100; });
    bindRange('set-vol-ambience', v => { s.audio.ambience = v / 100; });
    bindRange('set-vol-entity', v => { s.audio.entity = v / 100; });
    bindRange('set-vol-foley', v => { s.audio.foley = v / 100; });
    bindRange('set-vol-ui', v => { s.audio.ui = v / 100; });
    // The low-frequency trim is intentionally NOT tied to master (§11): a player
    // who wants a loud game with no sub-bass must be able to have exactly that.
    bindRange('set-lowfreq', v => { s.audio.lowFreq = v / 100; this.mirrorAdvisory(); });
    bindCheck('set-nightmode', v => { s.audio.nightMode = v; });
    bindCheck('set-audiocues', v => { s.audio.audioCues = v; this.mirrorAdvisory(); });

    // The advisory screen hosts duplicates of the two most important controls.
    // They write the same settings object, so either surface works.
    bindRange('adv-lowfreq', v => { s.audio.lowFreq = v / 100; this.mirrorSettingsAudio(); });
    bindCheck('adv-audiocues', v => { s.audio.audioCues = v; this.mirrorSettingsAudio(); });
    click('btn-advisory-ok', () => {
      s.advisoryAck = true;
      this.commit();
      this.onAdvisoryAck?.();
    });
    bindRange('set-filmnoise', v => { s.filmNoise = v / 100; });
    bindRange('set-sens', v => { s.sensitivity = v / 100; });
    bindRange('set-fov', v => { s.fov = v; });
    bindCheck('set-inverty', v => { s.invertY = v; });
    bindCheck('set-subtitles', v => { s.subtitles = v; });
    bindCheck('set-colorblind', v => { s.colorblind = v; document.body.classList.toggle('cb', v); });
    bindCheck('set-gyro', v => { s.gyro = v; });
    document.getElementById('set-proximity')?.addEventListener('change', (e) => {
      s.proximityTell = (e.target as HTMLSelectElement).value as TellMode;
      // Hide the dial the instant the player leaves `explicit`, rather than
      // waiting for the next gameplay frame — the settings screen is often
      // opened while paused, where no frames are being pushed at all.
      if (s.proximityTell !== 'explicit') this.hideProximityTell();
      this.commit();
    });
  }

  /** Collapse the tell element to its resting hidden state. */
  private hideProximityTell(): void {
    const el = this.els.get('proximity-tell');
    if (!el || el.classList.contains('hidden')) return;
    el.classList.add('hidden');
    el.classList.remove('pt-close', 'pt-imminent');
    this.tellBand = 'none';
  }

  private applySettingsToControls(): void {
    const s = this.settings;
    (document.getElementById('set-quality') as HTMLSelectElement).value = s.quality;
    (document.getElementById('set-volume') as HTMLInputElement).value = String(s.audio.master * 100);
    const setRange = (id: string, v: number) => {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) el.value = String(Math.round(v * 100));
    };
    const setCheck = (id: string, v: boolean) => {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) el.checked = v;
    };
    setRange('set-vol-ambience', s.audio.ambience);
    setRange('set-vol-entity', s.audio.entity);
    setRange('set-vol-foley', s.audio.foley);
    setRange('set-vol-ui', s.audio.ui);
    setRange('set-lowfreq', s.audio.lowFreq);
    setCheck('set-nightmode', s.audio.nightMode);
    setCheck('set-audiocues', s.audio.audioCues);
    setRange('adv-lowfreq', s.audio.lowFreq);
    setCheck('adv-audiocues', s.audio.audioCues);
    setRange('set-filmnoise', s.filmNoise);
    (document.getElementById('set-sens') as HTMLInputElement).value = String(s.sensitivity * 100);
    (document.getElementById('set-fov') as HTMLInputElement).value = String(s.fov);
    (document.getElementById('set-inverty') as HTMLInputElement).checked = s.invertY;
    (document.getElementById('set-subtitles') as HTMLInputElement).checked = s.subtitles;
    (document.getElementById('set-colorblind') as HTMLInputElement).checked = s.colorblind;
    (document.getElementById('set-gyro') as HTMLInputElement).checked = s.gyro;
    const pt = document.getElementById('set-proximity') as HTMLSelectElement | null;
    if (pt) pt.value = s.proximityTell;
    document.body.classList.toggle('cb', s.colorblind);
  }

  private commit(): void {
    saveSettings(this.settings);
    this.onSettingsChanged?.(this.settings);
  }

  /** Push the shared audio values from Settings onto the advisory duplicates. */
  private mirrorAdvisory(): void {
    const a = document.getElementById('adv-lowfreq') as HTMLInputElement | null;
    if (a) a.value = String(Math.round(this.settings.audio.lowFreq * 100));
    const c = document.getElementById('adv-audiocues') as HTMLInputElement | null;
    if (c) c.checked = this.settings.audio.audioCues;
  }

  /** And the reverse, when the advisory screen is the one being touched. */
  private mirrorSettingsAudio(): void {
    const a = document.getElementById('set-lowfreq') as HTMLInputElement | null;
    if (a) a.value = String(Math.round(this.settings.audio.lowFreq * 100));
    const c = document.getElementById('set-audiocues') as HTMLInputElement | null;
    if (c) c.checked = this.settings.audio.audioCues;
  }

  /** Has the player seen and acknowledged the content advisory? (§11 gate 9) */
  get advisoryAcknowledged(): boolean { return this.settings.advisoryAck; }

  /**
   * Render the current audio-cue captions. Called every frame with the engine's
   * live list; an empty list hides the element rather than leaving a stale line
   * on screen.
   */
  setAudioCues(texts: readonly string[]): void {
    const el = this.els.get('audio-cue');
    if (!el) return;
    if (!texts.length) {
      if (!el.classList.contains('hidden')) {
        el.classList.add('hidden');
        el.textContent = '';
      }
      return;
    }
    const joined = texts.join(' · ');
    if (el.textContent !== joined) el.textContent = joined;
    el.classList.remove('hidden');
  }

  /**
   * Render the proximity tell. Called every frame in `explicit` mode.
   *
   * Every write here is change-gated. This runs at frame rate on a mobile
   * browser, and unconditionally assigning `style.setProperty` and `textContent`
   * would dirty layout/paint on a HUD element every single frame for no visual
   * difference. The needle angle is quantised to whole degrees and the intensity
   * to 1/32 for the same reason — below that the difference is not perceivable
   * but the style recalc is still real.
   */
  setProximityTell(state: TellState | null): void {
    const el = this.els.get('proximity-tell');
    if (!el) return;
    if (!state || !state.active) { this.hideProximityTell(); return; }

    if (el.classList.contains('hidden')) el.classList.remove('hidden');

    // intensity → CSS custom property (drives opacity + glow)
    const q = Math.round(Math.min(1, Math.max(0, state.intensity)) * 32) / 32;
    if (q !== this.tellIntensity) {
      this.tellIntensity = q;
      el.style.setProperty('--pt', String(q));
    }

    // bearing → needle rotation. The CSS needle points up at 0deg, which is the
    // same convention as bearing 0 = dead ahead, so this is a direct mapping.
    const needle = this.els.get('pt-needle');
    const deg = Math.round(state.bearing * 57.2957795);
    if (needle && deg !== this.tellDeg) {
      this.tellDeg = deg;
      needle.style.setProperty('--pt-bearing', `${deg}deg`);
    }

    if (state.band !== this.tellBand) {
      this.tellBand = state.band;
      el.classList.toggle('pt-close', state.band === 'close');
      el.classList.toggle('pt-imminent', state.band === 'imminent');
      const label = this.els.get('pt-label');
      // Words, not numbers: a numeric readout would turn stalking into a
      // spreadsheet, and these three rungs are all the player can act on.
      if (label) {
        label.textContent =
          state.band === 'imminent' ? 'CLOSE' :
          state.band === 'close' ? 'NEARBY' : 'PRESENT';
      }
    }
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

  /** Persistent in-game camcorder chrome: elapsed time + battery percentage. */
  setHudChrome(timeSec: number, battery01: number): void {
    const hh = Math.floor(timeSec / 3600), mm = Math.floor((timeSec % 3600) / 60), ss = Math.floor(timeSec % 60);
    this.el('hud-clock').textContent =
      `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    this.el('hud-batt').textContent = `${Math.round(battery01 * 100)}%`;
  }

  showTouchUI(on: boolean): void {
    this.el('touch-ui').classList.toggle('hidden', !on);
  }

  // ---------- survey map ----------
  //
  // The Menu owns only visibility and the status line. The sheet itself is drawn
  // by SurveyMap straight onto `map-canvas` from world geometry, so there is no
  // path by which this class could put something on the map that the world does
  // not contain — which is the brief's rule about not hardcoding UI information.

  /** the canvas SurveyMap renders into; null if the element is missing */
  get mapCanvas(): HTMLCanvasElement | null {
    return (this.els.get('map-canvas') as HTMLCanvasElement | undefined) ?? null;
  }

  /** true while the survey sheet is being read */
  get mapVisible(): boolean {
    const el = this.els.get('map-overlay');
    return !!el && !el.classList.contains('hidden');
  }

  setMapVisible(on: boolean): void {
    const el = this.els.get('map-overlay');
    if (!el) return;
    el.classList.toggle('hidden', !on);
    const tb = document.getElementById('tb-map');
    if (tb) tb.classList.toggle('active', on);
  }

  setMapStatus(text: string): void {
    const el = this.els.get('map-status');
    // Guarded because this is pushed every frame while the sheet is open, and a
    // DOM text write that changes nothing still costs layout.
    if (el && el.textContent !== text) el.textContent = text;
  }

  flashTapeCounter(count: number): void {
    this.el('tape-count').textContent = String(count);
    const tc = this.el('tape-counter');
    tc.classList.remove('hidden');
    tc.classList.add('show');
    this.tapeTimer = 3.5;
    // count 0 is the run-start counter init, not a pickup — no blink for that.
    if (count > 0) this.pickupBlink();
  }

  /**
   * Camcorder exposure blink on tape pickup — one short class-toggled CSS
   * animation, so it costs nothing per frame and re-triggers correctly when
   * pickups happen close together (remove -> reflow -> add restarts it).
   */
  private pickupBlink(): void {
    const el = this.el('pickup-flash');
    if (!el) return;
    el.classList.remove('blink');
    void el.offsetWidth; // force reflow so the animation restarts
    el.classList.add('blink');
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
