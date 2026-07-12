import { randomUUID } from "crypto";
import { prisma } from "../lib/prisma";

export type ExpensePaymentActor = { id: string; name?: string; role?: string };
export type ExpensePaymentInput = {
  amount: unknown;
  method?: unknown;
  paymentDate?: unknown;
  date?: unknown;
  transactionId?: unknown;
  notes?: unknown;
  idempotencyKey?: unknown;
  overpaymentPolicy?: "allow" | "increase_expense_price";
  adjustedPrice?: unknown;
};

export class ExpensePaymentError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const money = (value: unknown) => Math.round(Number(value) * 100) / 100;
const text = (value: unknown) => String(value ?? "").trim();
const dateOnly = (value: unknown) => {
  const raw = text(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = raw ? new Date(raw) : new Date();
  if (Number.isNaN(parsed.getTime())) throw new ExpensePaymentError(400, "Invalid payment date");
  return parsed.toISOString().slice(0, 10);
};
const json = (value: unknown) => JSON.parse(JSON.stringify(value ?? {}));
const actorData = (actor: ExpensePaymentActor) => ({
  recordedBy: actor.id || "system", recordedByName: actor.name || null, recordedByRole: actor.role || null,
});

const projectExpense = async (tx: any, expenseId: string) => {
  const expense = await tx.detailedExpense.findUnique({ where: { id: expenseId } });
  if (!expense) throw new ExpensePaymentError(404, "Detailed expense not found");
  const aggregate = await tx.expensePayment.aggregate({ where: { expenseId, deleted: false }, _sum: { amount: true } });
  const latest = await tx.expensePayment.findFirst({ where: { expenseId, deleted: false }, orderBy: [{ paymentDate: "desc" }, { createdAt: "desc" }] });
  const paid = money(aggregate._sum.amount || 0);
  const price = money(expense.price ?? expense.amount);
  const status = String(expense.status || "").toLowerCase() === "cancelled" ? "cancelled"
    : paid > price + 0.01 ? "overpaid" : paid >= price - 0.01 && price > 0 ? "paid" : paid > 0 ? "partial" : "pending";
  return tx.detailedExpense.update({ where: { id: expenseId }, data: {
    amount: paid, totalPaid: paid, balance: money(price - paid), status,
    paymentMethod: latest?.method || "", paymentDate: latest?.paymentDate || null,
  }});
};

const log = (tx: any, args: { paymentId: string; expenseId: string; type: string; before?: unknown; after?: unknown; actor: ExpensePaymentActor; delta?: number; notes?: string }) =>
  tx.expensePaymentLog.create({ data: {
    id: `expense_payment_log_${randomUUID()}`, paymentId: args.paymentId, expenseId: args.expenseId,
    changeType: args.type, previousState: json(args.before), newState: json(args.after),
    changedBy: args.actor.id || "system", changedByName: args.actor.name || null, changedByRole: args.actor.role || null,
    amountDelta: args.delta ?? null, notes: args.notes || null,
  }});

const parentLog = (tx: any, args: { expenseId: string; type: string; before: unknown; after: unknown; actor: ExpensePaymentActor; amount: number; notes: string }) =>
  tx.expenseLog.create({ data: {
    id: `exp_log_${randomUUID()}`, expenseId: args.expenseId, changeType: args.type,
    previousState: json(args.before), newState: json(args.after), changedBy: args.actor.id || "system",
    changedByName: args.actor.name || null, changedByRole: args.actor.role || null,
    amount: args.amount, notes: args.notes,
  }});

const transaction = <T>(fn: (tx: any) => Promise<T>) => prisma.$transaction(fn, { isolationLevel: "Serializable" as any });

export const createExpensePayment = (expenseId: string, input: ExpensePaymentInput, actor: ExpensePaymentActor) => transaction(async tx => {
  const amount = money(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new ExpensePaymentError(400, "Payment amount must be greater than zero");
  const idempotencyKey = text(input.idempotencyKey) || null;
  if (idempotencyKey) {
    const existing = await tx.expensePayment.findUnique({ where: { idempotencyKey } });
    if (existing) {
      if (existing.expenseId !== expenseId || money(existing.amount) !== amount) throw new ExpensePaymentError(409, "Idempotency key was already used for another payment");
      return { payment: existing, expense: await projectExpense(tx, expenseId), idempotent: true };
    }
  }
  const expense = await tx.detailedExpense.findUnique({ where: { id: expenseId } });
  if (!expense || expense.deleted) throw new ExpensePaymentError(404, "Detailed expense not found");
  if (String(expense.status).toLowerCase() === "cancelled") throw new ExpensePaymentError(400, "Cancelled expenses cannot receive payments");
  const paid = await tx.expensePayment.aggregate({ where: { expenseId, deleted: false }, _sum: { amount: true } });
  const projected = money((paid._sum.amount || 0) + amount);
  const price = money(expense.price ?? expense.amount);
  if (projected > price + 0.01 && input.overpaymentPolicy === "increase_expense_price") {
    const adjustedPrice = money(input.adjustedPrice);
    await tx.detailedExpense.update({ where: { id: expenseId }, data: { price: Number.isFinite(adjustedPrice) && adjustedPrice > 0 ? adjustedPrice : projected } });
  }
  const payment = await tx.expensePayment.create({ data: {
    id: `expense_payment_${randomUUID()}`, expenseId, amount, method: text(input.method) || "cash",
    paymentDate: dateOnly(input.paymentDate ?? input.date), transactionId: text(input.transactionId) || null,
    notes: text(input.notes) || null, idempotencyKey, ...actorData(actor), expenseSnapshot: json(expense),
  }});
  await log(tx, { paymentId: payment.id, expenseId, type: "create", after: payment, actor, delta: amount, notes: "Expense payment recorded" });
  const projectedExpense = await projectExpense(tx, expenseId);
  await parentLog(tx, { expenseId, type: "payment_create", before: expense, after: projectedExpense, actor, amount, notes: `Payment ${payment.id} recorded` });
  return { payment, expense: projectedExpense };
});

export const updateExpensePayment = (paymentId: string, input: Partial<ExpensePaymentInput>, actor: ExpensePaymentActor) => transaction(async tx => {
  const current = await tx.expensePayment.findUnique({ where: { id: paymentId } });
  if (!current) throw new ExpensePaymentError(404, "Expense payment not found");
  if (current.deleted) throw new ExpensePaymentError(400, "Deleted expense payments must be restored before editing");
  const amount = input.amount === undefined ? current.amount : money(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new ExpensePaymentError(400, "Payment amount must be greater than zero");
  const parent = await tx.detailedExpense.findUnique({ where: { id: current.expenseId } });
  if (!parent || parent.deleted || String(parent.status).toLowerCase() === "cancelled") throw new ExpensePaymentError(400, "This expense cannot be paid");
  const others = await tx.expensePayment.aggregate({ where: { expenseId: current.expenseId, deleted: false, id: { not: paymentId } }, _sum: { amount: true } });
  const projected = money((others._sum.amount || 0) + amount);
  const price = money(parent.price ?? parent.amount);
  if (projected > price + 0.01 && input.overpaymentPolicy === "increase_expense_price") {
    const adjustedPrice = money(input.adjustedPrice);
    await tx.detailedExpense.update({ where: { id: current.expenseId }, data: { price: Number.isFinite(adjustedPrice) && adjustedPrice > 0 ? adjustedPrice : projected } });
  }
  const updated = await tx.expensePayment.update({ where: { id: paymentId }, data: {
    amount, ...(input.method !== undefined && { method: text(input.method) || "cash" }),
    ...((input.paymentDate !== undefined || input.date !== undefined) && { paymentDate: dateOnly(input.paymentDate ?? input.date) }),
    ...(input.transactionId !== undefined && { transactionId: text(input.transactionId) || null }),
    ...(input.notes !== undefined && { notes: text(input.notes) || null }),
  }});
  const delta = money(amount - current.amount);
  await log(tx, { paymentId, expenseId: current.expenseId, type: "update", before: current, after: updated, actor, delta, notes: "Expense payment updated" });
  const projectedExpense = await projectExpense(tx, current.expenseId);
  await parentLog(tx, { expenseId: current.expenseId, type: "payment_update", before: parent, after: projectedExpense, actor, amount: delta, notes: `Payment ${paymentId} updated` });
  return { payment: updated, expense: projectedExpense };
});

export const deleteExpensePayment = (paymentId: string, actor: ExpensePaymentActor) => transaction(async tx => {
  const current = await tx.expensePayment.findUnique({ where: { id: paymentId } });
  if (!current) throw new ExpensePaymentError(404, "Expense payment not found");
  if (current.deleted) return { payment: current, expense: await projectExpense(tx, current.expenseId) };
  const parent = await tx.detailedExpense.findUnique({ where: { id: current.expenseId } });
  if (!parent || parent.deleted || String(parent.status).toLowerCase() === "cancelled") {
    throw new ExpensePaymentError(400, "Restore the active expense before deleting its payment");
  }
  const updated = await tx.expensePayment.update({ where: { id: paymentId }, data: { deleted: true, deletedAt: new Date(), deletedBy: actor.id, deletedByName: actor.name || null, deletedByRole: actor.role || null } });
  await log(tx, { paymentId, expenseId: current.expenseId, type: "delete", before: current, after: updated, actor, delta: -money(current.amount), notes: "Expense payment deleted" });
  const projectedExpense = await projectExpense(tx, current.expenseId);
  await parentLog(tx, { expenseId: current.expenseId, type: "payment_delete", before: parent, after: projectedExpense, actor, amount: -money(current.amount), notes: `Payment ${paymentId} deleted` });
  return { payment: updated, expense: projectedExpense };
});

export const restoreExpensePayment = (paymentId: string, actor: ExpensePaymentActor) => transaction(async tx => {
  const current = await tx.expensePayment.findUnique({ where: { id: paymentId } });
  if (!current) throw new ExpensePaymentError(404, "Expense payment not found");
  const parent = await tx.detailedExpense.findUnique({ where: { id: current.expenseId } });
  if (!parent || parent.deleted || String(parent.status).toLowerCase() === "cancelled") throw new ExpensePaymentError(400, "Restore the active expense before restoring its payment");
  if (!current.deleted) return { payment: current, expense: await projectExpense(tx, current.expenseId) };
  const updated = await tx.expensePayment.update({ where: { id: paymentId }, data: { deleted: false, deletedAt: null, deletedBy: null, deletedByName: null, deletedByRole: null } });
  await log(tx, { paymentId, expenseId: current.expenseId, type: "restore", before: current, after: updated, actor, delta: money(current.amount), notes: "Expense payment restored" });
  const projectedExpense = await projectExpense(tx, current.expenseId);
  await parentLog(tx, { expenseId: current.expenseId, type: "payment_restore", before: parent, after: projectedExpense, actor, amount: money(current.amount), notes: `Payment ${paymentId} restored` });
  return { payment: updated, expense: projectedExpense };
});

export const recomputeExpenseProjection = projectExpense;
