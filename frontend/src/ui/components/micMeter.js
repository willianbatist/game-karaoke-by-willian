/**
 * Componente discreto de medidor de nível e clareza do microfone na Tela de Jogo (T3.3).
 * Exibe barra de sinal em tempo real e indicador de voz detectada usando forma, texto e cor
 * (sem innerHTML e seguindo requisitos de acessibilidade de FRONTEND_ARCHITECTURE.md §7.1 e §11.1).
 */

/**
 * Converte RMS linear (0.0 a 1.0) em percentual visual (0 a 100) em escala perceptual (dB).
 */
export function rmsToMeterPercent(rms) {
  const safeRms = Math.max(0, Number(rms) || 0);
  if (safeRms <= 0.0001) return 0;
  const db = 20 * Math.log10(safeRms); // intervalo típico: -60 dB a 0 dB
  const normalized = ((db + 60) / 60) * 100;
  return Math.round(Math.max(0, Math.min(100, normalized)));
}

export function createMicMeter(container, options = {}) {
  if (!container) {
    throw new Error("Container inválido para createMicMeter");
  }

  const clarityThreshold = Number(options.clarityThreshold ?? 0.7);

  const root = document.createElement("div");
  root.className = "mic-meter";
  root.setAttribute("role", "status");
  root.setAttribute("aria-live", "polite");
  root.setAttribute("aria-label", "Medidor de nível do microfone");

  const header = document.createElement("div");
  header.className = "mic-meter__header";

  const shapeBadge = document.createElement("span");
  shapeBadge.className = "mic-meter__badge";
  shapeBadge.textContent = "○";

  const statusLabel = document.createElement("span");
  statusLabel.className = "mic-meter__label";
  statusLabel.textContent = "Microfone pronto";

  header.appendChild(shapeBadge);
  header.appendChild(statusLabel);

  const track = document.createElement("div");
  track.className = "mic-meter__track";

  const fill = document.createElement("div");
  fill.className = "mic-meter__fill";
  fill.style.width = "0%";
  fill.style.height = "100%";
  fill.style.transition = "width 60ms linear";

  track.appendChild(fill);
  root.appendChild(header);
  root.appendChild(track);
  container.appendChild(root);

  function update({ rms = 0, clarity = 0, midi = null } = {}) {
    const percent = rmsToMeterPercent(rms);
    fill.style.width = `${percent}%`;

    const hasPitch =
      midi !== null &&
      midi !== undefined &&
      Number.isFinite(midi) &&
      Number(clarity) >= clarityThreshold;

    if (hasPitch) {
      root.dataset.state = "active";
      shapeBadge.textContent = "●";
      statusLabel.textContent = "Voz captada";
    } else if (percent > 12) {
      root.dataset.state = "signal";
      shapeBadge.textContent = "◐";
      statusLabel.textContent = "Sinal detectado";
    } else {
      root.dataset.state = "idle";
      shapeBadge.textContent = "○";
      statusLabel.textContent = "Aguardando voz";
    }
  }

  function setError(message = "Microfone indisponível") {
    root.dataset.state = "error";
    fill.style.width = "0%";
    shapeBadge.textContent = "▲";
    statusLabel.textContent = String(message);
  }

  function destroy() {
    if (root.parentNode === container) {
      container.removeChild(root);
    }
  }

  return {
    update,
    setError,
    destroy,
  };
}