export class SoundManager {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  isMuted: boolean = false;
  private ambientOscillators: OscillatorNode[] = [];
  private ambientRunning = false;
  private musicElement: HTMLAudioElement | null = null;
  private readonly MUSIC_VOLUME = 0.1;

  init(): void {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.6;
    this.masterGain.connect(this.ctx.destination);
  }

  private get ac(): AudioContext {
    if (!this.ctx) this.init();
    return this.ctx!;
  }

  private get mg(): GainNode {
    if (!this.masterGain) this.init();
    return this.masterGain!;
  }

  toggleMute(): void {
    this.isMuted = !this.isMuted;
    if (this.masterGain) {
      this.masterGain.gain.value = this.isMuted ? 0 : 0.6;
    }
    if (this.musicElement) {
      this.musicElement.volume = this.isMuted ? 0 : this.MUSIC_VOLUME;
    }
  }

  setMasterVolume(v: number): void {
    if (this.masterGain) {
      this.masterGain.gain.value = this.isMuted ? 0 : Math.max(0, Math.min(1, v));
    }
  }

  playTileCrumble(): void {
    const ac = this.ac;
    const now = ac.currentTime;
    const bufSize = ac.sampleRate * 0.15;
    const buf = ac.createBuffer(1, bufSize, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufSize);
    const src = ac.createBufferSource();
    src.buffer = buf;
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 200;
    bp.Q.value = 2;
    const gain = ac.createGain();
    gain.gain.setValueAtTime(0.5, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
    src.connect(bp);
    bp.connect(gain);
    gain.connect(this.mg);
    src.start(now);
    const osc = ac.createOscillator();
    osc.frequency.setValueAtTime(120, now);
    osc.frequency.exponentialRampToValueAtTime(50, now + 0.2);
    const og = ac.createGain();
    og.gain.setValueAtTime(0.3, now);
    og.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
    osc.connect(og);
    og.connect(this.mg);
    osc.start(now);
    osc.stop(now + 0.2);
  }

  playTileFall(): void {
    const ac = this.ac;
    const now = ac.currentTime;
    const osc = ac.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(400, now);
    osc.frequency.exponentialRampToValueAtTime(40, now + 0.4);
    const gain = ac.createGain();
    gain.gain.setValueAtTime(0.4, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
    const filter = ac.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1000, now);
    filter.frequency.exponentialRampToValueAtTime(100, now + 0.4);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.mg);
    osc.start(now);
    osc.stop(now + 0.4);
  }

  playDash(): void {
    const ac = this.ac;
    const now = ac.currentTime;
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(300, now);
    osc.frequency.exponentialRampToValueAtTime(1800, now + 0.15);
    const gain = ac.createGain();
    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
    osc.connect(gain);
    gain.connect(this.mg);
    osc.start(now);
    osc.stop(now + 0.2);
  }

  playExplosion(): void {
    const ac = this.ac;
    const now = ac.currentTime;
    const bufSize = ac.sampleRate * 0.8;
    const buf = ac.createBuffer(1, bufSize, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) {
      const env = Math.pow(1 - i / bufSize, 2);
      data[i] = (Math.random() * 2 - 1) * env;
    }
    const src = ac.createBufferSource();
    src.buffer = buf;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 200;
    const gain = ac.createGain();
    gain.gain.setValueAtTime(1.0, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.8);
    src.connect(lp);
    lp.connect(gain);
    gain.connect(this.mg);
    src.start(now);
    const osc = ac.createOscillator();
    osc.frequency.setValueAtTime(80, now);
    osc.frequency.exponentialRampToValueAtTime(20, now + 0.4);
    const og = ac.createGain();
    og.gain.setValueAtTime(0.8, now);
    og.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
    osc.connect(og);
    og.connect(this.mg);
    osc.start(now);
    osc.stop(now + 0.4);
  }

  playVictory(): void {
    const ac = this.ac;
    const freqs = [523.25, 659.25, 783.99];
    freqs.forEach((freq, i) => {
      const start = ac.currentTime + i * 0.15;
      const osc = ac.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const gain = ac.createGain();
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.4, start + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.5);
      osc.connect(gain);
      gain.connect(this.mg);
      osc.start(start);
      osc.stop(start + 0.5);
    });
  }

  playCountdown(num: number): void {
    const freqs: Record<number, number> = { 3: 440, 2: 550, 1: 660 };
    const freq = freqs[num] ?? 440;
    const ac = this.ac;
    const now = ac.currentTime;
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const gain = ac.createGain();
    gain.gain.setValueAtTime(0.5, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    osc.connect(gain);
    gain.connect(this.mg);
    osc.start(now);
    osc.stop(now + 0.3);
  }

  playCountdownGo(): void {
    const ac = this.ac;
    const freqs = [523.25, 659.25, 783.99];
    const now = ac.currentTime;
    freqs.forEach(freq => {
      const osc = ac.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const gain = ac.createGain();
      gain.gain.setValueAtTime(0.3, now);
      gain.gain.linearRampToValueAtTime(0.4, now + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
      osc.connect(gain);
      gain.connect(this.mg);
      osc.start(now);
      osc.stop(now + 0.6);
    });
  }

  startAmbient(): void {
    if (this.ambientRunning) return;
    this.ambientRunning = true;
    const ac = this.ac;
    const now = ac.currentTime;
    const freqs = [55, 55.5];
    freqs.forEach(freq => {
      const osc = ac.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const gain = ac.createGain();
      gain.gain.value = 0.08;
      const lfo = ac.createOscillator();
      lfo.frequency.value = 0.5;
      const lfoGain = ac.createGain();
      lfoGain.gain.value = 0.03;
      lfo.connect(lfoGain);
      lfoGain.connect(gain.gain);
      osc.connect(gain);
      gain.connect(this.mg);
      osc.start(now);
      lfo.start(now);
      this.ambientOscillators.push(osc, lfo);
    });
  }

  stopAmbient(): void {
    this.ambientRunning = false;
    for (const osc of this.ambientOscillators) {
      try { osc.stop(); } catch (e) {
        // OscillatorNode.stop() throws if the node was never started or already stopped
        if (!(e instanceof DOMException)) console.warn('Unexpected error stopping oscillator', e);
      }
    }
    this.ambientOscillators = [];
  }

  playCollision(): void {
    const ac = this.ac;
    const now = ac.currentTime;
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(200, now);
    osc.frequency.exponentialRampToValueAtTime(60, now + 0.1);
    const gain = ac.createGain();
    gain.gain.setValueAtTime(0.4, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
    osc.connect(gain);
    gain.connect(this.mg);
    osc.start(now);
    osc.stop(now + 0.15);
  }

  startMusic(url: string): void {
    if (this.musicElement) return;
    const audio = new Audio(url);
    audio.loop = true;
    audio.volume = this.isMuted ? 0 : this.MUSIC_VOLUME;
    this.musicElement = audio;
    audio.play().catch((err) => {
      // Autoplay blocked; music will stay silent until user interaction unlocks audio
      console.warn('Music autoplay blocked:', err);
    });
  }

  stopMusic(): void {
    if (!this.musicElement) return;
    this.musicElement.pause();
    this.musicElement = null;
  }
}
