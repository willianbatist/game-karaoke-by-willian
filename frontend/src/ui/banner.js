/**
 * Banner global de avisos e erros (substitui window.alert).
 */

import { t } from "../i18n.js";
import { clearBanner, getState, subscribe } from "../store.js";

export function initBanner() {
  const bannerEl = document.getElementById("global-banner");
  const textEl = document.getElementById("global-banner-text");
  const closeBtn = document.getElementById("global-banner-close");

  if (!bannerEl || !textEl || !closeBtn) return;

  closeBtn.addEventListener("click", () => {
    clearBanner();
  });

  function render(state) {
    closeBtn.textContent = t("banner.dismiss");

    if (!state.banner || !state.banner.message) {
      bannerEl.hidden = true;
      bannerEl.className = "global-banner";
      textEl.textContent = "";
      return;
    }

    const type = ["info", "success", "warning", "error"].includes(state.banner.type)
      ? state.banner.type
      : "info";

    bannerEl.className = `global-banner ${type}`;
    textEl.textContent = state.banner.message;
    bannerEl.hidden = false;
  }

  subscribe(render);
  render(getState());
}