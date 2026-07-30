import * as THREE from 'three';
import { SeededRandom } from '../core/SeededRandom';

/**
 * Procedural PBR material library — every texture is generated at runtime on canvas.
 * No external images. Bark/rock/wood/metal get real normal maps so the flashlight
 * raking at grazing angles shows depth.
 */

function makeCanvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')!];
}

function toTex(c: HTMLCanvasElement, repeat = 1, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/** Build a tangent-space normal map from a grayscale height canvas. */
function heightToNormal(src: HTMLCanvasElement, strength = 2.0): HTMLCanvasElement {
  const size = src.width;
  const sctx = src.getContext('2d')!;
  const sd = sctx.getImageData(0, 0, size, size).data;
  const [out, octx] = makeCanvas(size);
  const od = octx.createImageData(size, size);
  const h = (x: number, y: number) => {
    x = (x + size) % size; y = (y + size) % size;
    return sd[(y * size + x) * 4] / 255;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * strength;
      const dy = (h(x, y + 1) - h(x, y - 1)) * strength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const i = (y * size + x) * 4;
      od.data[i] = (-dx * inv * 0.5 + 0.5) * 255;
      od.data[i + 1] = (dy * inv * 0.5 + 0.5) * 255;
      od.data[i + 2] = inv * 255;
      od.data[i + 3] = 255;
    }
  }
  octx.putImageData(od, 0, 0);
  return out;
}

