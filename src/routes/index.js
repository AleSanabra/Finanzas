const express = require('express');
const router = express.Router();
const { all, get, run } = require('../config/database');
const { calculateDashboard } = require('../helpers/finance');
const { generateExcelReport, generatePdfReport } = require('../helpers/reports');

function asAmount(value) {
  const amount = Number(String(value || '').replace(',', '.'));
  return Number.isFinite(amount) && amount >= 0 ? amount : 0;
}

function redirectAfterAction(req, res) {
  const redirectTo = req.body.redirect_to;

  if (redirectTo && redirectTo.startsWith('/')) {
    res.redirect(redirectTo);
    return;
  }

  res.redirect('/');
}

async function getUsers() {
  return all('SELECT * FROM users ORDER BY id ASC LIMIT 2');
}

function currentPeriod() {
  return new Date().toISOString().slice(0, 7);
}

function addMonthsToPeriod(period, months) {
  const [year, month] = period.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1 + months, 1));

  return date.toISOString().slice(0, 7);
}

function dateForPeriod(originalDate, period) {
  const day = Number(String(originalDate || '').slice(8, 10)) || 1;
  const [year, month] = period.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

  return `${period}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

function expenseDuration(value) {
  return ['occasional', 'persistent', 'installment'].includes(value) ? value : 'persistent';
}

function asInstallments(value) {
  const installments = Number.parseInt(value, 10);

  return Number.isFinite(installments) && installments > 0 ? installments : 1;
}

function getExpenseOrder(sort) {
  const orders = {
    category: 'expenses.category COLLATE NOCASE ASC, expenses.expense_date DESC, expenses.id DESC',
    date: 'expenses.expense_date DESC, expenses.id DESC',
    name: 'expenses.description COLLATE NOCASE ASC, expenses.expense_date DESC, expenses.id DESC',
    responsible: 'payer.name COLLATE NOCASE ASC, expenses.description COLLATE NOCASE ASC, expenses.expense_date DESC, expenses.id DESC',
  };

  return orders[sort] || orders.name;
}

async function getExpenses(sort = 'name', period = currentPeriod()) {
  await ensurePersistentExpenses(period);

  return all(`
    SELECT
      expenses.*,
      payer.name AS paid_by_name,
      owner.name AS owner_name
    FROM expenses
    JOIN users AS payer ON payer.id = expenses.paid_by
    LEFT JOIN users AS owner ON owner.id = expenses.owner_id
    WHERE expenses.is_active = 1
      AND substr(expenses.expense_date, 1, 7) = ?
    ORDER BY ${getExpenseOrder(sort)}
  `, [period]);
}

async function ensurePersistentExpenses(period) {
  await run(
    `
      UPDATE expenses
      SET
        is_active = 0,
        inactive_from_period = ?
      WHERE is_active = 1
        AND duration_type IN ('occasional', 'installment')
        AND substr(expense_date, 1, 7) < ?
    `,
    [period, period],
  );

  const persistentExpenses = await all(`
    SELECT
      expenses.*
    FROM expenses
    WHERE expenses.is_active = 1
      AND expenses.duration_type = 'persistent'
      AND substr(expenses.expense_date, 1, 7) < ?
  `, [period]);

  await Promise.all(persistentExpenses.map(async (expense) => {
    const seriesId = expense.series_id || expense.id;
    const expensePeriod = String(expense.expense_date || '').slice(0, 7);
    let nextPeriod = addMonthsToPeriod(expensePeriod, 1);

    while (nextPeriod <= period) {
      const existing = await get(`
        SELECT id
        FROM expenses
        WHERE COALESCE(series_id, id) = ?
          AND substr(expense_date, 1, 7) = ?
        LIMIT 1
      `, [seriesId, nextPeriod]);

      if (!existing) {
        const isCurrentPeriod = nextPeriod === period;

        await run(
          `
            INSERT INTO expenses
              (description, amount, category, expense_date, active_from_period, inactive_from_period, type, paid_by, owner_id, status, is_active, duration_type, series_id, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 'persistent', ?, ?)
          `,
          [
            expense.description,
            expense.amount,
            expense.category,
            dateForPeriod(expense.expense_date, nextPeriod),
            nextPeriod,
            isCurrentPeriod ? null : addMonthsToPeriod(nextPeriod, 1),
            expense.type,
            expense.paid_by,
            expense.owner_id,
            isCurrentPeriod ? 1 : 0,
            seriesId,
            expense.notes,
          ],
        );
      }

      nextPeriod = addMonthsToPeriod(nextPeriod, 1);
    }

    await run(
      `
        UPDATE expenses
        SET
          is_active = 0,
          inactive_from_period = ?
        WHERE id = ?
      `,
      [addMonthsToPeriod(expensePeriod, 1), expense.id],
    );
  }));
}

async function getExpensesByPeriod(period) {
  return all(`
    SELECT
      expenses.*,
      payer.name AS paid_by_name,
      owner.name AS owner_name
    FROM expenses
    JOIN users AS payer ON payer.id = expenses.paid_by
    LEFT JOIN users AS owner ON owner.id = expenses.owner_id
    WHERE substr(expenses.expense_date, 1, 7) = ?
    ORDER BY expenses.expense_date ASC, expenses.id ASC
  `, [period]);
}

async function getClosings() {
  return all('SELECT id, period, closed_at FROM monthly_closings ORDER BY period DESC');
}

async function getHistoryPeriods() {
  return all(`
    SELECT
      substr(expense_date, 1, 7) AS period,
      COUNT(*) AS total_expenses,
      SUM(amount) AS total_amount
    FROM expenses
    WHERE substr(expense_date, 1, 7) < ?
    GROUP BY period
    ORDER BY period DESC
  `, [currentPeriod()]);
}

function parseClosing(row) {
  return {
    ...row,
    data: JSON.parse(row.data),
  };
}

function reportFilename(snapshot, extension) {
  return `cierre-${snapshot.period}.${extension}`;
}

function getPersonDetail(person, expenses) {
  const sharedExpenses = expenses.filter((expense) => expense.type === 'shared');
  const assignedShared = sharedExpenses.filter((expense) => Number(expense.paid_by) === Number(person.id));
  const individualExpenses = expenses.filter((expense) => Number(expense.owner_id) === Number(person.id));
  const isResponsibleExpense = (expense) => (
    Number(expense.paid_by) === Number(person.id)
    || (expense.type === 'individual' && Number(expense.owner_id) === Number(person.id))
  );
  const relatedExpenses = expenses
    .filter((expense) => (
      expense.type === 'shared'
      || Number(expense.paid_by) === Number(person.id)
      || Number(expense.owner_id) === Number(person.id)
    ))
    .map((expense) => {
      const amount = Number(expense.amount || 0);
      const isShared = expense.type === 'shared';
      let role = 'Participa';
      let personAmount = isShared ? amount * person.share : 0;

      if (isShared && Number(expense.paid_by) === Number(person.id)) {
        role = 'Responsable de pago';
      }

      if (!isShared && Number(expense.owner_id) === Number(person.id)) {
        role = 'Gasto individual';
        personAmount = amount;
      }

      if (!isShared && Number(expense.owner_id) !== Number(person.id) && Number(expense.paid_by) === Number(person.id)) {
        role = 'Pago individual de otra persona';
        personAmount = amount;
      }

      return {
        ...expense,
        personAmount,
        role,
      };
    });

  const byCategory = relatedExpenses.reduce((categories, expense) => {
    const category = expense.category || 'General';
    const current = categories.get(category) || { category, paid: 0, pending: 0, total: 0 };
    const amount = Number(expense.personAmount || 0);

    current.total += amount;
    current[expense.status === 'paid' ? 'paid' : 'pending'] += amount;
    categories.set(category, current);

    return categories;
  }, new Map());

  return {
    assignedSharedCount: assignedShared.length,
    categories: Array.from(byCategory.values()).sort((a, b) => b.total - a.total),
    individualCount: individualExpenses.length,
    relatedExpenses,
    responsibleExpenses: relatedExpenses
      .filter(isResponsibleExpense)
      .sort((a, b) => (
        (a.category || 'General').localeCompare(b.category || 'General', 'es', { sensitivity: 'base' })
        || (b.expense_date || '').localeCompare(a.expense_date || '')
        || Number(b.id || 0) - Number(a.id || 0)
      )),
    sharedCount: sharedExpenses.length,
  };
}

router.get('/', async (req, res, next) => {
  try {
    const users = await getUsers();
    const currentSort = ['name', 'category', 'responsible'].includes(req.query.sort) ? req.query.sort : 'name';
    const expenses = await getExpenses(currentSort);
    const dashboard = calculateDashboard(users, expenses);
    const closings = await getClosings();

    res.render('index', {
      closings,
      currentSort,
      dashboard,
      expenses,
      currentMonth: currentPeriod(),
      today: new Date().toISOString().slice(0, 10),
      users,
    });
  } catch (err) {
    next(err);
  }
});

async function renderHistory(req, res, next) {
  try {
    await ensurePersistentExpenses(currentPeriod());

    const users = await getUsers();
    const periods = await getHistoryPeriods();
    const requestedPeriod = /^\d{4}-\d{2}$/.test(req.params.period || '') ? req.params.period : null;
    const selectedPeriod = requestedPeriod || (periods[0] && periods[0].period);
    const expenses = selectedPeriod ? await getExpensesByPeriod(selectedPeriod) : [];
    const dashboard = calculateDashboard(users, expenses);
    const closing = selectedPeriod
      ? await get('SELECT id, period, closed_at FROM monthly_closings WHERE period = ?', [selectedPeriod])
      : null;

    res.render('history', {
      closing,
      dashboard,
      expenses,
      periods,
      selectedPeriod,
    });
  } catch (err) {
    next(err);
  }
}

router.get('/historial', renderHistory);
router.get('/historial/:period', renderHistory);

router.get('/personas/:id', async (req, res, next) => {
  try {
    const users = await getUsers();
    const expenses = await getExpenses('date');
    const dashboard = calculateDashboard(users, expenses);
    const person = dashboard.balances.find((user) => Number(user.id) === Number(req.params.id));

    if (!person) {
      res.status(404).render('error', {
        message: 'No encontramos esa persona.',
      });
      return;
    }

    const otherPerson = dashboard.balances.find((user) => Number(user.id) !== Number(person.id));
    const detail = getPersonDetail(person, expenses);

    res.render('person', {
      detail,
      expenses,
      otherPerson,
      person,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/closings', async (req, res, next) => {
  try {
    const period = /^\d{4}-\d{2}$/.test(req.body.period || '') ? req.body.period : new Date().toISOString().slice(0, 7);
    const users = await getUsers();
    const expenses = await getExpensesByPeriod(period);
    const dashboard = calculateDashboard(users, expenses);
    const snapshot = {
      closedAt: new Date().toISOString(),
      dashboard,
      expenses,
      period,
      users,
    };

    await run(
      `
        INSERT INTO monthly_closings (period, closed_at, data)
        VALUES (?, CURRENT_TIMESTAMP, ?)
        ON CONFLICT(period) DO UPDATE SET
          closed_at = CURRENT_TIMESTAMP,
          data = excluded.data
      `,
      [period, JSON.stringify(snapshot)],
    );

    res.redirect('/#cierres');
  } catch (err) {
    next(err);
  }
});

router.get('/closings/:id/report.xls', async (req, res, next) => {
  try {
    const closing = await get('SELECT * FROM monthly_closings WHERE id = ?', [req.params.id]);

    if (!closing) {
      res.status(404).render('error', {
        message: 'No encontramos ese cierre.',
      });
      return;
    }

    const snapshot = parseClosing(closing).data;
    const report = generateExcelReport(snapshot);

    res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${reportFilename(snapshot, 'xls')}"`);
    res.send(report);
  } catch (err) {
    next(err);
  }
});

