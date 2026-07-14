function toMoney(value) {
  return Number(value || 0);
}

function calculateDashboard(users, expenses) {
  const totalIncome = users.reduce((sum, user) => sum + toMoney(user.income), 0);
  const fallbackShare = users.length ? 1 / users.length : 0;
  const userMap = new Map();

  users.forEach((user) => {
    const share = totalIncome > 0 ? toMoney(user.income) / totalIncome : fallbackShare;

    userMap.set(user.id, {
      ...user,
      income: toMoney(user.income),
      share,
      sharedAssigned: 0,
      sharedPaid: 0,
      sharedOwed: 0,
      sharedPending: 0,
      sharedPendingToPay: 0,
      individualTotal: 0,
      individualPending: 0,
      totalPaid: 0,
    });
  });

  const totals = {
    paid: 0,
    pending: 0,
    shared: 0,
    individual: 0,
    all: 0,
  };

  expenses.forEach((expense) => {
    const amount = toMoney(expense.amount);
    const isPaid = expense.status === 'paid';
    totals.all += amount;
    totals[isPaid ? 'paid' : 'pending'] += amount;

    const payer = userMap.get(expense.paid_by);
    if (payer && isPaid) {
      payer.totalPaid += amount;
    }

    if (expense.type === 'shared') {
      totals.shared += amount;
      if (payer) {
        payer.sharedAssigned += amount;

        if (isPaid) {
          payer.sharedPaid += amount;
        } else {
          payer.sharedPendingToPay += amount;
        }
      }

      users.forEach((user) => {
        const participant = userMap.get(user.id);
        const userShare = amount * participant.share;

        participant.sharedOwed += userShare;

        if (!isPaid) {
          participant.sharedPending += userShare;
        }
      });
      return;
    }

    totals.individual += amount;
    const owner = userMap.get(expense.owner_id);
    if (owner) {
      if (isPaid) {
        owner.individualTotal += amount;
        return;
      }

      owner.individualPending += amount;
    }
  });

  const balances = Array.from(userMap.values()).map((user) => ({
    ...user,
    balance: user.sharedAssigned - user.sharedOwed,
    pendingBalance: user.sharedPendingToPay - user.sharedPending,
  }));

  const debtor = balances.find((user) => user.balance < -0.01);
  const creditor = balances.find((user) => user.balance > 0.01);
  const settlement = debtor && creditor
    ? {
        from: debtor.name,
        to: creditor.name,
        amount: Math.min(Math.abs(debtor.balance), creditor.balance),
      }
    : null;

  return {
    balances,
    settlement,
    totals,
  };
}

module.exports = {
  calculateDashboard,
};
