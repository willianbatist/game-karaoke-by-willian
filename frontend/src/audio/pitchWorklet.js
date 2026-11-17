/**
 * AudioWorkletProcessor para análise contínua de pitch e volume RMS do microfone.
 */

import { detectPitchYin } from "./yinDetector.js";

class PitchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.windowSize = 2048;
    this.hopSize = 1024;
    this.buffer = new Float32Array(this.windowSize);
    this.writeIndex = 0;
    this.rmsThreshold = 0.01;
    this.yinThreshold = 0.15;

    this.port.onmessage = (evt) => {
      const msg = evt.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "config") {
        if (typeof msg.rmsThreshold === "number") {
          this.rmsThreshold = msg.rmsThreshold;
        }
        if (typeof msg.yinThreshold === "number") {
          this.yinThreshold = msg.yinThreshold;
        }
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) {
      return true;
    }

    const channelData = input[0];
    for (let i = 0; i < channelData.length; i++) {
      this.buffer[this.writeIndex++] = channelData[i];

      if (this.writeIndex >= this.windowSize) {
        const result = detectPitchYin(this.buffer, sampleRate, {
          rmsThreshold: this.rmsThreshold,
          threshold: this.yinThreshold,
        });

        this.port.postMessage({
          type: "pitch",
          ...result,
          contextTime: currentTime,
        });

        // Desloca metade da janela (overlap de 50% -> ~46 leituras/segundo a 48kHz)
        this.buffer.copyWithin(0, this.hopSize);
        this.writeIndex = this.windowSize - this.hopSize;
      }
    }

    return true;
  }
}

registerProcessor("pitch-processor", PitchProcessor);