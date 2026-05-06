// Synthesized sound effects via Web Audio API — no external assets needed.

type AudioCtor = typeof AudioContext;

export class SoundManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private muted = false;

  setMuted(muted: boolean) {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : 1;
  }

  isMuted() {
    return this.muted;
  }

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      const Ctor: AudioCtor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: AudioCtor }).webkitAudioContext;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 1;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  private destination(): AudioNode {
    this.ensureCtx();
    return this.master!;
  }

  paddleHit(intensity = 1) {
    const ctx = this.ensureCtx();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(460, t);
    osc.frequency.exponentialRampToValueAtTime(170, t + 0.06);
    gain.gain.setValueAtTime(0.45 * intensity, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    osc.connect(gain).connect(this.destination());
    osc.start(t);
    osc.stop(t + 0.11);
  }

  tableBounce(intensity = 1) {
    const ctx = this.ensureCtx();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(780, t);
    osc.frequency.exponentialRampToValueAtTime(320, t + 0.04);
    gain.gain.setValueAtTime(0.22 * intensity, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    osc.connect(gain).connect(this.destination());
    osc.start(t);
    osc.stop(t + 0.07);
  }

  netHit() {
    const ctx = this.ensureCtx();
    const t = ctx.currentTime;
    const dur = 0.12;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 260;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.35, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filter).connect(gain).connect(this.destination());
    src.start(t);
  }

  score(forPlayer: boolean) {
    const ctx = this.ensureCtx();
    const notes = forPlayer ? [523.25, 659.25, 783.99] : [392.0, 311.13, 246.94];
    notes.forEach((f, i) => {
      const start = ctx.currentTime + i * 0.11;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.22, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.28);
      osc.connect(gain).connect(this.destination());
      osc.start(start);
      osc.stop(start + 0.32);
    });
  }

  win(forPlayer: boolean) {
    const ctx = this.ensureCtx();
    const notes = forPlayer
      ? [523.25, 659.25, 783.99, 1046.5]
      : [392.0, 329.63, 261.63, 196.0];
    notes.forEach((f, i) => {
      const start = ctx.currentTime + i * 0.16;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.28, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.42);
      osc.connect(gain).connect(this.destination());
      osc.start(start);
      osc.stop(start + 0.45);
    });
  }
}
