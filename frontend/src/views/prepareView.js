/**
 * Tela de Preparo (#/prepare/:videoId) conectada a POST /api/prepare e SSE.
 */

import { api } from "../api.js";
import { t } from "../i18n.js";
import { navigate } from "../router.js";
import { showBanner } from "../store.js";

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

export function renderPrepareView(container, params) {
  const { videoId } = params;
  let closeSse = null;
  let currentJobId = null;
  let disposed = false;

  container.innerHTML = `
    <section class="card">
      <h2>${t("prepare.title", { videoId })}</h2>
      <p id="prep-status" class="muted">${t("prepare.queued", { position: 1 })}</p>
      <div class="progress-track">
        <div id="prep-progress-fill" class="progress-fill"></div>
      </div>
      <div style="display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 1rem;">
        <button type="button" id="prep-cancel-btn" class="btn btn-danger">
          ${t("prepare.cancelBtn")}
        </button>
        <button type="button" id="prep-retry-btn" class="btn btn-primary" hidden>
          ${t("prepare.retryBtn")}
        </button>
        <button type="button" id="prep-back-btn" class="btn btn-secondary">
          ${t("prepare.backBtn")}
        </button>
      </div>
    </section>
  `;

  const statusEl = container.querySelector("#prep-status");
  const fillEl = container.querySelector("#prep-progress-fill");
  const cancelBtn = container.querySelector("#prep-cancel-btn");
  const retryBtn = container.querySelector("#prep-retry-btn");
  const backBtn = container.querySelector("#prep-back-btn");

  backBtn?.addEventListener("click", () => navigate("/"));

  cancelBtn?.addEventListener("click", async () => {
    if (!currentJobId) return;
    cancelBtn.disabled = true;
    try {
      await api.cancelJob(currentJobId);
      if (!disposed) {
        statusEl.textContent = t("prepare.canceled");
        cancelBtn.hidden = true;
        retryBtn.hidden = false;
      }
    } catch (err) {
      showBanner("error", err.message);
      cancelBtn.disabled = false;
    }
  });

  retryBtn?.addEventListener("click", () => {
    retryBtn.hidden = true;
    cancelBtn.hidden = false;
    cancelBtn.disabled = false;
    startPreparation();
  });

  async function startPreparation() {
    try {
      const res = await api.prepareSong(videoId);
      if (disposed) return;

      if (res.status === "ready") {
        fillEl.style.width = "100%";
        statusEl.textContent = t("prepare.ready");
        navigate(`/play/${encodeURIComponent(videoId)}`);
        return;
      }

      currentJobId = res.jobId;
      closeSse = api.subscribeJobEvents(currentJobId, {
        onEvent: (evt) => {
          if (disposed) return;

          if (evt.event === "state" && evt.state === "queued") {
            statusEl.textContent = t("prepare.queued", { position: evt.position ?? 1 });
          } else if (evt.event === "progress" || (evt.event === "state" && evt.state === "running")) {
            const pct = computeOverallPercent(evt.step || "download", evt.percent ?? 0);
            fillEl.style.width = `${pct}%`;
            statusEl.textContent = t("prepare.running", {
              step: evt.step || "download",
              percent: pct,
            });
          } else if (evt.event === "step_done") {
            const pct = computeOverallPercent(evt.step, 100);
            fillEl.style.width = `${pct}%`;
          } else if (evt.event === "state" && evt.state === "ready") {
            fillEl.style.width = "100%";
            statusEl.textContent = t("prepare.ready");
            setTimeout(() => {
              if (!disposed) navigate(`/play/${encodeURIComponent(videoId)}`);
            }, 350);
          } else if (evt.event === "state" && evt.state === "canceled") {
            statusEl.textContent = t("prepare.canceled");
            cancelBtn.hidden = true;
            retryBtn.hidden = false;
          } else if (evt.event === "error" || (evt.event === "state" && evt.state === "failed")) {
            const reason = evt.message || "Erro desconhecido";
            statusEl.textContent = t("prepare.failed", { reason });
            cancelBtn.hidden = true;
            retryBtn.hidden = false;
          }
        },
      });
    } catch (err) {
      if (!disposed) {
        statusEl.textContent = t("prepare.failed", { reason: err.message });
        cancelBtn.hidden = true;
        retryBtn.hidden = false;
      }
    }
  }

  startPreparation();

  return () => {
    disposed = true;
    if (closeSse) closeSse();
  };
}