router.get('/closings/:id/report.pdf', async (req, res, next) => {
  try {
    const closing = await get('SELECT * FROM monthly_closings WHERE id = ?', [req.params.id]);

    if (!closing) {
      res.status(404).render('error', {
        message: 'No encontramos ese cierre.',
      });
      return;
    }

    const snapshot = parseClosing(closing).data;
    const report = generatePdfReport(snapshot);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${reportFilename(snapshot, 'pdf')}"`);
    res.send(report);
  } catch (err) {
    next(err);
  }
});

router.post('/users', async (req, res, next) => {
  try {
    const users = await getUsers();

    await Promise.all(users.map((user) => run(
      'UPDATE users SET name = ?, income = ? WHERE id = ?',
      [
        (req.body[`name_${user.id}`] || user.name).trim() || user.name,
        asAmount(req.body[`income_${user.id}`]),
        user.id,
      ],
    )));

    res.redirect('/');
  } catch (err) {
    next(err);
  }
});

router.post('/expenses', async (req, res, next) => {
  try {
    const type = req.body.type === 'individual' ? 'individual' : 'shared';
    const ownerId = type === 'individual' ? Number(req.body.owner_id) : null;
    const expenseDate = req.body.expense_date || new Date().toISOString().slice(0, 10);
    const durationType = expenseDuration(req.body.duration_type);
    const startPeriod = expenseDate.slice(0, 7);
    const installmentsTotal = durationType === 'installment' ? asInstallments(req.body.installments_total) : null;
    const baseExpense = [
      (req.body.description || '').trim(),
      asAmount(req.body.amount),
      (req.body.category || 'General').trim() || 'General',
      type,
      Number(req.body.paid_by),
      ownerId,
      (req.body.notes || '').trim(),
    ];

    if (durationType === 'installment') {
      let seriesId = null;

      for (let index = 0; index < installmentsTotal; index += 1) {
        const period = addMonthsToPeriod(startPeriod, index);
        const result = await run(
          `
            INSERT INTO expenses
              (description, amount, category, expense_date, active_from_period, type, paid_by, owner_id, status, is_active, duration_type, series_id, installment_number, installments_total, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, 'installment', ?, ?, ?, ?)
          `,
          [
            baseExpense[0],
            baseExpense[1],
            baseExpense[2],
            dateForPeriod(expenseDate, period),
            period,
            baseExpense[3],
            baseExpense[4],
            baseExpense[5],
            seriesId,
            index + 1,
            installmentsTotal,
            baseExpense[6],
          ],
        );

        if (!seriesId) {
          seriesId = result.id;
          await run('UPDATE expenses SET series_id = ? WHERE id = ?', [seriesId, result.id]);
        }
      }

      res.redirect('/');
      return;
    }

    const result = await run(
      `
        INSERT INTO expenses
          (description, amount, category, expense_date, active_from_period, type, paid_by, owner_id, status, is_active, duration_type, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?)
      `,
      [
        baseExpense[0],
        baseExpense[1],
        baseExpense[2],
        expenseDate,
        startPeriod,
        baseExpense[3],
        baseExpense[4],
        baseExpense[5],
        durationType,
        baseExpense[6],
      ],
    );

    await run('UPDATE expenses SET series_id = ? WHERE id = ?', [result.id, result.id]);

    res.redirect('/');
  } catch (err) {
    next(err);
  }
});

