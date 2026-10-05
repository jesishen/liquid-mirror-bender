/**
 * WaterSound — all sounds are synthesized live with Web Audio (no audio files).
 *  drip()   soft "bloop" each time a still finger sends out a ring
 *  swish(s) filtered-noise swish while dragging (s = finger speed)
 *  splash() noisy splash + a few droplets for a flick
 * `stream` carries the same audio so video recordings include it.
 */

const VOLUME = 0.8;

export class WaterSound {
  readonly ctx: AudioContext;
  readonly stream: MediaStream;
  private master: GainNode;
  private noise: AudioBuffer;
  private swishGain: GainNode;
  private swishFilter: BiquadFilterNode;
  private lastDrip = 0;

  constructor() {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = (this.ctx = new AC());

    this.master = ctx.createGain();
    this.master.gain.value = VOLUME;
    this.master.connect(ctx.destination);
    const rec = ctx.createMediaStreamDestination();
    this.master.connect(rec);
    this.stream = rec.stream;

    // 2s of white noise, reused by swish + splash
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    // swish: looping noise → band-pass → soft low-pass → gain (silent until dragging)
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    this.swishFilter = ctx.createBiquadFilter();
    this.swishFilter.type = "bandpass";
    this.swishFilter.frequency.value = 700;
    this.swishFilter.Q.value = 0.8;
    const soft = ctx.createBiquadFilter();
    soft.type = "lowpass";
    soft.frequency.value = 2200;
    this.swishGain = ctx.createGain();
    this.swishGain.gain.value = 0;
    src.connect(this.swishFilter).connect(soft).connect(this.swishGain).connect(this.master);
    src.start();
  }

  /** Must be called from a tap/click (browsers block audio until then). */
  resume() {
    if (this.ctx.state !== "running") this.ctx.resume().catch(() => {});
  }

  suspend() {
    this.ctx.suspend().catch(() => {});
  }

  setMuted(muted: boolean) {
    this.master.gain.setTargetAtTime(muted ? 0 : VOLUME, this.ctx.currentTime, 0.05);
  }

  private pan(x: number) {
    if (!this.ctx.createStereoPanner) return null;
    const p = this.ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, (x * 2 - 1) * 0.6)); // follows the finger
    return p;
  }

  drip(x: number, force = false) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    if (!force) {
      if (t - this.lastDrip < 0.22 || Math.random() < 0.45) return; // keep it sparse
      this.lastDrip = t;
    }
    const f0 = 450 + Math.random() * 500;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f0 * 2.6, t + 0.07); // the "bloop" rise
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.16, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
    const p = this.pan(x);
    osc.connect(g);
    (p ? g.connect(p) : g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.16);
  }

  /** Call every frame with the fastest dragging finger's speed (0 when none). */
  swish(speed: number) {
    const t = this.ctx.currentTime;
    const amount = Math.max(0, Math.min(1, (speed - 0.15) / 1.6));
    this.swishGain.gain.setTargetAtTime(amount * 0.32, t, amount > 0 ? 0.06 : 0.15);
    this.swishFilter.frequency.setTargetAtTime(450 + amount * 900, t, 0.08);
  }

  splash(x: number) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 0.9;
    bp.frequency.setValueAtTime(2600, t);
    bp.frequency.exponentialRampToValueAtTime(380, t + 0.35);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.42, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
    const p = this.pan(x);
    src.connect(bp).connect(g);
    (p ? g.connect(p) : g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + 0.45);
    // droplets falling back in
    for (let i = 0; i < 3; i++) {
      setTimeout(() => this.drip(x + (Math.random() - 0.5) * 0.1, true), 90 + i * 70 + Math.random() * 60);
    }
  }
}