/** Fill canvas with multi-octave value noise (seeded). */
function noiseFill(ctx: CanvasRenderingContext2D, size: number, rng: SeededRandom,
                   base: number, amp: number, octaves: number, scale = 1): void {
  const img = ctx.createImageData(size, size);
  const nRng = rng.fork(777);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // tileable-ish via domain wrap trick: sample on a torus using sin/cos domains
      const u = (x / size) * scale, v = (y / size) * scale;
      let n = 0, a = 1, f = 4, norm = 0;
      for (let o = 0; o < octaves; o++) {
        n += nRng.noise2(u * f + o * 31.7, v * f + o * 17.3) * a;
        norm += a; a *= 0.55; f *= 2.1;
      }
      n /= norm;
      const g = Math.max(0, Math.min(255, (base + n * amp) * 255));
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = g;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

export class MaterialLibrary {
  readonly rng: SeededRandom;

  bark!: THREE.MeshStandardMaterial;
  barkDead!: THREE.MeshStandardMaterial;
  foliage!: THREE.MeshStandardMaterial;
  foliageDead!: THREE.MeshStandardMaterial;
  ground!: THREE.MeshStandardMaterial;
  rock!: THREE.MeshStandardMaterial;
  woodPlank!: THREE.MeshStandardMaterial;
  woodRot!: THREE.MeshStandardMaterial;
  metalRust!: THREE.MeshStandardMaterial;
  metalPaint!: THREE.MeshStandardMaterial;
  glass!: THREE.MeshStandardMaterial;
  tentFabric!: THREE.MeshStandardMaterial;
  paperMat!: THREE.MeshStandardMaterial;
  mudPuddle!: THREE.MeshStandardMaterial;
  palebarkSuit!: THREE.MeshStandardMaterial;
  palebarkSkin!: THREE.MeshStandardMaterial;
  bone!: THREE.MeshStandardMaterial;
  concrete!: THREE.MeshStandardMaterial;
  fabric!: THREE.MeshStandardMaterial;
  knurl!: THREE.MeshStandardMaterial;
  birchBark!: THREE.MeshStandardMaterial;

  private disposables: (THREE.Texture | THREE.Material)[] = [];

  constructor(seed: number) {
    this.rng = new SeededRandom(seed ^ 0x51AB);
    this.build();
  }

  private track<T extends THREE.Texture | THREE.Material>(t: T): T { this.disposables.push(t); return t; }

  private build(): void {
    const S = 512;

    // ---------- BARK ----------
    {
      const [c, ctx] = makeCanvas(S);
      noiseFill(ctx, S, this.rng.fork(1), 0.34, 0.3, 5);
      // vertical fissures
      const d = ctx.getImageData(0, 0, S, S);
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4;
        const crack = Math.abs(Math.sin(x * 0.11 + this.rng.noise2(x * 0.025, 0) * 3));
        const dark = 0.5 + 0.5 * crack;
        // mossy green creep at the base of the texture (v near 0)
        const moss = Math.max(0, this.rng.noise2(x * 0.03 + 60, y * 0.03)) * (1 - y / S) * 0.5;
        d.data[i] *= dark * (1 - moss * 0.4);
        d.data[i + 1] *= dark;
        d.data[i + 2] *= dark * (1 - moss * 0.7);
      }
      ctx.putImageData(d, 0, 0);
      const nrm = this.track(toTex(heightToNormal(c, 3.4), 1, false));
      const alb = this.track(toTex(c));
      const [rc, rctx] = makeCanvas(256);
      noiseFill(rctx, 256, this.rng.fork(11), 0.9, 0.12, 4);
      const rgh = this.track(toTex(rc, 1, false));
      this.bark = this.track(new THREE.MeshStandardMaterial({
        map: alb, normalMap: nrm, normalScale: new THREE.Vector2(1.4, 1.4),
        roughnessMap: rgh, color: 0x7a6752, roughness: 1.0, metalness: 0.0 }));
      this.barkDead = this.track(new THREE.MeshStandardMaterial({
        map: alb, normalMap: nrm, normalScale: new THREE.Vector2(1.6, 1.6),
        roughnessMap: rgh, color: 0x9a9084, roughness: 1.0, metalness: 0.0 }));
    }

    // ---------- BIRCH (pale — Palebark's camouflage) ----------
    {
      const BS = 256;
      const [c, ctx] = makeCanvas(BS);
      noiseFill(ctx, BS, this.rng.fork(14), 0.78, 0.1, 4);
      const d = ctx.getImageData(0, 0, BS, BS);
      for (let y = 0; y < BS; y++) for (let x = 0; x < BS; x++) {
        const i = (y * BS + x) * 4;
        // horizontal lenticel bands
        const band = Math.abs(Math.sin(y * 0.35 + this.rng.noise2(0, y * 0.04) * 4));
        const dark = band > 0.82 ? 0.35 : 0.92 + 0.08 * band;
        // peeling patches
        const peel = Math.max(0, this.rng.noise2(x * 0.05 + 20, y * 0.05));
        const pd = peel > 0.42 ? 0.6 : 1;
        d.data[i] *= dark * pd; d.data[i + 1] *= dark * pd; d.data[i + 2] *= dark * pd * 0.96;
      }
      ctx.putImageData(d, 0, 0);
      this.birchBark = this.track(new THREE.MeshStandardMaterial({
        map: this.track(toTex(c)),
        normalMap: this.track(toTex(heightToNormal(c, 1.4), 1, false)),
        color: 0xd8d4c8, roughness: 0.72, metalness: 0 }));
    }

    // ---------- FOLIAGE (alpha-tested clusters) ----------
    {
      const [c, ctx] = makeCanvas(S);
      ctx.clearRect(0, 0, S, S);
      const fr = this.rng.fork(2);
      // needle/leaf clusters
      for (let i = 0; i < 900; i++) {
        const x = fr.range(0, S), y = fr.range(0, S);
        const r = fr.range(3, 10);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        const shade = fr.range(0.5, 1.1);
        g.addColorStop(0, `rgba(${34 * shade | 0},${52 * shade | 0},${30 * shade | 0},0.95)`);
        g.addColorStop(1, `rgba(${20 * shade | 0},${34 * shade | 0},${20 * shade | 0},0)`);
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
      // needle strokes for fine silhouette detail
      for (let i = 0; i < 2400; i++) {
        const x = fr.range(0, S), y = fr.range(0, S);
        const a = fr.range(0, Math.PI * 2), l = fr.range(2, 7);
        const sh = fr.range(0.4, 1.2);
        ctx.strokeStyle = `rgba(${30 * sh | 0},${48 * sh | 0},${26 * sh | 0},${fr.range(0.25, 0.7)})`;
        ctx.lineWidth = fr.range(0.5, 1.4);
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); ctx.stroke();
      }
      const tex = this.track(toTex(c));
      this.foliage = this.track(new THREE.MeshStandardMaterial({
        map: tex, alphaTest: 0.42, side: THREE.DoubleSide,
        color: 0x93a884, roughness: 0.9, metalness: 0 }));
      this.foliadeadCommon(tex);
    }

    // ---------- GROUND ----------
    {
      const [c, ctx] = makeCanvas(S);
      noiseFill(ctx, S, this.rng.fork(3), 0.32, 0.35, 6);
      // leaf litter flecks
      const gr = this.rng.fork(31);
      for (let i = 0; i < 500; i++) {
        const x = gr.range(0, S), y = gr.range(0, S);
        ctx.fillStyle = `rgba(${gr.int(45, 90)},${gr.int(35, 65)},${gr.int(22, 40)},${gr.range(0.3, 0.8)})`;
        ctx.save(); ctx.translate(x, y); ctx.rotate(gr.range(0, 6.28));
        ctx.fillRect(-gr.range(1, 4), -gr.range(0.5, 1.5), gr.range(2, 7), gr.range(1, 3));
        ctx.restore();
      }
      // twigs & pebbles
      for (let i = 0; i < 160; i++) {
        const x = gr.range(0, S), y = gr.range(0, S);
        const a = gr.range(0, 6.28), l = gr.range(4, 14);
        ctx.strokeStyle = `rgba(${gr.int(40, 70)},${gr.int(30, 52)},${gr.int(18, 34)},${gr.range(0.4, 0.9)})`;
        ctx.lineWidth = gr.range(0.8, 2);
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); ctx.stroke();
      }
      for (let i = 0; i < 220; i++) {
        const x = gr.range(0, S), y = gr.range(0, S);
        ctx.fillStyle = `rgba(${gr.int(95, 140)},${gr.int(92, 132)},${gr.int(85, 120)},${gr.range(0.3, 0.8)})`;
        ctx.beginPath(); ctx.arc(x, y, gr.range(0.6, 2.4), 0, Math.PI * 2); ctx.fill();
      }
      const alb = this.track(toTex(c, 90));
      const nrm = this.track(toTex(heightToNormal(c, 1.8), 90, false));
      const [gc, gctx] = makeCanvas(256);
      noiseFill(gctx, 256, this.rng.fork(33), 0.88, 0.14, 4);
      this.ground = this.track(new THREE.MeshStandardMaterial({
        map: alb, normalMap: nrm, roughnessMap: this.track(toTex(gc, 90, false)),
        color: 0x8a8074, roughness: 1.0, metalness: 0 }));
    }

    // ---------- ROCK ----------
    {
      const [c, ctx] = makeCanvas(S);
      noiseFill(ctx, S, this.rng.fork(4), 0.42, 0.4, 6);
      // strata banding + lichen flecks
      const rd = ctx.getImageData(0, 0, S, S);
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4;
        const band = Math.sin(y * 0.06 + this.rng.noise2(x * 0.02, y * 0.01) * 5) * 0.5 + 0.5;
        const m = 0.82 + band * 0.3;
        const lich = Math.max(0, this.rng.noise2(x * 0.08 + 90, y * 0.08 + 7));
        rd.data[i] *= m * (1 - lich * 0.25); rd.data[i + 1] *= m; rd.data[i + 2] *= m * (1 - lich * 0.45);
      }
      ctx.putImageData(rd, 0, 0);
      const alb = this.track(toTex(c));
      const nrm = this.track(toTex(heightToNormal(c, 3.0), 1, false));
      this.rock = this.track(new THREE.MeshStandardMaterial({
        map: alb, normalMap: nrm, normalScale: new THREE.Vector2(1.35, 1.35),
        color: 0x82848a, roughness: 0.92, metalness: 0.02 }));
    }

    // ---------- WOOD PLANKS ----------
    {
      const [c, ctx] = makeCanvas(S);
      noiseFill(ctx, S, this.rng.fork(5), 0.4, 0.25, 4);
      const d = ctx.getImageData(0, 0, S, S);
      const planks = 6;
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4;
        const plank = Math.floor((y / S) * planks);
        const inSeam = ((y / S) * planks) % 1 < 0.05;
        const grain = Math.sin(x * 0.35 + plank * 13.7 + this.rng.noise2(x * 0.02, plank * 9) * 4) * 0.5 + 0.5;
        let m = 0.75 + grain * 0.35 + (plank % 2) * 0.06;
        if (inSeam) m *= 0.35;
        d.data[i] *= m; d.data[i + 1] *= m; d.data[i + 2] *= m;
      }
      ctx.putImageData(d, 0, 0);
      // water staining streaks running down the planks
      const wd = ctx.getImageData(0, 0, S, S);
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4;
        const stain = Math.max(0, this.rng.noise2(x * 0.07 + 55, y * 0.008));
        if (stain > 0.25) {
          const t = Math.min(0.5, (stain - 0.25) * 1.2);
          wd.data[i] *= (1 - t * 0.5); wd.data[i + 1] *= (1 - t * 0.45); wd.data[i + 2] *= (1 - t * 0.35);
        }
      }
      ctx.putImageData(wd, 0, 0);
      const alb = this.track(toTex(c));
      const nrm = this.track(toTex(heightToNormal(c, 2.2), 1, false));
      this.woodPlank = this.track(new THREE.MeshStandardMaterial({
        map: alb, normalMap: nrm, color: 0x907856, roughness: 0.82, metalness: 0 }));
      this.woodRot = this.track(new THREE.MeshStandardMaterial({
        map: alb, normalMap: nrm, color: 0x635f50, roughness: 0.95, metalness: 0 }));
    }

    // ---------- RUSTED METAL ----------
    {
      const [c, ctx] = makeCanvas(S);
      noiseFill(ctx, S, this.rng.fork(6), 0.45, 0.3, 5);
      const d = ctx.getImageData(0, 0, S, S);
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4;
        const rust = Math.max(0, this.rng.noise2(x * 0.04 + 9, y * 0.04) );
        if (rust > 0.15) {
          const t = Math.min(1, (rust - 0.15) * 2.2);
          d.data[i] = d.data[i] * (1 - t) + 122 * t;
          d.data[i + 1] = d.data[i + 1] * (1 - t) + 62 * t;
          d.data[i + 2] = d.data[i + 2] * (1 - t) + 34 * t;
        }
      }
      ctx.putImageData(d, 0, 0);
      const alb = this.track(toTex(c));
      const nrm = this.track(toTex(heightToNormal(c, 1.8), 1, false));
      this.metalRust = this.track(new THREE.MeshStandardMaterial({
        map: alb, normalMap: nrm, color: 0x9a938c, roughness: 0.7, metalness: 0.65 }));
    }

    // ---------- PAINTED METAL (peeling) ----------
    {
      const [c, ctx] = makeCanvas(S);
      noiseFill(ctx, S, this.rng.fork(7), 0.55, 0.2, 4);
      const d = ctx.getImageData(0, 0, S, S);
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4;
        const peel = this.rng.noise2(x * 0.06 + 40, y * 0.06 + 3);
        if (peel > 0.3) {
          const t = Math.min(1, (peel - 0.3) * 3);
          d.data[i] = d.data[i] * (1 - t) + 90 * t;
          d.data[i + 1] = d.data[i + 1] * (1 - t) + 55 * t;
          d.data[i + 2] = d.data[i + 2] * (1 - t) + 30 * t;
        }
      }
      ctx.putImageData(d, 0, 0);
      const alb = this.track(toTex(c));
      this.metalPaint = this.track(new THREE.MeshStandardMaterial({
        map: alb, color: 0x5e6e63, roughness: 0.55, metalness: 0.5 }));
    }

    // ---------- GLASS ----------
    this.glass = this.track(new THREE.MeshStandardMaterial({
      color: 0x1a2026, roughness: 0.18, metalness: 0.4,
      transparent: true, opacity: 0.55, envMapIntensity: 0.3 }));

    // ---------- TENT FABRIC ----------
    {
      const [c, ctx] = makeCanvas(128);
      noiseFill(ctx, 128, this.rng.fork(8), 0.5, 0.25, 3);
      this.tentFabric = this.track(new THREE.MeshStandardMaterial({
        map: this.track(toTex(c)), color: 0x6d6a4e, roughness: 0.9, metalness: 0, side: THREE.DoubleSide }));
    }

    // ---------- PAPER ----------
    this.paperMat = this.track(new THREE.MeshStandardMaterial({
      color: 0xb8b09a, roughness: 0.95, metalness: 0 }));

    // ---------- MUD / PUDDLE ----------
    this.mudPuddle = this.track(new THREE.MeshStandardMaterial({
      color: 0x2c2620, roughness: 0.12, metalness: 0.25, envMapIntensity: 0.6 }));

    // ---------- CONCRETE ----------
    {
      const [c, ctx] = makeCanvas(S);
      noiseFill(ctx, S, this.rng.fork(9), 0.5, 0.2, 5);
      const alb = this.track(toTex(c));
      const nrm = this.track(toTex(heightToNormal(c, 1.2), 1, false));
      this.concrete = this.track(new THREE.MeshStandardMaterial({
        map: alb, normalMap: nrm, color: 0x83837e, roughness: 0.9, metalness: 0 }));
    }

    // ---------- PALEBARK ----------
    {
      const [c, ctx] = makeCanvas(128);
      noiseFill(ctx, 128, this.rng.fork(10), 0.16, 0.12, 4);
      this.palebarkSuit = this.track(new THREE.MeshStandardMaterial({
        map: this.track(toTex(c)), color: 0x2e3236, roughness: 0.62, metalness: 0.08 }));
      this.palebarkSkin = this.track(new THREE.MeshStandardMaterial({
        color: 0xcfc9bd, roughness: 0.42, metalness: 0.0 }));
    }

    // ---------- BONE ----------
    this.bone = this.track(new THREE.MeshStandardMaterial({
      color: 0xb5ad99, roughness: 0.8, metalness: 0 }));

    // ---------- FABRIC (jacket sleeve — woven) ----------
    {
      const [c, ctx] = makeCanvas(256);
      noiseFill(ctx, 256, this.rng.fork(15), 0.5, 0.18, 4);
      const d = ctx.getImageData(0, 0, 256, 256);
      for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
        const i = (y * 256 + x) * 4;
        const weave = 0.86 + 0.14 * ((x % 4 < 2) !== (y % 4 < 2) ? 1 : 0.6);
        d.data[i] *= weave; d.data[i + 1] *= weave; d.data[i + 2] *= weave;
      }
      ctx.putImageData(d, 0, 0);
      this.fabric = this.track(new THREE.MeshStandardMaterial({
        map: this.track(toTex(c, 3)),
        normalMap: this.track(toTex(heightToNormal(c, 1.2), 3, false)),
        color: 0x333a3d, roughness: 0.92, metalness: 0 }));
    }

    // ---------- KNURLED METAL (flashlight body) ----------
    {
      const [c, ctx] = makeCanvas(128);
      const img = ctx.createImageData(128, 128);
      for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
        const i = (y * 128 + x) * 4;
        const g = (Math.sin(x * 0.8) * Math.sin(y * 0.8) * 0.5 + 0.5) * 200 + 30;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = g; img.data[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      this.knurl = this.track(new THREE.MeshStandardMaterial({
        normalMap: this.track(toTex(heightToNormal(c, 2.2), 4, false)),
        color: 0x42484f, roughness: 0.38, metalness: 0.85 }));
    }
  }

  private foliadeadCommon(tex: THREE.Texture): void {
    this.foliageDead = this.track(new THREE.MeshStandardMaterial({
      map: tex, alphaTest: 0.42, side: THREE.DoubleSide,
      color: 0x8a7a56, roughness: 0.95, metalness: 0 }));
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}
