import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import {
  createExpensePayment, deleteExpensePayment, ExpensePaymentError,
  restoreExpensePayment, updateExpensePayment,
} from "../services/expensePaymentService";

const actor = (req: Request) => {
  const user = (req as any).user || {};
  return { id: String(user.id || user.username || user.email || "system"), name: user.name || user.fullName || user.username || user.email, role: user.role };
};
const canManage = (req: Request) => ["admin", "receptionist"].includes(String((req as any).user?.role || "").toLowerCase());
const param = (value: string | string[]) => Array.isArray(value) ? value[0] : value;
const serializePayment = (payment: any) => payment ? ({
  ...payment,
  date: payment.paymentDate,
  changedByName: payment.recordedByName || undefined,
  legacy: String(payment.transactionId || "").startsWith("legacy-expense:") || String(payment.id || "").includes("legacy"),
}) : payment;
const serializeMutation = (data: any) => data ? ({ ...data, payment: serializePayment(data.payment) }) : data;
const fail = (res: Response, error: unknown) => {
  if (error instanceof ExpensePaymentError) return res.status(error.status).json({ success: false, message: error.message });
  const code = (error as any)?.code;
  if (code === "P2002") return res.status(409).json({ success: false, message: "Transaction ID or idempotency key is already in use" });
  console.error("[EXPENSE PAYMENT]", error);
  return res.status(500).json({ success: false, message: "Expense payment operation failed", error: error instanceof Error ? error.message : "Unknown error" });
};

export const listExpensePayments = async (req: Request, res: Response) => {
  try {
    const includeDeleted = ["true", "1", "yes"].includes(String(req.query.includeDeleted || "").toLowerCase()) && canManage(req);
    const expenseId = param(req.params.expenseId);
    const expense = await prisma.detailedExpense.findUnique({ where: { id: expenseId } });
    if (!expense || (expense.deleted && !includeDeleted)) return res.status(404).json({ success: false, message: "Detailed expense not found" });
    const data = await prisma.expensePayment.findMany({
      where: { expenseId, ...(includeDeleted ? {} : { deleted: false }) },
      include: { logs: { orderBy: { changedAt: "desc" } } },
      orderBy: [{ paymentDate: "desc" }, { createdAt: "desc" }],
    });
    return res.json({ success: true, message: "Expense payments retrieved successfully", data: data.map(serializePayment) });
  } catch (error) { return fail(res, error); }
};

export const getExpensePayment = async (req: Request, res: Response) => {
  try {
    const data = await prisma.expensePayment.findUnique({ where: { id: param(req.params.paymentId) }, include: { logs: { orderBy: { changedAt: "desc" } } } });
    if (!data || (data.deleted && !canManage(req))) return res.status(404).json({ success: false, message: "Expense payment not found" });
    return res.json({ success: true, message: "Expense payment retrieved successfully", data: serializePayment(data) });
  } catch (error) { return fail(res, error); }
};

export const createExpensePaymentHandler = async (req: Request, res: Response) => {
  try {
    const data = await createExpensePayment(param(req.params.expenseId), req.body || {}, actor(req));
    res.setHeader("Deprecation", req.path.endsWith("/pay") ? "true" : "false");
    return res.status(data.idempotent ? 200 : 201).json({ success: true, message: "Expense payment recorded successfully", data: serializeMutation(data) });
  } catch (error) { return fail(res, error); }
};

export const updateExpensePaymentHandler = async (req: Request, res: Response) => {
  try { return res.json({ success: true, message: "Expense payment updated successfully", data: serializeMutation(await updateExpensePayment(param(req.params.paymentId), req.body || {}, actor(req))) }); }
  catch (error) { return fail(res, error); }
};

export const deleteExpensePaymentHandler = async (req: Request, res: Response) => {
  if (!canManage(req)) return res.status(403).json({ success: false, message: "Only admins and receptionists can delete expense payments" });
  try { return res.json({ success: true, message: "Expense payment deleted successfully", data: serializeMutation(await deleteExpensePayment(param(req.params.paymentId), actor(req))) }); }
  catch (error) { return fail(res, error); }
};

export const restoreExpensePaymentHandler = async (req: Request, res: Response) => {
  if (!canManage(req)) return res.status(403).json({ success: false, message: "Only admins and receptionists can restore expense payments" });
  try { return res.json({ success: true, message: "Expense payment restored successfully", data: serializeMutation(await restoreExpensePayment(param(req.params.paymentId), actor(req))) }); }
  catch (error) { return fail(res, error); }
};
