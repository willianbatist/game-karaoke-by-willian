/**
 * Tela de Fila de Preparação (#/preparando):
 * - Lista músicas atualmente na fila, baixando ou em separação vocal (Demucs)
 * - Permite acompanhar o progresso em tempo real, abrir os detalhes, cancelar ou cantar assim que ficar pronta
 */

import { api } from "../api.js";
import { navigate } from "../router.js";
import { showBanner } from "../store.js";
import { confirmDialog } from "../ui/confirmModal.js";

const STAGE_LABELS = {
  queued: "Na fila aguardando início",
  downloading: "Baixando vídeo e áudio do YouTube",
  separating: "Separando voz e instrumental (Demucs)",
  fetching_lyrics: "Buscando letra sincronizada",
  ready: "Pronta para cantar!",
  failed: "Falha no preparo",
  canceled: "Cancelada",
};

function isActiveState(state) {
  return (
    state === "queued" ||
    state === "downloading" ||
    state === "separating" ||
    state === "fetching_lyrics"
  );
}

function updateHeaderJobsBadge(activeCount) {
  const badge = document.getElementById("nav-preparing-badge");
  if (!badge) return;
  if (activeCount > 0) {
    badge.textContent = String(activeCount);
    badge.hidden = false;
  } else {
    badge.textContent = "0";
    badge.hidden = true;
  }
}