router.post('/expenses/:id/pay', async (req, res, next) => {
  try {
    await run(
      "UPDATE expenses SET status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE id = ?",
      [req.params.id],
    );
    redirectAfterAction(req, res);
  } catch (err) {
    next(err);
  }
});

router.post('/expenses/:id/edit', async (req, res, next) => {
  try {
    const type = req.body.type === 'individual' ? 'individual' : 'shared';
    const ownerId = type === 'individual' ? Number(req.body.owner_id) : null;
    const status = req.body.status === 'paid' ? 'paid' : 'pending';
    const expenseDate = req.body.expense_date || new Date().toISOString().slice(0, 10);

    await run(
      `
        UPDATE expenses
        SET
          description = ?,
          amount = ?,
          category = ?,
          expense_date = ?,
          active_from_period = ?,
          type = ?,
          paid_by = ?,
          owner_id = ?,
          status = ?,
          paid_at = CASE WHEN ? = 'paid' THEN COALESCE(paid_at, CURRENT_TIMESTAMP) ELSE NULL END,
          notes = ?
        WHERE id = ?
      `,
      [
        (req.body.description || '').trim(),
        asAmount(req.body.amount),
        (req.body.category || 'General').trim() || 'General',
        expenseDate,
        expenseDate.slice(0, 7),
        type,
        Number(req.body.paid_by),
        ownerId,
        status,
        status,
        (req.body.notes || '').trim(),
        req.params.id,
      ],
    );

    res.redirect('/');
  } catch (err) {
    next(err);
  }
});

router.post('/expenses/:id/deactivate', async (req, res, next) => {
  try {
    await run(
      `
        UPDATE expenses
        SET
          is_active = 0,
          inactive_from_period = ?
        WHERE id = ?
      `,
      [currentPeriod(), req.params.id],
    );
    redirectAfterAction(req, res);
  } catch (err) {
    next(err);
  }
});

router.post('/expenses/:id/pending', async (req, res, next) => {
  try {
    await run(
      "UPDATE expenses SET status = 'pending', paid_at = NULL WHERE id = ?",
      [req.params.id],
    );
    redirectAfterAction(req, res);
  } catch (err) {
    next(err);
  }
});

router.post('/expenses/:id/delete', async (req, res, next) => {
  try {
    await run('DELETE FROM expenses WHERE id = ?', [req.params.id]);
    res.redirect('/');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
