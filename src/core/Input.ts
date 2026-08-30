/**
 * Unified input abstraction: keyboard+mouse (Pointer Lock), touch (virtual stick + drag look),
 * and Gamepad API. One interface consumed by Player.
 */
export interface InputFrame {
  moveX: number;   // strafe [-1,1]
  moveZ: number;   // forward [-1,1]
  lookDX: number;  // accumulated this frame (radians pre-sensitivity)
  lookDY: number;
  sprint: boolean;
  crouch: boolean;
  vaultQueued: boolean;
  interactQueued: boolean;
  flashQueued: boolean;
  vfHeld: boolean;       // camcorder viewfinder held
  lean: number;          // -1 left, 0, 1 right
  pauseQueued: boolean;
  mapQueued: boolean;    // toggle the survey map
}

export class Input {
  frame: InputFrame = this.freshFrame();
  sensitivity = 1.0;
  invertY = false;
  gyroEnabled = false;
  isTouch = false;
  onFirstGesture: (() => void) | null = null;
  private firstGestureFired = false;

  private keys = new Set<string>();
  private lookAccX = 0; private lookAccY = 0;
  private queued = { vault: false, interact: false, flash: false, pause: false, map: false };
  private canvas: HTMLElement;
  private pointerLocked = false;
  wantPointerLock = false;

  // touch state
  private stickId = -1; private stickOrigin = { x: 0, y: 0 };
  private stickVec = { x: 0, y: 0 };
  private lookId = -1; private lookLast = { x: 0, y: 0 };
  private tb = { sprint: false, crouch: false, vf: false };
  private gyroBase: { alpha: number; beta: number } | null = null;

  // gamepad
  private padIndex = -1;
  private padButtonsPrev: boolean[] = [];

  constructor(canvas: HTMLElement) {
    this.canvas = canvas;
    this.isTouch = ('ontouchstart' in window) && matchMedia('(pointer: coarse)').matches;
    this.bindKeyboard();
    this.bindMouse();
    if (this.isTouch) this.bindTouch();
    this.bindGamepad();
    this.bindGyro();
  }

  private freshFrame(): InputFrame {
    return { moveX: 0, moveZ: 0, lookDX: 0, lookDY: 0, sprint: false, crouch: false,
      vaultQueued: false, interactQueued: false, flashQueued: false, vfHeld: false,
      lean: 0, pauseQueued: false, mapQueued: false };
  }

  private gesture(): void {
    if (!this.firstGestureFired) { this.firstGestureFired = true; this.onFirstGesture?.(); }
  }

