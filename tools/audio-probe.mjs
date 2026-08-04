// Web Audio capability probe for the headless test environment.
// Verifies: context autostart, analyser readback (needed for level metering in
// tests), and AudioWorklet availability (secure-context only → must be served
// from http://localhost, not about:blank).
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';

const server = createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><title>probe</title><body></body>');
}).listen(4199);

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const page = await browser.newPage();
await page.goto('http://localhost:4199/');
const out = await page.evaluate(async () => {
  const ctx = new AudioContext();
  const st0 = ctx.state;
  await ctx.resume().catch(() => {});
  const osc = ctx.createOscillator(); osc.frequency.value = 220;
  const g = ctx.createGain(); g.gain.value = 0.5;
  const an = ctx.createAnalyser(); an.fftSize = 2048;
  osc.connect(g).connect(an); an.connect(ctx.destination);
  osc.start();
  let workletOk = 'no';
  try {
    const src = `class P extends AudioWorkletProcessor{process(i,o){const c=o[0][0];for(let k=0;k<c.length;k++)c[k]=0;return true}}registerProcessor('p',P)`;
    const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    new AudioWorkletNode(ctx, 'p').connect(ctx.destination);
    workletOk = 'yes';
  } catch (e) { workletOk = 'ERR ' + e.message; }
  await new Promise(r => setTimeout(r, 400));
  const buf = new Float32Array(an.fftSize);
  an.getFloatTimeDomainData(buf);
  let peak = 0, sum = 0;
  for (const v of buf) { peak = Math.max(peak, Math.abs(v)); sum += v * v; }
  return {
    st0, state: ctx.state, sampleRate: ctx.sampleRate,
    peak: +peak.toFixed(4), rms: +Math.sqrt(sum / buf.length).toFixed(4),
    workletOk, hasPanner: typeof ctx.createPanner === 'function',
    hasConvolver: typeof ctx.createConvolver === 'function',
    hasIIR: typeof ctx.createIIRFilter === 'function',
    hasWaveShaper: typeof ctx.createWaveShaper === 'function',
    hasStereoPanner: typeof ctx.createStereoPanner === 'function',
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
server.close();
