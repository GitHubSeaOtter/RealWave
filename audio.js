// Continuous stereo surf synthesis. No looping recordings or remote assets.
// All automation uses the same simulation clock as the ocean renderer.
export function surfEnvelope(time, wind = .65) {
  const unit = 2 * Math.PI / 256;
  const speed = .7 + wind * .45;
  const primaryRate = Math.sqrt(9.81 * Math.hypot(4,2) * unit) * speed - .16 * 4 * unit;
  const secondaryRate = Math.sqrt(9.81 * Math.hypot(-8,2) * unit) * speed + .16 * 8 * unit;
  const swell = Math.pow(.5 + .5 * Math.sin(-time * primaryRate), 2);
  const second = Math.pow(.5 + .5 * Math.sin(-time * secondaryRate + 1.618), 3);
  return { swell, wash: .12 + .68 * swell + .20 * second, wind };
}

export class OceanAudio {
  constructor() { this.context = null; this.enabled = false; this.volume = .55; this.voices = []; }
  async start() {
    if (!this.context) this.create();
    await this.context.resume();
    if (this.context.state !== 'running') throw new Error('AudioContext could not start');
    this.enabled = true;
    this.master.gain.setTargetAtTime(this.volume * .42, this.context.currentTime, .6);
  }
  stop() {
    this.enabled = false;
    if (this.context) this.master.gain.setTargetAtTime(0, this.context.currentTime, .18);
  }
  setVolume(value) {
    this.volume = value;
    if (this.context && this.enabled) this.master.gain.setTargetAtTime(value * .42, this.context.currentTime, .1);
  }
  create() {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) throw new Error('Web Audio unavailable');
    const ctx = this.context = new Audio({latencyHint:'playback'});
    this.master = ctx.createGain(); this.master.gain.value = 0;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -16; compressor.knee.value = 18;
    compressor.ratio.value = 3; compressor.attack.value = .01; compressor.release.value = .4;
    this.master.connect(compressor); compressor.connect(ctx.destination);
    // Independent noise at each side prevents mono surf with a moving volume knob.
    for (let i = 0; i < 5; i++) {
      const length = ctx.sampleRate * (13 + i * 2.137);
      const buffer = ctx.createBuffer(1, Math.floor(length), ctx.sampleRate);
      const data = buffer.getChannelData(0);
      let brown = 0;
      for (let j = 0; j < data.length; j++) {
        const white = Math.random() * 2 - 1;
        brown = (brown + .022 * white) / 1.022;
        data[j] = i === 0 ? brown * 4.5 : white * .65 + brown * .35;
      }
      // Crossfade endpoints so a loop never clicks.
      const overlap = 2048;
      for (let j = 0; j < overlap; j++) {
        const blend = j / overlap;
        data[j] = data[j] * blend + data[data.length - overlap + j] * (1 - blend);
      }
      const source = ctx.createBufferSource(); source.buffer = buffer; source.loop = true;
      const low = ctx.createBiquadFilter(); low.type = 'lowpass'; low.Q.value = .6;
      const high = ctx.createBiquadFilter(); high.type = 'highpass'; high.frequency.value = i === 0 ? 25 : 100 + i * 90;
      const gain = ctx.createGain(); gain.gain.value = 0;
      const pan = ctx.createStereoPanner(); pan.pan.value = i === 0 ? 0 : (i % 2 ? -.72 : .72);
      source.connect(high); high.connect(low); low.connect(gain); gain.connect(pan); pan.connect(this.master);
      source.start(0, i * 1.19);
      this.voices.push({low,gain,pan});
    }
  }
  update(time, swell, wind, yaw = 0) {
    if (!this.context || !this.enabled) return;
    const now = this.context.currentTime;
    this.voices.forEach((voice,i) => {
      const env = surfEnvelope(time - i * 1.25, wind);
      const wash = env.wash;
      const gain = i === 0 ? .40 + wash * .35 : i < 3 ? (.12 + wash * .9) * Math.sqrt(swell) : .03 + wind * .10 + wash * .13;
      voice.gain.gain.setTargetAtTime(gain, now, .18);
      voice.low.frequency.setTargetAtTime(i === 0 ? 160 : i < 3 ? 500 + wash * 2600 + wind * 600 : 3500 + wind * 1400, now, .25);
      voice.pan.pan.setTargetAtTime(i === 0 ? 0 : Math.max(-1,Math.min(1,(i % 2 ? -.58 : .58) + Math.sin(time*.15+i)*.18 - yaw*.2)),now,.2);
    });
  }
  async suspend() { if (this.context?.state === 'running') await this.context.suspend(); }
  async resume() { if (this.enabled && this.context?.state === 'suspended') await this.context.resume(); }
}
