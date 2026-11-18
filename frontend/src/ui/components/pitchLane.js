/**
 * Componente visual da Pista de Afinação (T3.2).
 * Renderiza o gabarito vocal (`pitch_map.json`) e o cursor da voz do usuário em <canvas>
 * sincronizado com o relógio mestre (`AudioEngine`), aplicando dobramento visual de oitava
 * e feedback acessível por forma, brilho e pulso além da cor.
 *
 * Referências:
 * - docs/FRONTEND_ARCHITECTURE.md (§7.1, §7.2, §11.1, §11.2)
 * - docs/tasks/FASE_3_PONTUACAO_RESULTADO.md (T3.2)
 */

/**
 * Calcula a diferença circular com sinal no intervalo [-6, +6] semitons.
 */
export function signedCircularDiff(userMidi, targetMidi) {
  const raw = (((userMidi - targetMidi) % 12) + 12) % 12;
  return raw > 6 ? raw - 12 : raw;
}

/**
 * Projeta a nota MIDI cantada pelo usuário para a mesma oitava da nota-alvo
 * (dobramento visual de oitava — FRONTEND_ARCHITECTURE.md §7.2).
 */
export function foldMidiToReference(userMidi, targetMidi) {
  if (!Number.isFinite(userMidi) || !Number.isFinite(targetMidi)) {
    return null;
  }
  return targetMidi + signedCircularDiff(userMidi, targetMidi);
}

/**
 * Cria e monta a pista de afinação dentro de `container`.
 */
