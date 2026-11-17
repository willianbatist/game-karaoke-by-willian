/**
 * Rolo de Notas (Pitch Roll) em HTML5 Canvas (T2.4).
 * Desenha as barras da melodia de referência e o rastro vocal em tempo real.
 */

import { midiToNoteName } from "../audio/yinDetector.js";

const STATUS_COLORS = {
  perfect: "#2ecc71",
  great: "#00cec9",
  good: "#f1c40f",
  miss: "#ff5e57",
  rest: "rgba(176, 189, 212, 0.55)",
  silent: "rgba(176, 189, 212, 0.35)",
};

/**
 * Converte um instante em segundos para coordenada X no canvas.
 */
export function mapTimeToX(timeSec, currentTimeSec, width, options = {}) {
  const playheadRatio = Number(options.playheadRatio ?? 0.24);
  const windowDurationSec = Number(options.windowDurationSec ?? 5.0);
  const pixelsPerSecond = width / Math.max(0.5, windowDurationSec);
  const playheadX = width * playheadRatio;
  return playheadX + (timeSec - currentTimeSec) * pixelsPerSecond;
}

/**
 * Converte uma nota MIDI contínua para coordenada Y no canvas (notas agudas no topo).
 */
export function mapMidiToY(midi, midiMin, midiMax, height, paddingY = 18) {
  const safeMin = Number(midiMin);
  const safeMax = Math.max(safeMin + 1, Number(midiMax));
  const usableHeight = Math.max(10, height - paddingY * 2);
  const normalized = (midi - safeMin) / (safeMax - safeMin);
  const clamped = Math.max(0, Math.min(1, normalized));
  return height - paddingY - clamped * usableHeight;
}

/**
 * Remove pontos antigos do rastro vocal fora da janela visível à esquerda.
 */
export function prunePitchTrail(trail, minVisibleTimeSec) {
  let dropCount = 0;
  while (dropCount < trail.length && trail[dropCount].time < minVisibleTimeSec) {
    dropCount++;
  }
  if (dropCount > 0) {
    trail.splice(0, dropCount);
  }
  return trail;
}