export function renderPreparingQueueView(container) {
  let disposed = false;
  let pollTimer = null;

  container.replaceChildren();

  const shell = document.createElement("div");
  shell.className = "manage-shell";

  // Cabeçalho da tela
  const headerCard = document.createElement("section");
  headerCard.className = "card";

  const topRow = document.createElement("div");
  topRow.className = "section-header-row";

  const titleWrap = document.createElement("div");
  const titleEl = document.createElement("h1");
  titleEl.textContent = "Preparando Músicas";
  const subtitleEl = document.createElement("p");
  subtitleEl.className = "muted";
  subtitleEl.textContent =
    "Acompanhe aqui os downloads e a separação de voz em andamento. Você pode navegar livremente pelas outras abas enquanto as músicas ficam prontas.";
  titleWrap.append(titleEl, subtitleEl);

  const addMoreBtn = document.createElement("button");
  addMoreBtn.type = "button";
  addMoreBtn.className = "btn btn-primary";
  addMoreBtn.textContent = "+ Preparar outra música";
  addMoreBtn.addEventListener("click", () => navigate("/"));

  topRow.append(titleWrap, addMoreBtn);
  headerCard.appendChild(topRow);
  shell.appendChild(headerCard);

  // Seção 1: Em andamento / Na fila
  const activeCard = document.createElement("section");
  activeCard.className = "card";

  const activeHeading = document.createElement("h2");
  activeHeading.textContent = "Em andamento (0)";
  const activeListHost = document.createElement("div");
  activeListHost.className = "library-list";

  activeCard.append(activeHeading, activeListHost);
  shell.appendChild(activeCard);

  // Seção 2: Concluídas ou com falha recente
  const recentCard = document.createElement("section");
  recentCard.className = "card";

  const recentHeading = document.createElement("h2");
  recentHeading.textContent = "Finalizadas recentemente";
  const recentListHost = document.createElement("div");
  recentListHost.className = "library-list";

  recentCard.append(recentHeading, recentListHost);
  shell.appendChild(recentCard);

  container.appendChild(shell);

  function buildJobCard(job) {
    const active = isActiveState(job.state);
    const pct = Math.max(0, Math.min(100, Math.round(Number(job.progress) || 0)));

    const item = document.createElement("article");
    item.className = active
      ? "library-item-card preparing-job-card preparing-job-card--active"
      : "library-item-card preparing-job-card";

    const info = document.createElement("div");
    info.className = "library-item-info";

    const titleRow = document.createElement("div");
    titleRow.className = "library-item-title-row";

    const titleElItem = document.createElement("h3");
    titleElItem.className = "library-item-title";
    titleElItem.textContent = job.title || job.videoId;

    const statusPill = document.createElement("span");
    statusPill.className =
      job.state === "ready"
        ? "pill synced"
        : job.state === "failed"
          ? "pill pill-danger"
          : "pill";
    statusPill.textContent = active
      ? `${STAGE_LABELS[job.state] || job.state} (${pct}%)`
      : STAGE_LABELS[job.state] || job.state;

    titleRow.append(titleElItem, statusPill);

    const metaRow = document.createElement("div");
    metaRow.className = "library-item-meta muted";
    if (job.state === "failed" && job.error?.message) {
      metaRow.textContent = `ID: ${job.videoId} • Erro: ${job.error.message}`;
    } else {
      metaRow.textContent = job.channel
        ? `${job.channel} • ID: ${job.videoId}`
        : `ID do vídeo: ${job.videoId}`;
    }

    info.append(titleRow, metaRow);

    if (active) {
      const track = document.createElement("div");
      track.className = "progress-track preparing-progress-track";
      const fill = document.createElement("div");
      fill.className = "progress-fill";
      fill.style.width = `${pct}%`;
      track.appendChild(fill);
      info.appendChild(track);
    }

    const actions = document.createElement("div");
    actions.className = "library-item-actions";

    if (active) {
      const detailsBtn = document.createElement("button");
      detailsBtn.type = "button";
      detailsBtn.className = "btn btn-secondary";
      detailsBtn.textContent = "Ver detalhes";
      detailsBtn.addEventListener("click", () => {
        navigate(`/preparo/${encodeURIComponent(job.videoId)}`);
      });

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "btn btn-danger";
      cancelBtn.textContent = "Cancelar";
      cancelBtn.addEventListener("click", async () => {
        const ok = await confirmDialog({
          title: "Cancelar preparo da música?",
          message: `Deseja interromper o download/processamento de "${job.title || job.videoId}"?`,
          confirmText: "Cancelar preparo",
          danger: true,
        });
        if (!ok || disposed) return;

        cancelBtn.disabled = true;
        try {
          await api.cancelJob(job.jobId);
          showBanner("info", `Preparo de "${job.title || job.videoId}" cancelado.`);
          await loadJobs();
        } catch (err) {
          showBanner("error", err.message);
          cancelBtn.disabled = false;
        }
      });

      actions.append(detailsBtn, cancelBtn);
    } else if (job.state === "ready") {
      const singBtn = document.createElement("button");
      singBtn.type = "button";
      singBtn.className = "btn btn-primary";
      singBtn.textContent = "Cantar agora";
      singBtn.addEventListener("click", () => {
        navigate(`/pre-jogo/${encodeURIComponent(job.videoId)}`);
      });
      actions.appendChild(singBtn);
    } else {
      const retryBtn = document.createElement("button");
      retryBtn.type = "button";
      retryBtn.className = "btn btn-secondary";
      retryBtn.textContent = "Tentar novamente";
      retryBtn.addEventListener("click", () => {
        navigate(`/preparo/${encodeURIComponent(job.videoId)}`);
      });
      actions.appendChild(retryBtn);
    }

    item.append(info, actions);
    return item;
  }

  function renderJobs(data) {
    const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
    const activeJobs = jobs.filter((j) => isActiveState(j.state));
    const finishedJobs = jobs.filter((j) => !isActiveState(j.state));

    updateHeaderJobsBadge(activeJobs.length);

    activeHeading.textContent = `Em andamento (${activeJobs.length})`;
    activeListHost.replaceChildren();

    if (activeJobs.length === 0) {
      const emptyActive = document.createElement("p");
      emptyActive.className = "muted";
      emptyActive.textContent = "Nenhuma música sendo baixada ou processada no momento.";
      activeListHost.appendChild(emptyActive);
    } else {
      for (const job of activeJobs) {
        activeListHost.appendChild(buildJobCard(job));
      }
    }

    recentListHost.replaceChildren();
    if (finishedJobs.length === 0) {
      recentCard.hidden = true;
    } else {
      recentCard.hidden = false;
      for (const job of finishedJobs.slice(0, 12)) {
        recentListHost.appendChild(buildJobCard(job));
      }
    }
  }

  async function loadJobs() {
    try {
      const data = await api.getJobs();
      if (!disposed) {
        renderJobs(data);
      }
    } catch (err) {
      if (!disposed) {
        showBanner("warning", `Não foi possível atualizar a fila: ${err.message}`);
      }
    }
  }

  loadJobs();
  pollTimer = setInterval(() => {
    if (!disposed) loadJobs();
  }, 1800);

  return () => {
    disposed = true;
    if (pollTimer) clearInterval(pollTimer);
  };
}