export function createPitchLane(container, options = {}) {
  if (!container) {
    throw new Error("Container inválido para createPitchLane");
  }

  const getCurrentTime =
    typeof options.getCurrentTime === "function" ? options.getCurrentTime : () => 0;

  let pitchMap = options.pitchMap || null;
  let pitchConfThreshold = Number(options.pitchConfThreshold ?? 0.6);
  let latencyOffsetMs = Number(options.latencyOffsetMs ?? 0);

  // Janela deslizante: 2s passados + 4s futuros (FASE_3 T3.2)
  const pastWindowSec = Number(options.pastWindowSec ?? 2.0);
  const futureWindowSec = Number(options.futureWindowSec ?? 4.0);
  const totalWindowSec = pastWindowSec + futureWindowSec;

  // Cria o elemento <canvas> sem uso de innerHTML
  const canvas = document.createElement("canvas");
  canvas.className = "pitch-lane-canvas";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Pista de afinação vocal em tempo real");
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.display = "block";
  container.appendChild(canvas);

  const ctx = canvas.getContext("2d");

  // Dimensões lógicas em cache (evita layout thrashing dentro do requestAnimationFrame)
  let logicalWidth = 640;
  let logicalHeight = 160;

  function updateCanvasResolution(width, height) {
    const safeW = Math.max(120, Math.floor(width || container.clientWidth || 640));
    const safeH = Math.max(80, Math.floor(height || container.clientHeight || 160));
    const dpr = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1;

    logicalWidth = safeW;
    logicalHeight = safeH;
    canvas.width = Math.floor(safeW * dpr);
    canvas.height = Math.floor(safeH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  updateCanvasResolution(container.clientWidth, container.clientHeight);

  let resizeObserver = null;
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        updateCanvasResolution(entry.contentRect.width, entry.contentRect.height);
      }
    });
    resizeObserver.observe(container);
  }

  // Estado atual do usuário e rastro recente do cursor dobrado
  let currentUserMidi = null;
  let currentHit = null; // 'perfect' | 'good' | 'miss' | null
  const trail = []; // [{ timeSec, foldedMidi, hit }]
  const maxTrailSec = 1.4;

  // Faixa vertical suavizada para evitar saltos bruscos de câmera
  let smoothedMinMidi = 54;
  let smoothedMaxMidi = 74;

  let rafId = null;

  function isValidReferenceFrame(idx) {
    if (!pitchMap || !Array.isArray(pitchMap.midi) || !Array.isArray(pitchMap.conf)) {
      return false;
    }
    if (idx < 0 || idx >= pitchMap.midi.length) return false;
    const m = pitchMap.midi[idx];
    const c = Number(pitchMap.conf[idx] ?? 0);
    return m !== null && m !== undefined && Number.isFinite(m) && c >= pitchConfThreshold;
  }

  function timeToIndex(timeSec) {
    if (!pitchMap) return -1;
    const t0 = Number(pitchMap.t0 ?? 0);
    const hop = Number(pitchMap.hop) > 0 ? Number(pitchMap.hop) : 0.02;
    return Math.round((timeSec - t0) / hop);
  }

  /**
   * Resolve a nota-alvo usada para dobrar a oitava do cursor:
   * 1) Nota-alvo no instante efetivo atual, se houver;
   * 2) Caso contrário, a última nota-alvo válida dentro da janela passada visível;
   * 3) Se não houver nenhuma, retorna null (cursor não é desenhado).
   */
  function resolveAnchorReferenceMidi(effectiveTimeSec) {
    if (!pitchMap || pitchMap.mode === "heuristic") {
      return null;
    }
    const currentIdx = timeToIndex(effectiveTimeSec);
    if (isValidReferenceFrame(currentIdx)) {
      return pitchMap.midi[currentIdx];
    }

    const minPastIdx = Math.max(0, timeToIndex(effectiveTimeSec - pastWindowSec));
    const startIdx = Math.min(currentIdx - 1, (pitchMap.midi?.length || 0) - 1);
    for (let i = startIdx; i >= minPastIdx; i--) {
      if (isValidReferenceFrame(i)) {
        return pitchMap.midi[i];
      }
    }

    return null;
  }

  function midiToY(midiValue, minMidi, maxMidi) {
    const padTop = 18;
    const padBottom = 18;
    const usableH = Math.max(20, logicalHeight - padTop - padBottom);
    const ratio = (midiValue - minMidi) / Math.max(1, maxMidi - minMidi);
    return padTop + usableH * (1 - Math.max(0, Math.min(1, ratio)));
  }

  function timeToX(timeSec, nowSec) {
    const startSec = nowSec - pastWindowSec;
    return ((timeSec - startSec) / totalWindowSec) * logicalWidth;
  }

  function computeVisiblePitchRange(nowSec) {
    let minVal = Infinity;
    let maxVal = -Infinity;

    if (pitchMap && Array.isArray(pitchMap.midi) && pitchMap.mode !== "heuristic") {
      const startIdx = Math.max(0, timeToIndex(nowSec - pastWindowSec));
      const endIdx = Math.min(
        pitchMap.midi.length - 1,
        timeToIndex(nowSec + futureWindowSec)
      );
      for (let i = startIdx; i <= endIdx; i++) {
        if (isValidReferenceFrame(i)) {
          const v = pitchMap.midi[i];
          if (v < minVal) minVal = v;
          if (v > maxVal) maxVal = v;
        }
      }
    }

    for (const pt of trail) {
      if (Number.isFinite(pt.foldedMidi)) {
        if (pt.foldedMidi < minVal) minVal = pt.foldedMidi;
        if (pt.foldedMidi > maxVal) maxVal = pt.foldedMidi;
      }
    }

    if (!Number.isFinite(minVal) || !Number.isFinite(maxVal)) {
      return { minMidi: smoothedMinMidi, maxMidi: smoothedMaxMidi };
    }

    const center = (minVal + maxVal) / 2;
    const halfSpan = Math.max(8, (maxVal - minVal) / 2 + 3.5);
    const targetMin = center - halfSpan;
    const targetMax = center + halfSpan;

    // Suavização leve para evitar tremor vertical
    smoothedMinMidi += (targetMin - smoothedMinMidi) * 0.18;
    smoothedMaxMidi += (targetMax - smoothedMaxMidi) * 0.18;

    return { minMidi: smoothedMinMidi, maxMidi: smoothedMaxMidi };
  }

  function drawBackgroundGrid(nowSec) {
    ctx.clearRect(0, 0, logicalWidth, logicalHeight);

    // Fundo translúcido escuro para contraste sobre o palco
    ctx.fillStyle = "rgba(10, 14, 24, 0.62)";
    ctx.fillRect(0, 0, logicalWidth, logicalHeight);

    // Linhas horizontais guia (grade de semitons espaçados)
    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.lineWidth = 1;
    const rows = 5;
    for (let r = 1; r < rows; r++) {
      const y = (logicalHeight / rows) * r;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(logicalWidth, y);
      ctx.stroke();
    }

    // Linha vertical do presente ("Agora")
    const playheadX = timeToX(nowSec, nowSec);
    ctx.save();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playheadX, 6);
    ctx.lineTo(playheadX, logicalHeight - 6);
    ctx.stroke();
    ctx.restore();

    return playheadX;
  }

  function drawReferenceNotes(nowSec, effectiveTimeSec, minMidi, maxMidi) {
    if (!pitchMap || !Array.isArray(pitchMap.midi)) return;

    if (pitchMap.mode === "heuristic") {
      ctx.fillStyle = "rgba(255, 255, 255, 0.72)";
      ctx.font = "600 12px system-ui, -apple-system, sans-serif";
      ctx.fillText("Modo instrumental: estabilidade vocal ativa", 14, 22);
      return;
    }

    const t0 = Number(pitchMap.t0 ?? 0);
    const hop = Number(pitchMap.hop) > 0 ? Number(pitchMap.hop) : 0.02;
    const startIdx = Math.max(0, timeToIndex(nowSec - pastWindowSec));
    const endIdx = Math.min(
      pitchMap.midi.length - 1,
      timeToIndex(nowSec + futureWindowSec)
    );
    const currentIdx = timeToIndex(effectiveTimeSec);

    // Agrupa frames contíguos próximos (diferença <= 0.8 semitom) em segmentos de barra
    const segments = [];
    let segStart = -1;
    let segEnd = -1;
    let segSum = 0;
    let segCount = 0;
    let segActive = false;

    for (let i = startIdx; i <= endIdx; i++) {
      if (isValidReferenceFrame(i)) {
        const val = pitchMap.midi[i];
        const prevVal = segCount > 0 ? segSum / segCount : val;
        if (segCount === 0) {
          segStart = i;
          segEnd = i;
          segSum = val;
          segCount = 1;
          segActive = Math.abs(i - currentIdx) <= 2;
        } else if (i === segEnd + 1 && Math.abs(val - prevVal) <= 0.85) {
          segEnd = i;
          segSum += val;
          segCount += 1;
          if (Math.abs(i - currentIdx) <= 2) segActive = true;
        } else {
          segments.push({
            startSec: t0 + segStart * hop,
            endSec: t0 + (segEnd + 1) * hop,
            midi: segSum / segCount,
            active: segActive,
          });
          segStart = i;
          segEnd = i;
          segSum = val;
          segCount = 1;
          segActive = Math.abs(i - currentIdx) <= 2;
        }
      } else if (segCount > 0) {
        segments.push({
          startSec: t0 + segStart * hop,
          endSec: t0 + (segEnd + 1) * hop,
          midi: segSum / segCount,
          active: segActive,
        });
        segCount = 0;
        segActive = false;
      }
    }
    if (segCount > 0) {
      segments.push({
        startSec: t0 + segStart * hop,
        endSec: t0 + (segEnd + 1) * hop,
        midi: segSum / segCount,
        active: segActive,
      });
    }

    for (const seg of segments) {
      const x1 = timeToX(seg.startSec, nowSec);
      const x2 = timeToX(seg.endSec, nowSec);
      const barW = Math.max(4, x2 - x1);
      const y = midiToY(seg.midi, minMidi, maxMidi);

      const isHitNow = seg.active && (currentHit === "perfect" || currentHit === "good");
      const barH = isHitNow ? 11 : seg.active ? 9 : 7;

      ctx.save();
      if (isHitNow) {
        ctx.shadowColor = currentHit === "perfect" ? "#34d399" : "#fbbf24";
        ctx.shadowBlur = 14;
        ctx.fillStyle = currentHit === "perfect" ? "#34d399" : "#fbbf24";
      } else if (seg.active) {
        ctx.fillStyle = "#60a5fa";
      } else {
        ctx.fillStyle = "rgba(148, 163, 184, 0.72)";
      }

      const radius = barH / 2;
      ctx.beginPath();
      ctx.roundRect(x1, y - barH / 2, barW, barH, radius);
      ctx.fill();

      // Contorno de alto contraste quando a nota está sendo acertada (acessibilidade §11.1)
      if (isHitNow) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  function drawUserCursorAndTrail(nowSec, effectiveTimeSec, playheadX, minMidi, maxMidi) {
    // Remove pontos antigos do rastro
    while (trail.length > 0 && nowSec - trail[0].timeSec > maxTrailSec) {
      trail.shift();
    }

    // Desenha rastro recente da voz do usuário
    if (trail.length > 1) {
      ctx.save();
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      for (let i = 1; i < trail.length; i++) {
        const p0 = trail[i - 1];
        const p1 = trail[i];
        if (p1.timeSec - p0.timeSec > 0.15) continue;

        const alpha = Math.max(0.1, 1 - (nowSec - p1.timeSec) / maxTrailSec);
        ctx.strokeStyle =
          p1.hit === "perfect"
            ? `rgba(52, 211, 153, ${alpha})`
            : p1.hit === "good"
              ? `rgba(251, 191, 36, ${alpha})`
              : `rgba(248, 113, 113, ${alpha * 0.85})`;

        ctx.beginPath();
        ctx.moveTo(timeToX(p0.timeSec, nowSec), midiToY(p0.foldedMidi, minMidi, maxMidi));
        ctx.lineTo(timeToX(p1.timeSec, nowSec), midiToY(p1.foldedMidi, minMidi, maxMidi));
        ctx.stroke();
      }
      ctx.restore();
    }

    if (!Number.isFinite(currentUserMidi)) return;

    let visualMidi = null;
    if (pitchMap && pitchMap.mode === "heuristic") {
      visualMidi = currentUserMidi;
    } else {
      const anchorMidi = resolveAnchorReferenceMidi(effectiveTimeSec);
      // Sem nota-alvo atual nem na janela passada visível: não desenha o cursor (FASE_3 T3.2)
      if (anchorMidi === null) return;
      visualMidi = foldMidiToReference(currentUserMidi, anchorMidi);
    }

    const cursorY = midiToY(visualMidi, minMidi, maxMidi);
    const isPerfect = currentHit === "perfect";
    const isGood = currentHit === "good";
    const isHit = isPerfect || isGood;

    ctx.save();

    // Anel pulsante externo no acerto (indicação por forma/animação além de cor — §11.1)
    if (isHit) {
      const pulse = 1 + 0.25 * Math.sin(nowSec * 18);
      ctx.strokeStyle = isPerfect ? "rgba(52, 211, 153, 0.75)" : "rgba(251, 191, 36, 0.75)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(playheadX, cursorY, 12 * pulse, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Núcleo do cursor vocal
    ctx.shadowColor = isPerfect ? "#34d399" : isGood ? "#fbbf24" : "#38bdf8";
    ctx.shadowBlur = isHit ? 14 : 6;
    ctx.fillStyle = isPerfect ? "#34d399" : isGood ? "#fbbf24" : "#f8fafc";
    ctx.beginPath();
    ctx.arc(playheadX, cursorY, isHit ? 7.5 : 6, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  function renderFrame() {
    const nowSec = Number(getCurrentTime()) || 0;
    const effectiveTimeSec = nowSec - latencyOffsetMs / 1000;

    const { minMidi, maxMidi } = computeVisiblePitchRange(nowSec);
    const playheadX = drawBackgroundGrid(nowSec);
    drawReferenceNotes(nowSec, effectiveTimeSec, minMidi, maxMidi);
    drawUserCursorAndTrail(nowSec, effectiveTimeSec, playheadX, minMidi, maxMidi);
  }

  function loop() {
    renderFrame();
    rafId = requestAnimationFrame(loop);
  }

  function start() {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(loop);
  }

  function stop() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  function setPitchMap(nextPitchMap) {
    pitchMap = nextPitchMap || null;
    trail.length = 0;
  }

  function setLatencyOffset(nextMs) {
    latencyOffsetMs = Number(nextMs) || 0;
  }

  function setPitchConfThreshold(nextThreshold) {
    pitchConfThreshold = Number(nextThreshold ?? 0.6);
  }

  /**
   * Atualiza a leitura atual da voz do usuário e registra no rastro dobrado.
   */
  function pushUserFrame({ songTime, midi, hit = null } = {}) {
    const t = Number.isFinite(songTime) ? songTime : Number(getCurrentTime()) || 0;
    currentHit = hit;

    if (midi === null || midi === undefined || !Number.isFinite(midi)) {
      currentUserMidi = null;
      return;
    }

    currentUserMidi = midi;
    const effectiveTimeSec = t - latencyOffsetMs / 1000;
    const anchorMidi =
      pitchMap && pitchMap.mode === "heuristic"
        ? midi
        : resolveAnchorReferenceMidi(effectiveTimeSec);

    if (anchorMidi !== null) {
      const folded =
        pitchMap && pitchMap.mode === "heuristic"
          ? midi
          : foldMidiToReference(midi, anchorMidi);
      trail.push({ timeSec: t, foldedMidi: folded, hit });
    }
  }

  function destroy() {
    stop();
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    if (canvas.parentNode === container) {
      container.removeChild(canvas);
    }
  }

  return {
    start,
    stop,
    renderFrame,
    setPitchMap,
    setLatencyOffset,
    setPitchConfThreshold,
    pushUserFrame,
    destroy,
  };
}