function drawRoundedBar(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export function createPitchRollCanvas(canvasElement, options = {}) {
  const playheadRatio = Number(options.playheadRatio ?? 0.24);
  const windowDurationSec = Number(options.windowDurationSec ?? 5.0);
  const pastSeconds = windowDurationSec * playheadRatio;
  const futureSeconds = windowDurationSec * (1 - playheadRatio);

  let pitchReference = null;
  let emptyMessage = options.emptyMessage || "";
  let midiMin = 48;
  let midiMax = 72;

  const userTrail = []; // { time, midi, status }
  let latestCursor = null; // { midi, status, updatedAtMs }

  function setPitchReference(ref, fallbackMessage = "") {
    pitchReference = ref || null;
    if (fallbackMessage) {
      emptyMessage = fallbackMessage;
    }
    if (pitchReference) {
      const stats = pitchReference.getStats();
      midiMin = Math.floor(stats.midiMin - 2);
      midiMax = Math.ceil(stats.midiMax + 2);
    }
    clearTrail();
  }

  function clearTrail() {
    userTrail.length = 0;
    latestCursor = null;
  }

  function pushUserPoint({ time, midi, status }) {
    if (!Number.isFinite(time)) return;

    if (Number.isFinite(midi) && midi > 0) {
      // Se houve salto para trás (seek), limpa pontos futuros
      if (userTrail.length > 0 && time < userTrail[userTrail.length - 1].time - 0.2) {
        clearTrail();
      }
      userTrail.push({
        time,
        midi,
        status: status || "rest",
      });
      latestCursor = {
        midi,
        status: status || "rest",
        updatedAtMs: typeof performance !== "undefined" ? performance.now() : Date.now(),
      };
    } else {
      latestCursor = null;
    }
  }

  function syncCanvasResolution() {
    if (!canvasElement) return { width: 0, height: 0, ctx: null };
    const rect = canvasElement.getBoundingClientRect();
    const width = Math.max(200, Math.floor(rect.width || canvasElement.clientWidth || 640));
    const height = Math.max(110, Math.floor(rect.height || canvasElement.clientHeight || 160));
    const dpr = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1;

    const targetW = Math.round(width * dpr);
    const targetH = Math.round(height * dpr);

    if (canvasElement.width !== targetW || canvasElement.height !== targetH) {
      canvasElement.width = targetW;
      canvasElement.height = targetH;
    }

    const ctx = canvasElement.getContext("2d");
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    return { width, height, ctx };
  }

  function render(currentTimeSec = 0) {
    const { width, height, ctx } = syncCanvasResolution();
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);

    // Fundo translúcido do rolo de notas
    ctx.fillStyle = "rgba(10, 14, 22, 0.72)";
    ctx.fillRect(0, 0, width, height);

    const stats = pitchReference ? pitchReference.getStats() : null;
    if (!stats || !stats.hasPitchData) {
      ctx.fillStyle = "rgba(176, 189, 212, 0.85)";
      ctx.font = "600 14px system-ui, -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(emptyMessage || "Sem melodia de referência", width / 2, height / 2);
      return;
    }

    // Grade horizontal de notas (linhas a cada 2 semitons e destaque nas oitavas C)
    const firstNote = Math.ceil(midiMin);
    const lastNote = Math.floor(midiMax);
    for (let note = firstNote; note <= lastNote; note++) {
      const isOctaveC = ((note % 12) + 12) % 12 === 0;
      if (!isOctaveC && note % 2 !== 0) continue;

      const y = mapMidiToY(note, midiMin, midiMax, height);
      ctx.strokeStyle = isOctaveC
        ? "rgba(255, 255, 255, 0.14)"
        : "rgba(255, 255, 255, 0.05)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();

      if (isOctaveC) {
        ctx.fillStyle = "rgba(176, 189, 212, 0.5)";
        ctx.font = "11px ui-monospace, monospace";
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        ctx.fillText(midiToNoteName(note), 8, y - 2);
      }
    }

    const windowStart = currentTimeSec - pastSeconds - 0.25;
    const windowEnd = currentTimeSec + futureSeconds + 0.25;
    prunePitchTrail(userTrail, windowStart);

    // Barras da melodia de referência
    const visibleSegments = pitchReference.getSegmentsInWindow(windowStart, windowEnd);
    const barHeight = Math.max(8, Math.min(14, (height / Math.max(12, midiMax - midiMin)) * 0.85));

    for (const seg of visibleSegments) {
      const x1 = mapTimeToX(seg.startTime, currentTimeSec, width, { playheadRatio, windowDurationSec });
      const x2 = mapTimeToX(seg.endTime, currentTimeSec, width, { playheadRatio, windowDurationSec });
      const barWidth = Math.max(6, x2 - x1);
      const centerY = mapMidiToY(seg.midi, midiMin, midiMax, height);
      const y = centerY - barHeight / 2;

      const isCurrentlyActive =
        currentTimeSec >= seg.startTime - 0.04 && currentTimeSec <= seg.endTime + 0.04;
      const isHittingNow =
        isCurrentlyActive &&
        latestCursor &&
        (latestCursor.status === "perfect" ||
          latestCursor.status === "great" ||
          latestCursor.status === "good");

      drawRoundedBar(ctx, x1, y, barWidth, barHeight, barHeight / 2);

      if (isHittingNow) {
        ctx.fillStyle = "rgba(46, 204, 113, 0.92)";
        ctx.shadowColor = "rgba(46, 204, 113, 0.75)";
        ctx.shadowBlur = 12;
      } else if (isCurrentlyActive) {
        ctx.fillStyle = "rgba(0, 206, 201, 0.9)";
        ctx.shadowColor = "rgba(0, 206, 201, 0.5)";
        ctx.shadowBlur = 8;
      } else {
        ctx.fillStyle = "rgba(108, 92, 231, 0.72)";
        ctx.shadowBlur = 0;
      }

      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.strokeStyle = "rgba(255, 255, 255, 0.28)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Rastro contínuo da voz do cantor
    if (userTrail.length > 1) {
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      for (let i = 1; i < userTrail.length; i++) {
        const prev = userTrail[i - 1];
        const curr = userTrail[i];
        if (curr.time - prev.time > 0.16) continue;

        const x1 = mapTimeToX(prev.time, currentTimeSec, width, { playheadRatio, windowDurationSec });
        const y1 = mapMidiToY(prev.midi, midiMin, midiMax, height);
        const x2 = mapTimeToX(curr.time, currentTimeSec, width, { playheadRatio, windowDurationSec });
        const y2 = mapMidiToY(curr.midi, midiMin, midiMax, height);

        ctx.strokeStyle = STATUS_COLORS[curr.status] || STATUS_COLORS.rest;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
    }

    // Linha vertical de leitura (playhead)
    const playheadX = width * playheadRatio;
    ctx.strokeStyle = "rgba(0, 206, 201, 0.85)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, height);
    ctx.stroke();

    // Cursor da nota atual cantada no playhead
    const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (latestCursor && nowMs - latestCursor.updatedAtMs < 220) {
      const cursorY = mapMidiToY(latestCursor.midi, midiMin, midiMax, height);
      const color = STATUS_COLORS[latestCursor.status] || STATUS_COLORS.rest;

      ctx.beginPath();
      ctx.arc(playheadX, cursorY, 7, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.lineWidth = 2;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
    }
  }

  return {
    setPitchReference,
    clearTrail,
    pushUserPoint,
    render,
  };
}