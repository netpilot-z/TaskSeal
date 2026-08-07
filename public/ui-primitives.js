export function createDialogController(dialog) {
  if (!(dialog instanceof HTMLDialogElement)) {
    throw new TypeError("TaskSeal dialog primitive requires a native dialog.");
  }

  const close = () => {
    if (dialog.open) {
      dialog.close("cancel");
    }
  };

  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      close();
    }
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });

  return {
    open() {
      if (!dialog.open) {
        dialog.showModal();
      }
    },
    close
  };
}

export function setButtonBusy(button, busy, busyLabel) {
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }
  if (busy) {
    button.dataset.previousLabel ??= button.textContent ?? "";
    button.textContent = busyLabel;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    return;
  }
  button.textContent = button.dataset.previousLabel ?? button.textContent;
  delete button.dataset.previousLabel;
  button.removeAttribute("aria-busy");
}

export function setVisible(element, visible) {
  if (!(element instanceof HTMLElement)) {
    return;
  }
  element.hidden = !visible;
}