  // ---------------- keyboard ----------------
  private bindKeyboard(): void {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.gesture();
      this.keys.add(e.code);
      switch (e.code) {
        case 'Space': this.queued.vault = true; e.preventDefault(); break;
        // guard: Shift+E is not interact — Shift is the sprint/lean modifier,
        // so a sprinting player tapping near a tape must still get exactly one action
        case 'KeyE': if (!e.shiftKey) this.queued.interact = true; break;
        case 'KeyF': this.queued.flash = true; break;
        // The survey map. `M` is the convention, and it must not collide with
        // the sprint/lean Shift modifier the way `E` does.
        case 'KeyM': this.queued.map = true; break;
        case 'Escape': this.queued.pause = true; break;
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  // ---------------- mouse ----------------
  private bindMouse(): void {
    this.canvas.addEventListener('mousedown', () => this.gesture());
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
      if (!this.pointerLocked && this.wantPointerLock) this.queued.pause = true;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked) return;
      this.lookAccX += e.movementX * 0.0021;
      this.lookAccY += e.movementY * 0.0021;
    });
  }

  requestPointerLock(): void {
    if (this.isTouch || this.pointerLocked) return;
    this.wantPointerLock = true;
    this.canvas.requestPointerLock?.();
  }

  releasePointerLock(): void {
    this.wantPointerLock = false;
    if (this.pointerLocked) document.exitPointerLock?.();
  }

  // ---------------- touch ----------------
  private bindTouch(): void {
    const stickZone = document.getElementById('stick-zone')!;
    const base = document.getElementById('stick-base')!;
    const nub = document.getElementById('stick-nub')!;

    stickZone.addEventListener('touchstart', (e) => {
      this.gesture();
      const t = e.changedTouches[0];
      this.stickId = t.identifier;
      const r = base.getBoundingClientRect();
      this.stickOrigin.x = r.left + r.width / 2;
      this.stickOrigin.y = r.top + r.height / 2;
      e.preventDefault();
    }, { passive: false });

    const stickMove = (e: TouchEvent) => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        if (t.identifier !== this.stickId) continue;
        const dx = t.clientX - this.stickOrigin.x, dy = t.clientY - this.stickOrigin.y;
        const max = 52, len = Math.hypot(dx, dy) || 1;
        const cl = Math.min(len, max);
        this.stickVec.x = (dx / len) * (cl / max);
        this.stickVec.y = (dy / len) * (cl / max);
        nub.style.transform = `translate(calc(-50% + ${this.stickVec.x * max}px), calc(-50% + ${this.stickVec.y * max}px))`;
        e.preventDefault();
      }
    };
    stickZone.addEventListener('touchmove', stickMove, { passive: false });
    const stickEnd = (e: TouchEvent) => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier !== this.stickId) continue;
        this.stickId = -1; this.stickVec.x = 0; this.stickVec.y = 0;
        nub.style.transform = 'translate(-50%,-50%)';
      }
    };
    stickZone.addEventListener('touchend', stickEnd);
    stickZone.addEventListener('touchcancel', stickEnd);

    // right-half drag look
    this.canvas.addEventListener('touchstart', (e) => {
      this.gesture();
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        if (t.clientX > window.innerWidth * 0.45 && this.lookId === -1) {
          this.lookId = t.identifier;
          this.lookLast.x = t.clientX; this.lookLast.y = t.clientY;
        }
      }
    }, { passive: true });
    this.canvas.addEventListener('touchmove', (e) => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        if (t.identifier !== this.lookId) continue;
        this.lookAccX += (t.clientX - this.lookLast.x) * 0.0052;
        this.lookAccY += (t.clientY - this.lookLast.y) * 0.0052;
        this.lookLast.x = t.clientX; this.lookLast.y = t.clientY;
      }
    }, { passive: true });
    const lookEnd = (e: TouchEvent) => {
      for (let i = 0; i < e.changedTouches.length; i++)
        if (e.changedTouches[i].identifier === this.lookId) this.lookId = -1;
    };
    this.canvas.addEventListener('touchend', lookEnd);
    this.canvas.addEventListener('touchcancel', lookEnd);

    // buttons
    const btn = (id: string, down: () => void, up?: () => void) => {
      const el = document.getElementById(id)!;
      el.addEventListener('touchstart', (e) => { e.preventDefault(); this.gesture(); down(); el.classList.add('active'); }, { passive: false });
      if (up) {
        el.addEventListener('touchend', () => { up(); el.classList.remove('active'); });
        el.addEventListener('touchcancel', () => { up(); el.classList.remove('active'); });
      }
    };
    btn('tb-flash', () => { this.queued.flash = true; });
    btn('tb-interact', () => { this.queued.interact = true; this.queued.vault = true; });
    btn('tb-crouch', () => { this.tb.crouch = !this.tb.crouch; document.getElementById('tb-crouch')!.classList.toggle('active', this.tb.crouch); });
    btn('tb-sprint', () => { this.tb.sprint = true; }, () => { this.tb.sprint = false; });
    btn('tb-vf', () => { this.tb.vf = true; }, () => { this.tb.vf = false; });
    // A toggle, so no `up` handler — the `active` class is owned by
    // Menu.setMapVisible, which knows whether the sheet actually opened.
    btn('tb-map', () => { this.queued.map = true; });
    btn('tb-pause', () => { this.queued.pause = true; });
  }

  // ---------------- gamepad ----------------
  private bindGamepad(): void {
    window.addEventListener('gamepadconnected', (e) => { this.padIndex = e.gamepad.index; this.gesture(); });
    window.addEventListener('gamepaddisconnected', () => { this.padIndex = -1; });
  }

  private pollPad(f: InputFrame): void {
    if (this.padIndex < 0) return;
    const p = navigator.getGamepads?.()[this.padIndex];
    if (!p) return;
    const dz = (v: number) => Math.abs(v) < 0.18 ? 0 : v;
    f.moveX += dz(p.axes[0] ?? 0);
    f.moveZ -= dz(p.axes[1] ?? 0);
    f.lookDX += dz(p.axes[2] ?? 0) * 0.045;
    f.lookDY += dz(p.axes[3] ?? 0) * 0.035;
    const b = (i: number) => !!p.buttons[i]?.pressed;
    if (b(0) && !this.padButtonsPrev[0]) { f.interactQueued = true; f.vaultQueued = true; }
    if (b(2) && !this.padButtonsPrev[2]) f.flashQueued = true;
    if (b(9) && !this.padButtonsPrev[9]) f.pauseQueued = true;
    if (b(8) && !this.padButtonsPrev[8]) f.mapQueued = true;   // Select/Back
    f.sprint = f.sprint || b(10) || b(5);
    f.crouch = f.crouch || b(1);
    f.vfHeld = f.vfHeld || b(6);
    if (b(4)) f.lean = -1; else if (b(5) && !f.sprint) f.lean = 1;
    for (let i = 0; i < p.buttons.length; i++) this.padButtonsPrev[i] = b(i);
  }

  // ---------------- gyro ----------------
  private bindGyro(): void {
    window.addEventListener('deviceorientation', (e) => {
      if (!this.gyroEnabled || !this.isTouch || e.alpha == null || e.beta == null) return;
      if (!this.gyroBase) { this.gyroBase = { alpha: e.alpha, beta: e.beta }; return; }
      // handled as subtle assist — deltas only
    });
  }

  /** consume per-frame input */
  poll(): InputFrame {
    const f = this.freshFrame();
    // keyboard
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) f.moveZ += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) f.moveZ -= 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) f.moveX -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) f.moveX += 1;
    f.sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    f.crouch = this.keys.has('ControlLeft') || this.keys.has('KeyC');
    // lean: Q left / E right (hold). E doubles as interact-on-tap, so leaning
    // requires the key to be HELD past the tap window — one press, one action.
    if (this.keys.has('KeyQ')) f.lean = -1;
    else if (this.keys.has('KeyR')) f.lean = 1; // alt binding for Azerty/left-hand users
    f.vfHeld = this.keys.has('Tab') || this.keys.has('KeyV');

    // touch
    if (this.isTouch) {
      f.moveX += this.stickVec.x;
      f.moveZ -= this.stickVec.y;
      f.sprint = f.sprint || this.tb.sprint;
      f.crouch = f.crouch || this.tb.crouch;
      f.vfHeld = f.vfHeld || this.tb.vf;
    }

    // look
    f.lookDX = this.lookAccX * this.sensitivity;
    f.lookDY = this.lookAccY * this.sensitivity * (this.invertY ? -1 : 1);
    this.lookAccX = 0; this.lookAccY = 0;

    // queued
    f.vaultQueued = this.queued.vault; this.queued.vault = false;
    f.interactQueued = this.queued.interact; this.queued.interact = false;
    f.flashQueued = this.queued.flash; this.queued.flash = false;
    f.pauseQueued = this.queued.pause; this.queued.pause = false;
    f.mapQueued = this.queued.map; this.queued.map = false;

    this.pollPad(f);

    // clamp
    const mLen = Math.hypot(f.moveX, f.moveZ);
    if (mLen > 1) { f.moveX /= mLen; f.moveZ /= mLen; }
    return f;
  }
}
