/**
 * Tela de Preparo (#/preparo/:videoId) — CONTRACTS.md §5.1 e T4.5.3:
 * - Se a música já estiver pronta no cache, redireciona direto para #/pre-jogo/:videoId
 * - Envia metadados da busca em POST /api/prepare e exibe compatibilidade provisória (Fase 1)
 * - Trilha visual de etapas (Na fila -> Baixando -> Separando voz -> Gerando gabarito -> Analisando -> Pronto)
 * - Indica GPU ou CPU (campo `device`), estimativa de tempo, botão Cancelar e reconexão SSE
 */

import { api } from "../api.js";
import { navigate } from "../router.js";
import { getState, showBanner } from "../store.js";
import { createCompatibilityBadge } from "../ui/components/compatibilityBadge.js";

const PIPELINE_STAGES = [
  { id: "queued", label: "Na fila" },
  { id: "download", label: "Baixando" },
  { id: "separate", label: "Separando voz" },
  { id: "pitch", label: "Gerando gabarito" },
  { id: "analyze", label: "Analisando" },
  { id: "ready", label: "Pronto" },
];

const STEP_WEIGHTS = {
  download: 0,
  separate: 20,
  pitch: 65,
  analyze: 85,
  package: 95,
};

function computeOverallPercent(step, stepPercent) {
  const base = STEP_WEIGHTS[step] ?? 0;
  const span =
    step === "download"
      ? 20
      : step === "separate"
        ? 45
        : step === "pitch"
          ? 20
          : step === "analyze"
            ? 10
            : 5;
  return Math.min(100, Math.round(base + (Math.max(0, Math.min(100, stepPercent)) / 100) * span));
}

function estimateRemainingLabel(percent, device, durationSec) {
  if (percent >= 95) return "Quase pronto...";
  const isGpu = device && device !== "cpu";
  const baseTotalSec = durationSec > 0 ? Math.max(15, durationSec * (isGpu ? 0.14 : 0.45)) : isGpu ? 25 : 70;
  const remainingSec = Math.max(3, Math.round(baseTotalSec * ((100 - percent) / 100)));
  if (remainingSec < 60) {
    return `Estimativa: ~${remainingSec}s restantes`;
  }
  const mins = Math.ceil(remainingSec / 60);
  return `Estimativa: ~${mins} min restante(s)`;
}

