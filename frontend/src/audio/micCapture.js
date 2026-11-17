/**
 * Gerenciador de captação de microfone e análise de pitch via AudioWorklet.
 * Desativa AEC, Noise Suppression e AGC do navegador para preservar a afinação real.
 */

export async function listAudioInputDevices() {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
    return [];
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === "audioinput")
    .map((d, idx) => ({
      deviceId: d.deviceId,
      label: d.label || `Microfone ${idx + 1}`,
      groupId: d.groupId || "",
    }));
}

export function createMicCapture(options = {}) {
  const onPitch = typeof options.onPitch === "function" ? options.onPitch : null;
  const onStateChange = typeof options.onStateChange === "function" ? options.onStateChange : null;

  let audioCtx = null;
  let mediaStream = null;
  let sourceNode = null;
  let inputGainNode = null;
  let workletNode = null;
  let silentSinkNode = null;

  let active = false;
  let activeDeviceId = null;
  let inputGain = Number(options.inputGain ?? 1.0);
  let rmsThreshold = Number(options.rmsThreshold ?? 0.01);

  function notifyState(nextActive) {
    active = nextActive;
    if (onStateChange) {
      onStateChange(active);
    }
  }

  async function start({ deviceId } = {}) {
    await stop();

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("Acesso ao microfone (getUserMedia) não suportado neste navegador.");
    }

    const audioConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    };

    if (deviceId) {
      audioConstraints.deviceId = { exact: deviceId };
    }

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: false,
    });

    const track = mediaStream.getAudioTracks()[0];
    activeDeviceId = track?.getSettings?.().deviceId || deviceId || "default";

    const AudioContextImpl = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContextImpl();
    if (audioCtx.state === "suspended") {
      await audioCtx.resume();
    }

    await audioCtx.audioWorklet.addModule("/src/audio/pitchWorklet.js");

    sourceNode = audioCtx.createMediaStreamSource(mediaStream);
    inputGainNode = audioCtx.createGain();
    inputGainNode.gain.value = inputGain;

    workletNode = new AudioWorkletNode(audioCtx, "pitch-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
    });

    workletNode.port.postMessage({
      type: "config",
      rmsThreshold,
    });

    workletNode.port.onmessage = (evt) => {
      if (evt.data?.type === "pitch" && onPitch) {
        onPitch(evt.data);
      }
    };

    // Saída mutada ligada ao destino para manter o grafo de áudio ativo sem retorno nos alto-falantes
    silentSinkNode = audioCtx.createGain();
    silentSinkNode.gain.value = 0;

    sourceNode.connect(inputGainNode);
    inputGainNode.connect(workletNode);
    workletNode.connect(silentSinkNode);
    silentSinkNode.connect(audioCtx.destination);

    notifyState(true);
    return {
      deviceId: activeDeviceId,
      sampleRate: audioCtx.sampleRate,
    };
  }

  function setInputGain(nextGain) {
    inputGain = Math.max(0.1, Math.min(4.0, Number(nextGain) || 1.0));
    if (inputGainNode && audioCtx) {
      inputGainNode.gain.setTargetAtTime(inputGain, audioCtx.currentTime, 0.015);
    }
  }

  function setRmsThreshold(nextThreshold) {
    rmsThreshold = Math.max(0.001, Math.min(0.2, Number(nextThreshold) || 0.01));
    if (workletNode) {
      workletNode.port.postMessage({
        type: "config",
        rmsThreshold,
      });
    }
  }

  async function stop() {
    if (workletNode) {
      try {
        workletNode.port.onmessage = null;
        workletNode.disconnect();
      } catch {
        // Ignora
      }
      workletNode = null;
    }

    if (inputGainNode) {
      try {
        inputGainNode.disconnect();
      } catch {
        // Ignora
      }
      inputGainNode = null;
    }

    if (sourceNode) {
      try {
        sourceNode.disconnect();
      } catch {
        // Ignora
      }
      sourceNode = null;
    }

    if (silentSinkNode) {
      try {
        silentSinkNode.disconnect();
      } catch {
        // Ignora
      }
      silentSinkNode = null;
    }

    if (mediaStream) {
      for (const track of mediaStream.getTracks()) {
        track.stop();
      }
      mediaStream = null;
    }

    if (audioCtx) {
      try {
        await audioCtx.close();
      } catch {
        // Ignora
      }
      audioCtx = null;
    }

    activeDeviceId = null;
    if (active) {
      notifyState(false);
    }
  }

  function isActive() {
    return active;
  }

  function getActiveDeviceId() {
    return activeDeviceId;
  }

  return {
    start,
    stop,
    setInputGain,
    setRmsThreshold,
    isActive,
    getActiveDeviceId,
  };
}