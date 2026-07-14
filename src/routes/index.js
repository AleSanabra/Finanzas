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

function getExpenseOrder(sort) {
  const orders = {
    category: 'expenses.category COLLATE NOCASE ASC, expenses.expense_date DESC, expenses.id DESC',
    date: 'expenses.expense_date DESC, expenses.id DESC',
    name: 'expenses.description COLLATE NOCASE ASC, expenses.expense_date DESC, expenses.id DESC',
  };

  return orders[sort] || orders.date;
}

async function getExpenses(sort = 'date') {
  return all(`
    SELECT
      expenses.*,
      payer.name AS paid_by_name,
      owner.name AS owner_name
    FROM expenses
    JOIN users AS payer ON payer.id = expenses.paid_by
    LEFT JOIN users AS owner ON owner.id = expenses.owner_id
    ORDER BY ${getExpenseOrder(sort)}
  `);
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
    const currentSort = ['name', 'date', 'category'].includes(req.query.sort) ? req.query.sort : 'date';
    const expenses = await getExpenses(currentSort);
    const dashboard = calculateDashboard(users, expenses);
    const closings = await getClosings();

    res.render('index', {
      closings,
      currentSort,
      dashboard,
      expenses,
      currentMonth: new Date().toISOString().slice(0, 7),
      today: new Date().toISOString().slice(0, 10),
      users,
    });
  } catch (err) {
    next(err);
  }
});

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

    await run(
      `
        INSERT INTO expenses
          (description, amount, category, expense_date, type, paid_by, owner_id, status, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `,
      [
        (req.body.description || '').trim(),
        asAmount(req.body.amount),
        (req.body.category || 'General').trim() || 'General',
        req.body.expense_date || new Date().toISOString().slice(0, 10),
        type,
        Number(req.body.paid_by),
        ownerId,
        (req.body.notes || '').trim(),
      ],
    );

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

    await run(
      `
        UPDATE expenses
        SET
          description = ?,
          amount = ?,
          category = ?,
          expense_date = ?,
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
        req.body.expense_date || new Date().toISOString().slice(0, 10),
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