export function renderPrepareView(container, params) {
  const { videoId } = params;
  const storedMeta = (getState().searchMetadataById || {})[videoId] || {};

  let closeSse = null;
  let reconnectTimerId = null;
  let currentJobId = null;
  let disposed = false;
  let terminalReached = false;
  let detectedDevice = "";

  container.replaceChildren();

  const shell = document.createElement("div");
  shell.className = "prepare-shell";

  const card = document.createElement("section");
  card.className = "card";

  const headerRow = document.createElement("div");
  headerRow.className = "section-header-row";

  const titleEl = document.createElement("h1");
  titleEl.textContent = storedMeta.title
    ? `Preparando: ${storedMeta.title}`
    : `Preparando música (${videoId})`;

  const devicePill = document.createElement("span");
  devicePill.className = "pill";
  devicePill.textContent = "Aceleração: verificando...";

  headerRow.append(titleEl, devicePill);

  if (storedMeta.channel) {
    const channelEl = document.createElement("p");
    channelEl.className = "muted";
    channelEl.textContent = storedMeta.channel;
    card.append(headerRow, channelEl);
  } else {
    card.append(headerRow);
  }

  // Trilha visual das etapas
  const stepperEl = document.createElement("ol");
  stepperEl.className = "pipeline-stepper";
  const stepElements = new Map();

  for (const st of PIPELINE_STAGES) {
    const li = document.createElement("li");
    li.className = "pipeline-step";
    li.dataset.stage = st.id;
    li.textContent = st.label;
    stepperEl.appendChild(li);
    stepElements.set(st.id, li);
  }

  const statusRow = document.createElement("div");
  statusRow.className = "prepare-status-row";

  const statusEl = document.createElement("p");
  statusEl.className = "prepare-status-text";
  statusEl.textContent = "Iniciando preparo...";

  const etaEl = document.createElement("span");
  etaEl.className = "mono muted";
  etaEl.textContent = "";

  statusRow.append(statusEl, etaEl);

  const track = document.createElement("div");
  track.className = "progress-track";
  const fillEl = document.createElement("div");
  fillEl.className = "progress-fill";
  track.appendChild(fillEl);

  // Host da compatibilidade provisória (Fase 1)
  const compatHost = document.createElement("div");
  compatHost.className = "prepare-compat-host";

  // Botões de ação
  const actionsRow = document.createElement("div");
  actionsRow.className = "prepare-actions-row";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "btn btn-danger";
  cancelBtn.textContent = "Cancelar preparo";

  const retryBtn = document.createElement("button");
  retryBtn.type = "button";
  retryBtn.className = "btn btn-primary";
  retryBtn.textContent = "Tentar novamente";
  retryBtn.hidden = true;

  const altVersionBtn = document.createElement("button");
  altVersionBtn.type = "button";
  altVersionBtn.className = "btn btn-secondary";
  altVersionBtn.textContent = "Escolher outra versão";
  altVersionBtn.addEventListener("click", () => {
    const lastQ = getState().lastSearchQuery || storedMeta.title || "";
    if (lastQ) {
      navigate(`/busca?q=${encodeURIComponent(lastQ)}`);
    } else {
      navigate("/");
    }
  });

  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "btn btn-secondary";
  backBtn.textContent = "Voltar ao início";
  backBtn.addEventListener("click", () => navigate("/"));

  actionsRow.append(cancelBtn, retryBtn, altVersionBtn, backBtn);

  card.append(stepperEl, statusRow, track, compatHost, actionsRow);
  shell.appendChild(card);
  container.appendChild(shell);

  function setActiveStage(stageId) {
    const normalized = stageId === "package" ? "analyze" : stageId;
    const targetIdx = PIPELINE_STAGES.findIndex((s) => s.id === normalized);
    PIPELINE_STAGES.forEach((st, idx) => {
      const el = stepElements.get(st.id);
      if (!el) return;
      el.classList.remove("active", "done");
      if (targetIdx >= 0) {
        if (idx < targetIdx || normalized === "ready") {
          el.classList.add("done");
        } else if (idx === targetIdx) {
          el.classList.add("active");
        }
      }
    });
  }

  function updateDeviceBadge(device) {
    if (!device) return;
    detectedDevice = String(device).toLowerCase();
    const isGpu = detectedDevice !== "cpu";
    devicePill.className = isGpu ? "pill synced" : "pill";
    devicePill.textContent = isGpu
      ? `Processando em GPU (${detectedDevice.toUpperCase()})`
      : "Processando em CPU";
  }

  function clearReconnectTimer() {
    if (reconnectTimerId !== null) {
      clearTimeout(reconnectTimerId);
      reconnectTimerId = null;
    }
  }

  function handleJobEvent(evt) {
    if (disposed || terminalReached) return;

    if (evt.device) {
      updateDeviceBadge(evt.device);
    }

    if (evt.event === "state" && evt.state === "queued") {
      setActiveStage("queued");
      statusEl.textContent = `Na fila de processamento (posição ${evt.position ?? 1})...`;
      etaEl.textContent = "Aguardando início";
    } else if (evt.event === "progress" || (evt.event === "state" && evt.state === "running")) {
      const step = evt.step || "download";
      const pct = computeOverallPercent(step, evt.percent ?? 0);
      setActiveStage(step);
      fillEl.style.width = `${pct}%`;
      statusEl.textContent = evt.message
        ? `${evt.message} (${pct}%)`
        : `Processando: ${step} (${pct}%)`;
      etaEl.textContent = estimateRemainingLabel(pct, detectedDevice, storedMeta.duration);
    } else if (evt.event === "step_done") {
      const pct = computeOverallPercent(evt.step, 100);
      fillEl.style.width = `${pct}%`;
    } else if (evt.event === "state" && evt.state === "ready") {
      terminalReached = true;
      clearReconnectTimer();
      setActiveStage("ready");
      fillEl.style.width = "100%";
      statusEl.textContent = "Música pronta! Abrindo resumo pré-jogo...";
      etaEl.textContent = "Concluído";
      setTimeout(() => {
        if (!disposed) {
          navigate(`/pre-jogo/${encodeURIComponent(videoId)}`);
        }
      }, 300);
    } else if (evt.event === "state" && evt.state === "canceled") {
      terminalReached = true;
      clearReconnectTimer();
      statusEl.textContent = "Preparo cancelado.";
      etaEl.textContent = "";
      cancelBtn.hidden = true;
      retryBtn.hidden = false;
    } else if (evt.event === "error" || (evt.event === "state" && evt.state === "failed")) {
      terminalReached = true;
      clearReconnectTimer();
      const reason = evt.message || "Falha inesperada durante o processamento.";
      statusEl.textContent = `Não foi possível preparar: ${reason}`;
      etaEl.textContent = "";
      cancelBtn.hidden = true;
      retryBtn.hidden = false;
    }
  }

  function connectSseWithRecovery(jobId) {
    if (disposed || terminalReached) return;
    if (closeSse) {
      closeSse();
      closeSse = null;
    }

    closeSse = api.subscribeJobEvents(jobId, {
      onEvent: handleJobEvent,
      onError: () => {
        if (disposed || terminalReached) return;
        statusEl.textContent = "Conexão oscilou — reconectando ao progresso...";
        clearReconnectTimer();
        reconnectTimerId = setTimeout(async () => {
          if (disposed || terminalReached) return;
          try {
            const jobSnap = await api.getJob(jobId);
            if (jobSnap?.device) updateDeviceBadge(jobSnap.device);
            if (jobSnap?.state === "ready") {
              handleJobEvent({ event: "state", state: "ready" });
              return;
            }
            if (jobSnap?.state === "failed" || jobSnap?.state === "canceled") {
              handleJobEvent({
                event: "state",
                state: jobSnap.state,
                message: jobSnap.error || "Job encerrado.",
              });
              return;
            }
            if (jobSnap) {
              handleJobEvent({
                event: "progress",
                step: jobSnap.step || "download",
                percent: jobSnap.percent ?? 0,
              });
            }
          } catch {
            // Tenta reconectar o SSE mesmo se GET /api/jobs/:id falhar
          }
          connectSseWithRecovery(jobId);
        }, 1500);
      },
    });
  }

  cancelBtn.addEventListener("click", async () => {
    if (!currentJobId) return;
    cancelBtn.disabled = true;
    try {
      await api.cancelJob(currentJobId);
      terminalReached = true;
      clearReconnectTimer();
      if (!disposed) {
        statusEl.textContent = "Preparo cancelado.";
        etaEl.textContent = "";
        cancelBtn.hidden = true;
        retryBtn.hidden = false;
      }
    } catch (err) {
      showBanner("error", err.message);
      cancelBtn.disabled = false;
    }
  });

  retryBtn.addEventListener("click", () => {
    terminalReached = false;
    retryBtn.hidden = true;
    cancelBtn.hidden = false;
    cancelBtn.disabled = false;
    startPreparation();
  });

  async function startPreparation() {
    setActiveStage("queued");
    fillEl.style.width = "4%";
    statusEl.textContent = "Verificando cache local e iniciando preparo...";

    try {
      const res = await api.prepareSong(videoId, storedMeta);
      if (disposed) return;

      if (res.compatibility) {
        compatHost.replaceChildren(
          createCompatibilityBadge(res.compatibility, { compact: false, showReasons: true })
        );
      }

      if (res.status === "ready") {
        terminalReached = true;
        setActiveStage("ready");
        fillEl.style.width = "100%";
        statusEl.textContent = "Música já está pronta no cache! Abrindo pré-jogo...";
        navigate(`/pre-jogo/${encodeURIComponent(videoId)}`);
        return;
      }

      currentJobId = res.jobId;
      connectSseWithRecovery(currentJobId);
    } catch (err) {
      if (!disposed) {
        statusEl.textContent = `Erro ao iniciar preparo: ${err.message}`;
        cancelBtn.hidden = true;
        retryBtn.hidden = false;
      }
    }
  }

  startPreparation();

  return () => {
    disposed = true;
    clearReconnectTimer();
    if (closeSse) closeSse();
  };
}