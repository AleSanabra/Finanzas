const typeInputs = document.querySelectorAll('input[name="type"]');
const editToggles = document.querySelectorAll('[data-edit-toggle]');
const settingsToggle = document.querySelector('[data-settings-toggle]');
const settingsPanel = document.querySelector('[data-settings-panel]');
const closingToggle = document.querySelector('[data-closing-toggle]');
const closingPanel = document.querySelector('[data-closing-panel]');
const copyUserMovementsButton = document.querySelector('[data-copy-user-movements]');

function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);

  return Promise.resolve();
}

function syncOwnerField(form) {
  const ownerField = form.querySelector('[data-owner-field]');
  const selected = form.querySelector('input[name="type"]:checked');
  const isIndividual = selected && selected.value === 'individual';

  if (!ownerField) {
    return;
  }

  ownerField.classList.toggle('is-hidden', !isIndividual);
}

typeInputs.forEach((input) => {
  const form = input.closest('form');

  input.addEventListener('change', () => syncOwnerField(form));
});

document.querySelectorAll('form').forEach((form) => {
  syncOwnerField(form);
});

editToggles.forEach((button) => {
  button.addEventListener('click', () => {
    const row = document.querySelector(`[data-edit-row="${button.dataset.editToggle}"]`);

    if (row) {
      row.classList.toggle('is-hidden');
    }
  });
});

if (settingsToggle && settingsPanel) {
  settingsToggle.addEventListener('click', () => {
    const isHidden = settingsPanel.classList.toggle('is-hidden');
    const label = settingsToggle.querySelector('strong');

    settingsToggle.setAttribute('aria-expanded', String(!isHidden));
    if (label) {
      label.textContent = isHidden ? 'Editar' : 'Cerrar';
    }
  });
}

if (closingToggle && closingPanel) {
  closingToggle.addEventListener('click', () => {
    const isHidden = closingPanel.classList.toggle('is-hidden');
    const label = closingToggle.querySelector('strong');

    closingToggle.setAttribute('aria-expanded', String(!isHidden));
    if (label) {
      label.textContent = isHidden ? 'Ver' : 'Ocultar';
    }
  });
}

if (copyUserMovementsButton) {
  copyUserMovementsButton.addEventListener('click', async () => {
    const originalText = copyUserMovementsButton.dataset.copyLabel || copyUserMovementsButton.textContent.trim();
    const rows = Array.from(document.querySelectorAll('[data-user-movement]'));
    const text = rows
      .map((row) => [
        row.dataset.category,
        row.dataset.description,
        row.dataset.type,
        row.dataset.total,
      ].join(' - '))
      .join('\n');

    if (!text) {
      return;
    }

    copyUserMovementsButton.dataset.copyLabel = originalText;
    await copyText(text);

    copyUserMovementsButton.textContent = 'Copiado';

    setTimeout(() => {
      copyUserMovementsButton.textContent = originalText;
    }, 1800);
  });
}
