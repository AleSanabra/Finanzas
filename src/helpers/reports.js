function formatMoney(value) {
  return new Intl.NumberFormat('es-AR', {
    currency: 'ARS',
    maximumFractionDigits: 2,
    style: 'currency',
  }).format(Number(value || 0));
}

function formatPercent(value) {
  return new Intl.NumberFormat('es-AR', {
    maximumFractionDigits: 1,
    style: 'percent',
  }).format(Number(value || 0));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function expenseType(expense) {
  return expense.type === 'shared' ? 'Compartido' : 'Individual';
}

function expenseStatus(expense) {
  return expense.status === 'paid' ? 'Pagado' : 'Pendiente';
}

function generateExcelReport(snapshot) {
  const balances = snapshot.dashboard.balances || [];
  const expenses = snapshot.expenses || [];

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        body { font-family: Arial, sans-serif; }
        table { border-collapse: collapse; margin-bottom: 24px; width: 100%; }
        th, td { border: 1px solid #999; padding: 6px; }
        th { background: #e8f3f0; }
        .right { text-align: right; }
      </style>
    </head>
    <body>
      <h1>Cierre mensual ${escapeHtml(snapshot.period)}</h1>
      <p>Generado: ${escapeHtml(snapshot.closedAt)}</p>

      <h2>Resumen</h2>
      <table>
        <tr><th>Total</th><th>Pendiente</th><th>Pagado</th><th>Compartidos</th><th>Individuales</th></tr>
        <tr>
          <td class="right">${formatMoney(snapshot.dashboard.totals.all)}</td>
          <td class="right">${formatMoney(snapshot.dashboard.totals.pending)}</td>
          <td class="right">${formatMoney(snapshot.dashboard.totals.paid)}</td>
          <td class="right">${formatMoney(snapshot.dashboard.totals.shared)}</td>
          <td class="right">${formatMoney(snapshot.dashboard.totals.individual)}</td>
        </tr>
      </table>

      <h2>Personas</h2>
      <table>
        <tr>
          <th>Persona</th><th>Ingreso</th><th>Participacion</th><th>Le corresponde</th>
          <th>Asignado a pagar</th><th>Ya pagado</th><th>Falta pagar</th><th>Balance</th>
        </tr>
        ${balances.map((user) => `
          <tr>
            <td>${escapeHtml(user.name)}</td>
            <td class="right">${formatMoney(user.income)}</td>
            <td class="right">${formatPercent(user.share)}</td>
            <td class="right">${formatMoney(user.sharedOwed)}</td>
            <td class="right">${formatMoney(user.sharedAssigned)}</td>
            <td class="right">${formatMoney(user.sharedPaid)}</td>
            <td class="right">${formatMoney(user.sharedPendingToPay)}</td>
            <td class="right">${formatMoney(user.balance)}</td>
          </tr>
        `).join('')}
      </table>

      <h2>Movimientos</h2>
      <table>
        <tr>
          <th>Fecha</th><th>Descripcion</th><th>Categoria</th><th>Tipo</th><th>Estado</th>
          <th>Responsable</th><th>Titular</th><th>Importe</th><th>Notas</th>
        </tr>
        ${expenses.map((expense) => `
          <tr>
            <td>${escapeHtml(expense.expense_date)}</td>
            <td>${escapeHtml(expense.description)}</td>
            <td>${escapeHtml(expense.category)}</td>
            <td>${expenseType(expense)}</td>
            <td>${expenseStatus(expense)}</td>
            <td>${escapeHtml(expense.paid_by_name)}</td>
            <td>${escapeHtml(expense.owner_name || '')}</td>
            <td class="right">${formatMoney(expense.amount)}</td>
            <td>${escapeHtml(expense.notes || '')}</td>
          </tr>
        `).join('')}
      </table>
    </body>
    </html>
  `;
}

function escapePdfText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function buildPdfLines(snapshot) {
  const lines = [
    `Cierre mensual ${snapshot.period}`,
    `Generado: ${snapshot.closedAt}`,
    '',
    `Total: ${formatMoney(snapshot.dashboard.totals.all)}`,
    `Pendiente: ${formatMoney(snapshot.dashboard.totals.pending)}`,
    `Pagado: ${formatMoney(snapshot.dashboard.totals.paid)}`,
    `Compartidos: ${formatMoney(snapshot.dashboard.totals.shared)}`,
    `Individuales: ${formatMoney(snapshot.dashboard.totals.individual)}`,
    '',
    'Personas',
  ];

  snapshot.dashboard.balances.forEach((user) => {
    lines.push(`${user.name}: le corresponde ${formatMoney(user.sharedOwed)} | asignado ${formatMoney(user.sharedAssigned)} | balance ${formatMoney(user.balance)}`);
  });

  lines.push('', 'Movimientos');

  snapshot.expenses.forEach((expense) => {
    lines.push(`${expense.expense_date} | ${expense.description} | ${expense.category} | ${expenseType(expense)} | ${expenseStatus(expense)} | ${formatMoney(expense.amount)}`);
  });

  return lines;
}

function generatePdfReport(snapshot) {
  const lines = buildPdfLines(snapshot);
  const pageHeight = 760;
  const lineHeight = 16;
  const pages = [];

  for (let index = 0; index < lines.length; index += 42) {
    const pageLines = lines.slice(index, index + 42);
    const text = [
      'BT',
      '/F1 10 Tf',
      '50 790 Td',
      ...pageLines.flatMap((line, lineIndex) => [
        lineIndex === 0 ? '' : `0 -${lineHeight} Td`,
        `(${escapePdfText(line).slice(0, 105)}) Tj`,
      ]).filter(Boolean),
      'ET',
    ].join('\n');

    pages.push(text);
  }

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const pageRefs = [];

  pages.forEach((content, index) => {
    const contentObjectNumber = objects.length + 1;
    const pageObjectNumber = objects.length + 2;
    const stream = `<< /Length ${Buffer.byteLength(content, 'utf8')} >>\nstream\n${content}\nendstream`;

    objects.push(stream);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjectNumber} 0 R >>`);
    pageRefs.push(`${pageObjectNumber} 0 R`);
  });

  objects[1] = `<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${pageRefs.length} >>`;

  const chunks = ['%PDF-1.4\n'];
  const offsets = [0];

  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(chunks.join(''), 'utf8'));
    chunks.push(`${index + 1} 0 obj\n${object}\nendobj\n`);
  });

  const xrefOffset = Buffer.byteLength(chunks.join(''), 'utf8');
  chunks.push(`xref\n0 ${objects.length + 1}\n`);
  chunks.push('0000000000 65535 f \n');
  offsets.slice(1).forEach((offset) => {
    chunks.push(`${String(offset).padStart(10, '0')} 00000 n \n`);
  });
  chunks.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

  return Buffer.from(chunks.join(''), 'utf8');
}

module.exports = {
  generateExcelReport,
  generatePdfReport,
};
