const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dataDir = path.join(__dirname, '..', '..', 'data');
const dbPath = path.join(dataDir, 'finanzas.sqlite');

fs.mkdirSync(dataDir, { recursive: true });

const db = new sqlite3.Database(dbPath);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }

      resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(rows);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(row);
    });
  });
}

async function initDb() {
  await run('PRAGMA foreign_keys = ON');

  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      income REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      category TEXT NOT NULL DEFAULT 'General',
      expense_date TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('shared', 'individual')),
      paid_by INTEGER NOT NULL,
      owner_id INTEGER,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
      paid_at TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (paid_by) REFERENCES users(id),
      FOREIGN KEY (owner_id) REFERENCES users(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS monthly_closings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period TEXT NOT NULL UNIQUE,
      closed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      data TEXT NOT NULL
    )
  `);

  const expenseColumns = await all('PRAGMA table_info(expenses)');
  const columnNames = expenseColumns.map((column) => column.name);

  if (!columnNames.includes('status')) {
    await run("ALTER TABLE expenses ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
  }

  if (!columnNames.includes('paid_at')) {
    await run('ALTER TABLE expenses ADD COLUMN paid_at TEXT');
  }

  const row = await get('SELECT COUNT(*) AS total FROM users');

  if (row.total === 0) {
    await run('INSERT INTO users (name, income) VALUES (?, ?)', ['Persona 1', 0]);
    await run('INSERT INTO users (name, income) VALUES (?, ?)', ['Persona 2', 0]);
  }
}

module.exports = {
  all,
  db,
  get,
  initDb,
  run,
};
