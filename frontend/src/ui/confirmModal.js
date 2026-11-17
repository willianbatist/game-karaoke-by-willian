/**
 * Modal de confirmação personalizado baseado em Promise (substitui window.confirm).
 */

import { t } from "../i18n.js";

let backdropEl = null;
let titleEl = null;
let messageEl = null;
let cancelBtn = null;
let confirmBtn = null;
let activeResolver = null;

function closeWith(result) {
  if (!backdropEl) return;
  backdropEl.hidden = true;
  if (activeResolver) {
    const resolve = activeResolver;
    activeResolver = null;
    resolve(result);
  }
}

export function initConfirmModal() {
  backdropEl = document.getElementById("confirm-modal");
  titleEl = document.getElementById("confirm-modal-title");
  messageEl = document.getElementById("confirm-modal-message");
  cancelBtn = document.getElementById("confirm-modal-cancel");
  confirmBtn = document.getElementById("confirm-modal-accept");

  if (!backdropEl || !cancelBtn || !confirmBtn) return;

  cancelBtn.addEventListener("click", () => closeWith(false));
  confirmBtn.addEventListener("click", () => closeWith(true));

  backdropEl.addEventListener("click", (evt) => {
    if (evt.target === backdropEl) {
      closeWith(false);
    }
  });

  document.addEventListener("keydown", (evt) => {
    if (evt.key === "Escape" && backdropEl && !backdropEl.hidden) {
      closeWith(false);
    }
  });
}

/**
 * Abre o modal de confirmação e aguarda a escolha do usuário.
 */
export function confirmDialog({
  title,
  message,
  confirmText,
  cancelText,
  danger = false,
} = {}) {
  if (!backdropEl) {
    return Promise.resolve(false);
  }

  if (activeResolver) {
    activeResolver(false);
    activeResolver = null;
  }

  titleEl.textContent = title || t("modal.defaultTitle");
  messageEl.textContent = message || "";
  cancelBtn.textContent = cancelText || t("modal.cancel");
  confirmBtn.textContent = confirmText || t("modal.confirm");

  confirmBtn.className = danger ? "btn btn-danger" : "btn btn-primary";
  backdropEl.hidden = false;
  confirmBtn.focus();

  return new Promise((resolve) => {
    activeResolver = resolve;
  });
}