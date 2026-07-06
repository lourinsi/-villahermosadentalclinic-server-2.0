import { Request, Response } from "express";
import {
  FinanceRecord,
  ApiResponse,
  Revenue,
  ExpenseBreakdown,
  DetailedExpense,
  FinanceHistoryLog,
  RecurringExpense,
  Payroll,
  RecentTransaction,
} from "../types/finance";
import { prisma } from "../lib/prisma";
import { getAppointmentTypeName } from "../utils/appointment-types";
import {
  createFinanceHistoryLog,
  findFinanceHistoryLogs,
  getFinanceHistoryActor,
  type FinanceHistoryEntityType,
} from "../utils/financeHistoryLogs";

const toFinanceRecord = (record: unknown): FinanceRecord => record as FinanceRecord;
const toDetailedExpense = (expense: unknown): DetailedExpense => expense as DetailedExpense;
const toFinanceHistoryLog = (log: unknown): FinanceHistoryLog => log as FinanceHistoryLog;
type IdParams = { id: string };
const EXPENSE_COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899"];

const toFiniteNumber = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const normalizeDate = (value: unknown) => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
};

const dateKey = (date: Date) => {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
};

const dateOnlyKey = (value: unknown) => {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  const parsed = normalizeDate(text);
  return parsed ? dateKey(parsed) : "";
};

const monthKey = (date: Date) => {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${date.getFullYear()}-${month}`;
};

const monthLabel = (key: string) => {
  const [year, month] = key.split("-").map(Number);
  if (!year || !month) return key;
  return new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric" }).format(
    new Date(year, month - 1, 1)
  );
};

const recentMonthKeys = (count = 6) => {
  const now = new Date();
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - (count - 1 - index), 1);
    return monthKey(date);
  });
};

const getRecordDate = (record: { date?: string | null; createdAt?: Date | null; updatedAt?: Date | null }) =>
  normalizeDate(record.date) || normalizeDate(record.createdAt) || normalizeDate(record.updatedAt);

const isIncomeType = (type: unknown) => {
  const normalized = String(type || "").toLowerCase();
  return ["payment", "income", "revenue"].includes(normalized);
};

const isChargeType = (type: unknown) => {
  const normalized = String(type || "").toLowerCase();
  return ["charge", "invoice", "service"].includes(normalized);
};

const isExpenseType = (type: unknown) => {
  const normalized = String(type || "").toLowerCase();
  return ["expense", "refund", "payroll"].includes(normalized);
};

const normalizeMethod = (method?: string | null) => {
  const value = String(method || "").trim();
  return value || "Clinic record";
};

const nextMonthlyDueDate = (dateValue: string) => {
  const date = normalizeDate(dateValue) || new Date();
  return dateKey(new Date(date.getFullYear(), date.getMonth() + 1, date.getDate()));
};

const normalizeCodeValue = (value?: string | null) =>
  String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");

type ExpenseStatus = "pending" | "paid" | "cancelled";

const normalizeExpenseStatus = (value?: unknown): ExpenseStatus => {
  const normalized = normalizeCodeValue(String(value || ""));
  if (["paid", "settled", "complete", "completed"].includes(normalized)) return "paid";
  if (["cancelled", "canceled", "void", "voided"].includes(normalized)) return "cancelled";
  return "pending";
};

const isCancelledExpense = (expense: { status?: string | null }) =>
  normalizeExpenseStatus(expense.status) === "cancelled";

const canViewDeletedPaymentRows = (req: Request) => {
  const role = String((req as any).user?.role || "").toLowerCase();
  return role === "admin" || role === "doctor";
};

const SALARY_RECORD_TYPES = new Set(["salary", "payroll", "monthlysalary"]);
const MANAGED_PAYROLL_ADJUSTMENT_TYPE = "payroll_adjustment";
const PAYROLL_ADJUSTMENT_TYPES = new Set([
  "bonus",
  "commission",
  "overtime",
  "allowance",
  "deduction",
  "salaryadjustment",
  "salaryreduction",
  "payrolladjustment",
]);

const isSalaryRecord = (record: { type?: string | null }) =>
  SALARY_RECORD_TYPES.has(normalizeCodeValue(record.type));

const isManagedPayrollAdjustmentRecord = (record: { type?: string | null }) =>
  normalizeCodeValue(record.type) === normalizeCodeValue(MANAGED_PAYROLL_ADJUSTMENT_TYPE);

const isPayrollAdjustmentRecord = (record: { type?: string | null; status?: string | null }) => {
  const normalizedStatus = normalizeCodeValue(record.status);
  if (["cancelled", "canceled", "void", "voided"].includes(normalizedStatus)) return false;
  return PAYROLL_ADJUSTMENT_TYPES.has(normalizeCodeValue(record.type));
};

const normalizePayrollMonth = (value?: unknown) => {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}$/.test(text) ? text : monthKey(new Date());
};

const isRecordInPayrollMonth = (record: { date?: string | null }, payrollMonth: string) =>
  String(record.date || "").startsWith(`${payrollMonth}-`);

const resolvePayrollDate = (value: unknown, payrollMonth: string) => {
  const requestedDate = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) && requestedDate.startsWith(`${payrollMonth}-`)
    ? requestedDate
    : `${payrollMonth}-01`;
};

const createStaffFinancialRecordId = () =>
  `staff_fin_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

const extractPaymentId = (description?: string | null) => {
  const match = String(description || "").match(/\bPayment\s+(pay_[A-Za-z0-9_-]+)/i);
  return match?.[1] || null;
};

const extractAppointmentId = (description?: string | null) => {
  const text = String(description || "");
  const appointmentMatch = text.match(/\bappointment\s+([A-Za-z0-9_-]+)/i);
  if (appointmentMatch?.[1]) return appointmentMatch[1];

  const idMatch = text.match(/\bapt_[A-Za-z0-9_-]+/i);
  return idMatch?.[0] || null;
};

const extractAppointmentIdFromSnapshot = (snapshot: any) =>
  snapshot?.id || snapshot?.appointmentId || snapshot?._id || null;

const normalizeLookupText = (value?: string | null) =>
  String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");

const extractServiceNameFromDescription = (description?: string | null) => {
  const text = String(description || "").trim();
  const paymentMatch = text.match(/^payment\s+for\s+(.+)$/i);
  if (paymentMatch?.[1]) return paymentMatch[1].trim();

  const chargeMatch = text.match(/^(.+?)\s+charge$/i);
  if (chargeMatch?.[1]) return chargeMatch[1].trim();

  return null;
};

const getAppointmentServiceName = (appointment: any) =>
  appointment?.customType ||
  appointment?.serviceType ||
  getAppointmentTypeName(Number(appointment?.type), appointment?.customType);

const findAppointmentForFinanceRecord = (
  record: {
    patientId?: string | null;
    date?: string | null;
    description?: string | null;
    amount?: number | null;
  },
  appointments: any[]
) => {
  const serviceName = extractServiceNameFromDescription(record.description);
  if (!serviceName || !record.date) return null;

  const normalizedServiceName = normalizeLookupText(serviceName);
  const matches = appointments.filter((appointment) => {
    if (!appointment || appointment.deleted) return false;
    if (record.patientId && appointment.patientId !== record.patientId) return false;
    if (appointment.date !== record.date) return false;

    return normalizeLookupText(getAppointmentServiceName(appointment)) === normalizedServiceName;
  });

  if (matches.length === 1) return matches[0];

  const amount = toFiniteNumber(record.amount);
  if (amount <= 0) return null;

  const amountMatches = matches.filter((appointment) => {
    const price = toFiniteNumber(appointment.price) - toFiniteNumber(appointment.discount);
    const totalPaid = toFiniteNumber(appointment.totalPaid);

    return amount === price || amount === totalPaid;
  });

  return amountMatches.length === 1 ? amountMatches[0] : null;
};

const getTransactionTime = (transaction: { logDate?: string; date?: string }) =>
  normalizeDate(transaction.logDate || transaction.date)?.getTime() || 0;

const isSamePaymentEvent = (
  a: { appointmentId?: string; amount?: number; logDate?: string; date?: string },
  b: { appointmentId?: string; amount?: number; logDate?: string; date?: string }
) => {
  if (!a.appointmentId || !b.appointmentId || a.appointmentId !== b.appointmentId) return false;
  if (Math.abs(toFiniteNumber(a.amount) - toFiniteNumber(b.amount)) > 0.01) return false;

  const aTime = getTransactionTime(a);
  const bTime = getTransactionTime(b);
  if (!aTime || !bTime) return false;

  return Math.abs(aTime - bTime) <= 10000;
};

const isSamePaymentLogSource = (
  logTransaction: { id?: string; appointmentId?: string; logDate?: string; date?: string },
  representedPayment: { appointmentId?: string; transactionId?: string | null; logDate?: string; date?: string }
) => {
  if (!logTransaction.appointmentId || !representedPayment.appointmentId) return false;
  if (logTransaction.appointmentId !== representedPayment.appointmentId) return false;

  if (
    logTransaction.id &&
    representedPayment.transactionId &&
    logTransaction.id === representedPayment.transactionId
  ) {
    return true;
  }

  const logTime = getTransactionTime(logTransaction);
  const paymentTime = getTransactionTime(representedPayment);
  if (!logTime || !paymentTime) return false;

  return Math.abs(logTime - paymentTime) <= 10000;
};

const toIsoDate = (value: unknown) => {
  const date = normalizeDate(value);
  return date ? date.toISOString() : undefined;
};

const historyStateKey = (value: unknown) => JSON.stringify(value || {});

const payrollStateChanged = (previousState: unknown, newState: unknown) =>
  historyStateKey(previousState) !== historyStateKey(newState);

const buildFinanceHistoryResponse = (log: any): FinanceHistoryLog => ({
  ...toFinanceHistoryLog(log),
  context: log.context || undefined,
  changedByName: log.changedByName || undefined,
  changedByRole: log.changedByRole || undefined,
  changedAt: toIsoDate(log.changedAt),
  summary: log.summary || undefined,
});

const buildDetailedExpenseResponse = (expense: any): DetailedExpense => ({
  ...toDetailedExpense(expense),
  amount: toFiniteNumber(expense.amount),
  vendor: expense.vendor || "",
  paymentMethod: expense.paymentMethod || "",
  status: normalizeExpenseStatus(expense.status),
  paymentDate: expense.paymentDate || undefined,
  createdAt: toIsoDate(expense.createdAt),
  updatedAt: toIsoDate(expense.updatedAt),
  deleted: Boolean(expense.deleted),
  deletedAt: toIsoDate(expense.deletedAt),
  inventoryItemId: expense.inventoryItemId || "",
  inventoryQuantity: toFiniteNumber(expense.inventoryQuantity),
});

const activeDetailedExpenseWhere = { deleted: false };

export const createFinanceRecord = async (
  req: Request,
  res: Response<ApiResponse<FinanceRecord>>
) => {
  try {
    const financeData: FinanceRecord = req.body;

    if (!financeData.type || !financeData.amount || !financeData.date) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: type, amount, date",
      });
    }

    const newRecord = toFinanceRecord(
      await prisma.financeRecord.create({
        data: {
          id: `fin_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
          patientId: financeData.patientId || null,
          type: financeData.type,
          amount: Number(financeData.amount),
          date: financeData.date,
          description: financeData.description || "",
          createdAt: new Date(),
          updatedAt: new Date(),
          deleted: false,
        },
      })
    );

    res.status(201).json({
      success: true,
      message: "Finance record added successfully",
      data: newRecord,
    });
  } catch (error) {
    console.error("[FINANCE CREATE] ERROR:", error);
    res.status(500).json({
      success: false,
      message: "Error adding finance record",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const getFinanceHistoryLogs = async (
  req: Request<{ entityType: string; entityId?: string }>,
  res: Response<ApiResponse<FinanceHistoryLog[]>>
) => {
  try {
    const entityType = String(req.params.entityType || "").trim();
    const entityId = String(req.params.entityId || req.query.entityId || "").trim();
    const context = String(req.query.context || req.query.month || "").trim();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
    const validEntityTypes = new Set(["expense", "inventory", "payroll"]);

    if (!validEntityTypes.has(entityType)) {
      return res.status(400).json({
        success: false,
        message: "Invalid finance history entity type",
      });
    }

    const logs = await findFinanceHistoryLogs(prisma, {
      entityType: entityType as FinanceHistoryEntityType,
      entityId,
      context,
      limit,
    });

    res.json({
      success: true,
      message: "Finance history logs retrieved successfully",
      data: logs.map(buildFinanceHistoryResponse),
    });
  } catch (error) {
    console.error("[FINANCE HISTORY] Error fetching finance history logs:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching finance history logs",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const createDetailedExpense = async (
  req: Request,
  res: Response<ApiResponse<DetailedExpense>>
) => {
  try {
    const expenseData: DetailedExpense = req.body;

    if (!expenseData.category || !expenseData.description || !expenseData.amount || !expenseData.date) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: category, description, amount, date",
      });
    }

    const inventoryItemId = String(expenseData.inventoryItemId || "").trim();
    const inventoryQuantity = toFiniteNumber(expenseData.inventoryQuantity);
    if (inventoryItemId && inventoryQuantity <= 0) {
      return res.status(400).json({
        success: false,
        message: "Inventory quantity must be greater than zero when linking stock",
      });
    }

    const requesterRole = normalizeCodeValue((req as any).user?.role);
    const canSetInitialExpenseStatus = requesterRole === "admin";
    const initialExpenseStatus = canSetInitialExpenseStatus
      ? normalizeExpenseStatus(expenseData.status)
      : "pending";

    if (inventoryItemId && initialExpenseStatus === "cancelled") {
      return res.status(400).json({
        success: false,
        message: "Linked stock expenses must be pending or paid",
      });
    }

    const expenseCreateData = {
      id: `exp_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      date: expenseData.date,
      category: expenseData.category,
      description: expenseData.description,
      amount: Number(expenseData.amount),
      vendor: expenseData.vendor || "",
      paymentMethod:
        initialExpenseStatus === "paid"
          ? expenseData.paymentMethod || "cash"
          : expenseData.paymentMethod || "",
      paymentDate: initialExpenseStatus === "paid" ? expenseData.date : null,
      status: initialExpenseStatus,
      recurring: Boolean(expenseData.recurring),
      createdAt: new Date(),
      inventoryItemId: inventoryItemId || null,
      inventoryQuantity: inventoryItemId ? inventoryQuantity : null,
    };

    const actor = getFinanceHistoryActor(req);
    const newExpense = toDetailedExpense(
      await prisma.$transaction(async (tx) => {
        const inventoryItem = inventoryItemId
          ? await tx.inventoryItem.findUnique({
              where: { id: inventoryItemId },
            })
          : null;

        if (inventoryItemId && (!inventoryItem || inventoryItem.deleted)) {
          throw new Error("Linked inventory item not found");
        }

        const createdExpense = await tx.detailedExpense.create({
          data: expenseCreateData,
        });

        await createFinanceHistoryLog(tx, {
          entityType: "expense",
          entityId: createdExpense.id,
          action: "create",
          previousState: {},
          newState: createdExpense,
          amount: toFiniteNumber(createdExpense.amount),
          ...actor,
        });

        if (inventoryItem && inventoryItemId) {
          const currentQuantity = toFiniteNumber(inventoryItem.quantity);
          const costPerUnit = toFiniteNumber(inventoryItem.costPerUnit);
          const nextQuantity = currentQuantity + inventoryQuantity;
          const updatedInventoryItem = await tx.inventoryItem.update({
            where: { id: inventoryItemId },
            data: {
              quantity: nextQuantity,
              totalValue: nextQuantity * costPerUnit,
              updatedAt: new Date(),
            },
          });

          await createFinanceHistoryLog(tx, {
            entityType: "inventory",
            entityId: inventoryItemId,
            action: "stock_from_expense",
            previousState: inventoryItem,
            newState: updatedInventoryItem,
            quantityChange: inventoryQuantity,
            summary: `Stock increased from linked expense ${createdExpense.id}`,
            ...actor,
          });
        }

        return createdExpense;
      })
    );

    res.status(201).json({
      success: true,
      message: "Detailed expense added successfully",
      data: buildDetailedExpenseResponse(newExpense),
    });
  } catch (error) {
    console.error("[FINANCE CREATE_DETAILED_EXPENSE] ERROR:", error);
    if (error instanceof Error && error.message === "Linked inventory item not found") {
      return res.status(400).json({
        success: false,
        message: "Linked inventory item not found",
      });
    }
    res.status(500).json({
      success: false,
      message: "Error adding detailed expense",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const updateDetailedExpense = async (
  req: Request<IdParams>,
  res: Response<ApiResponse<DetailedExpense | null>>
) => {
  try {
    const currentExpense = await prisma.detailedExpense.findUnique({
      where: { id: req.params.id },
    });

    if (!currentExpense || currentExpense.deleted) {
      return res.status(404).json({
        success: false,
        message: "Detailed expense not found",
      });
    }

    const updates: Partial<DetailedExpense> = req.body;
    if (updates.amount !== undefined && toFiniteNumber(updates.amount) <= 0) {
      return res.status(400).json({
        success: false,
        message: "Amount must be greater than zero",
      });
    }

    const inventoryItemId = String(updates.inventoryItemId || "").trim();
    const inventoryQuantity = toFiniteNumber(updates.inventoryQuantity);
    const hasInventoryLinkUpdate =
      Object.prototype.hasOwnProperty.call(updates, "inventoryItemId") ||
      Object.prototype.hasOwnProperty.call(updates, "inventoryQuantity");
    const previousInventoryItemId = String(currentExpense.inventoryItemId || "").trim();
    const previousInventoryQuantity = toFiniteNumber(currentExpense.inventoryQuantity);
    const nextInventoryItemId = hasInventoryLinkUpdate ? inventoryItemId : previousInventoryItemId;
    const nextInventoryQuantity = hasInventoryLinkUpdate ? inventoryQuantity : previousInventoryQuantity;
    const currentExpenseStatus = normalizeExpenseStatus(currentExpense.status);
    const requesterRole = normalizeCodeValue((req as any).user?.role);
    const canUpdateExpenseStatus = requesterRole === "admin";
    const hasStatusUpdate =
      canUpdateExpenseStatus && Object.prototype.hasOwnProperty.call(updates, "status");
    const nextExpenseStatus = hasStatusUpdate
      ? normalizeExpenseStatus(updates.status)
      : currentExpenseStatus;
    const shouldUpdatePaymentDate =
      hasStatusUpdate && currentExpenseStatus !== nextExpenseStatus;

    if (nextInventoryItemId && nextInventoryQuantity <= 0) {
      return res.status(400).json({
        success: false,
        message: "Inventory quantity must be greater than zero when linking stock",
      });
    }

    if (nextInventoryItemId && nextExpenseStatus === "cancelled") {
      return res.status(400).json({
        success: false,
        message: "Linked stock expenses must be pending or paid",
      });
    }

    const expenseUpdateData = {
      ...(updates.date !== undefined && { date: updates.date }),
      ...(updates.category !== undefined && { category: updates.category }),
      ...(updates.description !== undefined && { description: updates.description }),
      ...(updates.amount !== undefined && { amount: Number(updates.amount) }),
      ...(updates.vendor !== undefined && { vendor: updates.vendor || "" }),
      ...(updates.paymentMethod !== undefined && { paymentMethod: updates.paymentMethod || "" }),
      ...(hasStatusUpdate && { status: nextExpenseStatus }),
      ...(shouldUpdatePaymentDate && {
        paymentDate:
          nextExpenseStatus === "paid"
            ? currentExpense.paymentDate || dateKey(new Date())
            : null,
      }),
      ...(updates.recurring !== undefined && { recurring: Boolean(updates.recurring) }),
      ...(hasInventoryLinkUpdate && {
        inventoryItemId: nextInventoryItemId || null,
        inventoryQuantity: nextInventoryItemId ? nextInventoryQuantity : null,
      }),
    };

    const actor = getFinanceHistoryActor(req);
    const updatedExpense = toDetailedExpense(
      await prisma.$transaction(async (tx) => {
        const updatedExpenseRecord = await tx.detailedExpense.update({
          where: { id: req.params.id },
          data: expenseUpdateData,
        });

        if (hasInventoryLinkUpdate) {
          const quantityChanges = new Map<string, number>();
          if (previousInventoryItemId) {
            quantityChanges.set(previousInventoryItemId, -previousInventoryQuantity);
          }
          if (nextInventoryItemId) {
            quantityChanges.set(
              nextInventoryItemId,
              (quantityChanges.get(nextInventoryItemId) || 0) + nextInventoryQuantity
            );
          }

          for (const [itemId, quantityChange] of quantityChanges.entries()) {
            if (Math.abs(quantityChange) < 0.0001) continue;

            const inventoryItem = await tx.inventoryItem.findUnique({
              where: { id: itemId },
            });

            if (!inventoryItem || inventoryItem.deleted) {
              throw new Error("Linked inventory item not found");
            }

            const currentQuantity = toFiniteNumber(inventoryItem.quantity);
            const costPerUnit = toFiniteNumber(inventoryItem.costPerUnit);
            const updatedQuantity = currentQuantity + quantityChange;

            if (updatedQuantity < 0) {
              throw new Error("Linked inventory adjustment would make stock negative");
            }

            const updatedInventoryItem = await tx.inventoryItem.update({
              where: { id: itemId },
              data: {
                quantity: updatedQuantity,
                totalValue: updatedQuantity * costPerUnit,
                updatedAt: new Date(),
              },
            });

            await createFinanceHistoryLog(tx, {
              entityType: "inventory",
              entityId: itemId,
              action: "stock_from_expense",
              previousState: inventoryItem,
              newState: updatedInventoryItem,
              quantityChange,
              summary: `Stock adjusted from expense ${req.params.id}`,
              ...actor,
            });
          }
        }

        await createFinanceHistoryLog(tx, {
          entityType: "expense",
          entityId: req.params.id,
          action: "update",
          previousState: currentExpense,
          newState: updatedExpenseRecord,
          amount: toFiniteNumber(updatedExpenseRecord.amount),
          ...actor,
        });

        return updatedExpenseRecord;
      })
    );

    res.json({
      success: true,
      message: "Detailed expense updated successfully",
      data: buildDetailedExpenseResponse(updatedExpense),
    });
  } catch (error) {
    console.error("[FINANCE UPDATE_DETAILED_EXPENSE] ERROR:", error);
    if (error instanceof Error && error.message === "Linked inventory item not found") {
      return res.status(400).json({
        success: false,
        message: "Linked inventory item not found",
      });
    }
    if (error instanceof Error && error.message === "Linked inventory adjustment would make stock negative") {
      return res.status(400).json({
        success: false,
        message: "Linked inventory adjustment would make stock negative",
      });
    }
    res.status(500).json({
      success: false,
      message: "Error updating detailed expense",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const payDetailedExpense = async (
  req: Request<IdParams>,
  res: Response<ApiResponse<DetailedExpense | null>>
) => {
  try {
    const currentExpense = await prisma.detailedExpense.findUnique({
      where: { id: req.params.id },
    });

    if (!currentExpense || currentExpense.deleted) {
      return res.status(404).json({
        success: false,
        message: "Detailed expense not found",
      });
    }

    if (isCancelledExpense(currentExpense)) {
      return res.status(400).json({
        success: false,
        message: "Cancelled expenses cannot be marked as paid",
      });
    }

    const paymentMethod = String(req.body?.paymentMethod || currentExpense.paymentMethod || "cash").trim();
    const paymentDate = String(currentExpense.paymentDate || "").trim() || dateKey(new Date());
    const actor = getFinanceHistoryActor(req);
    const updatedExpense = toDetailedExpense(
      await prisma.$transaction(async (tx) => {
        const paidExpense = await tx.detailedExpense.update({
          where: { id: req.params.id },
          data: {
            status: "paid",
            paymentMethod: paymentMethod || "cash",
            paymentDate,
          },
        });

        await createFinanceHistoryLog(tx, {
          entityType: "expense",
          entityId: req.params.id,
          action: "pay",
          previousState: currentExpense,
          newState: paidExpense,
          amount: toFiniteNumber(paidExpense.amount),
          ...actor,
        });

        return paidExpense;
      })
    );

    res.json({
      success: true,
      message: "Detailed expense marked as paid",
      data: buildDetailedExpenseResponse(updatedExpense),
    });
  } catch (error) {
    console.error("[FINANCE PAY_DETAILED_EXPENSE] ERROR:", error);
    res.status(500).json({
      success: false,
      message: "Error marking detailed expense as paid",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const deleteDetailedExpense = async (
  req: Request<IdParams>,
  res: Response<ApiResponse<null>>
) => {
  try {
    const requesterRole = normalizeCodeValue((req as any).user?.role);
    if (requesterRole !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Only admins can delete detailed expenses",
      });
    }

    const currentExpense = await prisma.detailedExpense.findUnique({
      where: { id: req.params.id },
    });

    if (!currentExpense || currentExpense.deleted) {
      return res.status(404).json({
        success: false,
        message: "Detailed expense not found",
      });
    }

    const actor = getFinanceHistoryActor(req);
    const inventoryItemId = String(currentExpense.inventoryItemId || "").trim();
    const inventoryQuantity = toFiniteNumber(currentExpense.inventoryQuantity);

    await prisma.$transaction(async (tx) => {
      if (inventoryItemId && inventoryQuantity > 0) {
        const inventoryItem = await tx.inventoryItem.findUnique({
          where: { id: inventoryItemId },
        });

        if (!inventoryItem || inventoryItem.deleted) {
          throw new Error("Linked inventory item not found");
        }

        const currentQuantity = toFiniteNumber(inventoryItem.quantity);
        const updatedQuantity = currentQuantity - inventoryQuantity;
        if (updatedQuantity < 0) {
          throw new Error("Linked inventory adjustment would make stock negative");
        }

        const costPerUnit = toFiniteNumber(inventoryItem.costPerUnit);
        const updatedInventoryItem = await tx.inventoryItem.update({
          where: { id: inventoryItemId },
          data: {
            quantity: updatedQuantity,
            totalValue: updatedQuantity * costPerUnit,
            updatedAt: new Date(),
          },
        });

        await createFinanceHistoryLog(tx, {
          entityType: "inventory",
          entityId: inventoryItemId,
          action: "stock_reversed_from_expense_delete",
          previousState: inventoryItem,
          newState: updatedInventoryItem,
          quantityChange: -inventoryQuantity,
          summary: `Stock reversed from deleted expense ${req.params.id}`,
          ...actor,
        });
      }

      const deletedExpense = await tx.detailedExpense.update({
        where: { id: req.params.id },
        data: {
          deleted: true,
          deletedAt: new Date(),
        },
      });

      await createFinanceHistoryLog(tx, {
        entityType: "expense",
        entityId: req.params.id,
        action: "delete",
        previousState: currentExpense,
        newState: deletedExpense,
        amount: toFiniteNumber(deletedExpense.amount),
        ...actor,
      });
    });

    res.json({ success: true, message: "Detailed expense deleted successfully" });
  } catch (error) {
    console.error("[FINANCE DELETE_DETAILED_EXPENSE] ERROR:", error);
    if (error instanceof Error && error.message === "Linked inventory item not found") {
      return res.status(400).json({
        success: false,
        message: "Linked inventory item not found",
      });
    }
    if (error instanceof Error && error.message === "Linked inventory adjustment would make stock negative") {
      return res.status(400).json({
        success: false,
        message: "Linked inventory adjustment would make stock negative",
      });
    }
    res.status(500).json({
      success: false,
      message: "Error deleting detailed expense",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const getAllFinanceRecords = async (
  req: Request,
  res: Response<ApiResponse<FinanceRecord[]>>
) => {
  try {
    const { page = "1", limit = "20" } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, parseInt(limit, 10) || 20);

    const [total, items] = await Promise.all([
      prisma.financeRecord.count({ where: { deleted: false } }),
      prisma.financeRecord.findMany({
        where: { deleted: false },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
        orderBy: { createdAt: "desc" },
      }),
    ]);

    res.json({
      success: true,
      message: "Finance records retrieved successfully",
      data: items as unknown as FinanceRecord[],
      meta: { total, page: pageNum, limit: limitNum, totalPages: Math.max(1, Math.ceil(total / limitNum)) },
    });
  } catch (error) {
    console.error("[FINANCE GET_ALL] Error fetching finance records:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching finance records",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const getFinanceRecordById = async (
  req: Request<IdParams>,
  res: Response<ApiResponse<FinanceRecord | null>>
) => {
  try {
    const record = await prisma.financeRecord.findUnique({ where: { id: req.params.id } });
    if (!record || record.deleted) {
      return res.status(404).json({ success: false, message: "Finance record not found" });
    }

    res.json({
      success: true,
      message: "Finance record retrieved successfully",
      data: toFinanceRecord(record),
    });
  } catch (error) {
    console.error("[FINANCE GET_BY_ID] Error fetching finance record:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching finance record",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const updateFinanceRecord = async (
  req: Request<IdParams>,
  res: Response<ApiResponse<FinanceRecord | null>>
) => {
  try {
    const record = await prisma.financeRecord.findUnique({ where: { id: req.params.id } });
    if (!record || record.deleted) {
      return res.status(404).json({ success: false, message: "Finance record not found" });
    }

    const updates = req.body;
    const updatedRecord = toFinanceRecord(
      await prisma.financeRecord.update({
        where: { id: req.params.id },
        data: {
          ...(updates.patientId !== undefined && { patientId: updates.patientId }),
          ...(updates.type !== undefined && { type: updates.type }),
          ...(updates.amount !== undefined && { amount: Number(updates.amount) }),
          ...(updates.date !== undefined && { date: updates.date }),
          ...(updates.description !== undefined && { description: updates.description }),
          updatedAt: new Date(),
        },
      })
    );

    res.json({
      success: true,
      message: "Finance record updated successfully",
      data: updatedRecord,
    });
  } catch (error) {
    console.error("[FINANCE UPDATE] Error updating finance record:", error);
    res.status(500).json({
      success: false,
      message: "Error updating finance record",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const deleteFinanceRecord = async (
  req: Request<IdParams>,
  res: Response<ApiResponse<null>>
) => {
  try {
    const record = await prisma.financeRecord.findUnique({ where: { id: req.params.id } });
    if (!record || record.deleted) {
      return res.status(404).json({ success: false, message: "Finance record not found" });
    }

    await prisma.financeRecord.update({
      where: { id: req.params.id },
      data: { deleted: true, deletedAt: new Date(), updatedAt: new Date() },
    });

    res.json({ success: true, message: "Finance record soft-deleted successfully" });
  } catch (error) {
    console.error("[FINANCE DELETE] Error deleting finance record:", error);
    res.status(500).json({
      success: false,
      message: "Error deleting finance record",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const getRevenue = async (req: Request, res: Response<ApiResponse<Revenue[]>>) => {
  try {
    const [financeRecords, detailedExpenses, activeStaff] = await Promise.all([
      prisma.financeRecord.findMany({ where: { deleted: false } }),
      prisma.detailedExpense.findMany({ where: activeDetailedExpenseWhere }),
      prisma.staff.findMany({ where: { deleted: false } }),
    ]);

    const keys = recentMonthKeys(6);
    const totals = new Map(
      keys.map((key) => [key, { month: monthLabel(key), revenue: 0, expenses: 0, profit: 0 }])
    );

    let hasIncomeRecords = false;
    for (const record of financeRecords) {
      const date = getRecordDate(record);
      if (!date) continue;

      const key = monthKey(date);
      const total = totals.get(key);
      if (!total) continue;

      const amount = toFiniteNumber(record.amount);
      if (isIncomeType(record.type)) {
        hasIncomeRecords = true;
        total.revenue += amount;
      } else if (isExpenseType(record.type)) {
        total.expenses += amount;
      }
    }

    if (!hasIncomeRecords) {
      for (const record of financeRecords) {
        const date = getRecordDate(record);
        if (!date || !isChargeType(record.type)) continue;

        const total = totals.get(monthKey(date));
        if (total) total.revenue += toFiniteNumber(record.amount);
      }
    }

    for (const expense of detailedExpenses) {
      if (isCancelledExpense(expense)) continue;
      const date = normalizeDate(expense.date);
      if (!date) continue;

      const total = totals.get(monthKey(date));
      if (total) total.expenses += toFiniteNumber(expense.amount);
    }

    for (const staff of activeStaff) {
      const baseSalary = toFiniteNumber(staff.baseSalary);
      if (baseSalary <= 0) continue;

      const hireDate = normalizeDate(staff.hireDate);
      const hireMonth = hireDate ? monthKey(hireDate) : null;

      for (const key of keys) {
        if (hireMonth && key < hireMonth) continue;
        const total = totals.get(key);
        if (total) total.expenses += baseSalary;
      }
    }

    const data = keys.map((key) => {
      const total = totals.get(key)!;
      return {
        ...total,
        revenue: Math.round(total.revenue),
        expenses: Math.round(total.expenses),
        profit: Math.round(total.revenue - total.expenses),
      };
    });

    res.json({ success: true, message: "Revenue data retrieved successfully", data });
  } catch (error) {
    console.error("[FINANCE REVENUE] Error fetching revenue data:", error);
    res.status(500).json({ success: false, message: "Error fetching revenue data", error: error instanceof Error ? error.message : "Unknown error" });
  }
};

export const getExpenseBreakdown = async (
  req: Request,
  res: Response<ApiResponse<ExpenseBreakdown[]>>
) => {
  try {
    const [detailedExpenses, activeStaff] = await Promise.all([
      prisma.detailedExpense.findMany({ where: activeDetailedExpenseWhere }),
      prisma.staff.findMany({ where: { deleted: false } }),
    ]);

    const categoryTotals = new Map<string, number>();

    for (const expense of detailedExpenses) {
      if (isCancelledExpense(expense)) continue;
      const category = String(expense.category || "Other").trim() || "Other";
      categoryTotals.set(category, (categoryTotals.get(category) || 0) + toFiniteNumber(expense.amount));
    }

    const payrollTotal = activeStaff.reduce(
      (sum, staff) => sum + toFiniteNumber(staff.baseSalary),
      0
    );
    if (payrollTotal > 0) {
      categoryTotals.set("Payroll", (categoryTotals.get("Payroll") || 0) + payrollTotal);
    }

    const totalExpenses = Array.from(categoryTotals.values()).reduce((sum, amount) => sum + amount, 0);
    const data = Array.from(categoryTotals.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([category, amount], index) => ({
        category,
        amount: Math.round(amount),
        percentage: totalExpenses > 0 ? Math.round((amount / totalExpenses) * 100) : 0,
        color: EXPENSE_COLORS[index % EXPENSE_COLORS.length],
      }));

    res.json({ success: true, message: "Expense breakdown retrieved successfully", data });
  } catch (error) {
    console.error("[FINANCE EXPENSE_BREAKDOWN] Error fetching expense breakdown:", error);
    res.status(500).json({ success: false, message: "Error fetching expense breakdown", error: error instanceof Error ? error.message : "Unknown error" });
  }
};

export const getDetailedExpenses = async (
  req: Request,
  res: Response<ApiResponse<DetailedExpense[]>>
) => {
  try {
    const detailedExpenses = await prisma.detailedExpense.findMany({
      where: activeDetailedExpenseWhere,
      orderBy: { date: "desc" },
    });
    const data = detailedExpenses.map(buildDetailedExpenseResponse);
    res.json({
      success: true,
      message: "Detailed expenses retrieved successfully",
      data,
    });
  } catch (error) {
    console.error("[FINANCE DETAILED_EXPENSES] Error fetching detailed expenses:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching detailed expenses",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const getRecurringExpenses = async (
  req: Request,
  res: Response<ApiResponse<RecurringExpense[]>>
) => {
  try {
    const recurringExpenses = await prisma.detailedExpense.findMany({
      where: { ...activeDetailedExpenseWhere, recurring: true },
      orderBy: { date: "asc" },
    });

    const data = recurringExpenses
      .filter((expense) => !isCancelledExpense(expense))
      .map((expense) => ({
        category: expense.category || "Other",
        description: expense.description,
        amount: toFiniteNumber(expense.amount),
        frequency: "Monthly",
        nextDue: nextMonthlyDueDate(expense.date),
      }));

    res.json({ success: true, message: "Recurring expenses retrieved successfully", data });
  } catch (error) {
    console.error("[FINANCE RECURRING_EXPENSES] Error fetching recurring expenses:", error);
    res.status(500).json({ success: false, message: "Error fetching recurring expenses", error: error instanceof Error ? error.message : "Unknown error" });
  }
};

const buildPayrollData = async (payrollMonth: string) => {
  const [activeStaff, staffFinancialRecords] = await Promise.all([
    prisma.staff.findMany({ where: { deleted: false }, orderBy: { name: "asc" } }),
    prisma.staffFinancialRecord.findMany(),
  ]);

  return activeStaff.map((staff) => {
    const currentMonthRecords = staffFinancialRecords.filter(
      (record) => record.staffId === staff.id && isRecordInPayrollMonth(record, payrollMonth)
    );
    const salaryRecord = currentMonthRecords.find(isSalaryRecord);
    const managedAdjustmentRecord = currentMonthRecords.find(isManagedPayrollAdjustmentRecord);
    const bonus = currentMonthRecords
      .filter(isPayrollAdjustmentRecord)
      .reduce((sum, record) => sum + toFiniteNumber(record.amount), 0);
    const staffBaseSalary = toFiniteNumber(staff.baseSalary);
    const baseSalary = salaryRecord ? toFiniteNumber(salaryRecord.amount) : staffBaseSalary;
    const total = baseSalary + bonus;
    const status = salaryRecord?.status || (baseSalary > 0 || Math.abs(bonus) > 0 ? "pending" : "paid");

    return {
      id: staff.id,
      name: staff.name,
      role: staff.role,
      baseSalary,
      staffBaseSalary,
      bonus,
      managedAdjustment: managedAdjustmentRecord ? toFiniteNumber(managedAdjustmentRecord.amount) : 0,
      total,
      status,
      salaryRecordId: salaryRecord?.id,
      paymentDate: normalizeCodeValue(status) === "paid" ? salaryRecord?.date : undefined,
      month: payrollMonth,
    };
  });
};

export const getPayroll = async (req: Request, res: Response<ApiResponse<Payroll[]>>) => {
  try {
    const payrollMonth = normalizePayrollMonth(req.query.month);
    const data = await buildPayrollData(payrollMonth);
    res.json({ success: true, message: "Payroll data retrieved successfully", data });
  } catch (error) {
    console.error("[FINANCE PAYROLL] Error fetching payroll data:", error);
    res.status(500).json({ success: false, message: "Error fetching payroll data", error: error instanceof Error ? error.message : "Unknown error" });
  }
};

export const processPayroll = async (
  req: Request,
  res: Response<ApiResponse<Payroll[]>>
) => {
  try {
    const payrollMonth = normalizePayrollMonth(req.body?.month);
    const payrollDate = resolvePayrollDate(req.body?.paymentDate, payrollMonth);
    const actor = getFinanceHistoryActor(req);
    const previousPayrollData = await buildPayrollData(payrollMonth);
    const previousPayrollByStaffId = new Map(previousPayrollData.map((entry) => [entry.id, entry]));
    const [activeStaff, staffFinancialRecords] = await Promise.all([
      prisma.staff.findMany({ where: { deleted: false }, orderBy: { name: "asc" } }),
      prisma.staffFinancialRecord.findMany(),
    ]);

    for (const staff of activeStaff) {
      const baseSalary = toFiniteNumber(staff.baseSalary);
      const existingSalaryRecord = staffFinancialRecords.find(
        (record) =>
          record.staffId === staff.id &&
          isRecordInPayrollMonth(record, payrollMonth) &&
          isSalaryRecord(record)
      );

      if (existingSalaryRecord) {
        await prisma.staffFinancialRecord.update({
          where: { id: existingSalaryRecord.id },
          data: {
            amount: toFiniteNumber(existingSalaryRecord.amount),
            date: payrollDate,
            staffName: staff.name,
            status: "paid",
            notes: existingSalaryRecord.notes || `${monthLabel(payrollMonth)} salary`,
          },
        });
        continue;
      }

      await prisma.staffFinancialRecord.create({
        data: {
          id: createStaffFinancialRecordId(),
          staffId: staff.id,
          staffName: staff.name,
          type: "salary",
          amount: baseSalary,
          date: payrollDate,
          status: "paid",
          notes: `${monthLabel(payrollMonth)} salary`,
          repaymentSchedule: "",
        },
      });
    }

    const data = await buildPayrollData(payrollMonth);
    await Promise.all(
      data.map((entry) => {
        const previousState = previousPayrollByStaffId.get(entry.id) || {};
        if (!payrollStateChanged(previousState, entry)) return Promise.resolve(null);

        return createFinanceHistoryLog(prisma, {
          entityType: "payroll",
          entityId: entry.id || "",
          context: payrollMonth,
          action: "process",
          previousState,
          newState: entry,
          amount: toFiniteNumber(entry.total),
          summary: `${monthLabel(payrollMonth)} payroll processed`,
          ...actor,
        });
      })
    );
    res.json({ success: true, message: "Payroll processed successfully", data });
  } catch (error) {
    console.error("[FINANCE PROCESS_PAYROLL] Error processing payroll:", error);
    res.status(500).json({
      success: false,
      message: "Error processing payroll",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const payPayrollEntry = async (
  req: Request<IdParams>,
  res: Response<ApiResponse<Payroll | null>>
) => {
  try {
    const staffId = req.params.id;
    const payrollMonth = normalizePayrollMonth(req.body?.month);
    const paymentDate = resolvePayrollDate(req.body?.paymentDate, payrollMonth);
    const actor = getFinanceHistoryActor(req);
    const previousState = (await buildPayrollData(payrollMonth)).find((entry) => entry.id === staffId) || {};

    const staff = await prisma.staff.findUnique({ where: { id: staffId } });
    if (!staff || staff.deleted) {
      return res.status(404).json({
        success: false,
        message: "Staff member not found",
      });
    }

    const baseSalary = toFiniteNumber(staff.baseSalary);
    const existingSalaryRecord = await prisma.staffFinancialRecord.findFirst({
      where: {
        staffId,
        date: { startsWith: `${payrollMonth}-` },
        OR: [
          { type: "salary" },
          { type: "payroll" },
          { type: "monthly_salary" },
        ],
      },
    });

    if (existingSalaryRecord) {
      await prisma.staffFinancialRecord.update({
        where: { id: existingSalaryRecord.id },
        data: {
          amount: toFiniteNumber(existingSalaryRecord.amount),
          date: paymentDate,
          status: "paid",
          notes: existingSalaryRecord.notes || `${monthLabel(payrollMonth)} salary`,
        },
      });
    } else {
      await prisma.staffFinancialRecord.create({
        data: {
          id: createStaffFinancialRecordId(),
          staffId: staff.id,
          staffName: staff.name,
          type: "salary",
          amount: baseSalary,
          date: paymentDate,
          status: "paid",
          notes: `${monthLabel(payrollMonth)} salary`,
          repaymentSchedule: "",
        },
      });
    }

    const data = (await buildPayrollData(payrollMonth)).find((entry) => entry.id === staffId) || null;
    if (data && payrollStateChanged(previousState, data)) {
      await createFinanceHistoryLog(prisma, {
        entityType: "payroll",
        entityId: staffId,
        context: payrollMonth,
        action: "pay",
        previousState,
        newState: data,
        amount: toFiniteNumber(data.total),
        summary: `${data.name} payroll marked paid`,
        ...actor,
      });
    }
    res.json({ success: true, message: "Payroll entry paid successfully", data });
  } catch (error) {
    console.error("[FINANCE PAY_PAYROLL_ENTRY] Error paying payroll entry:", error);
    res.status(500).json({
      success: false,
      message: "Error paying payroll entry",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const unpayPayrollEntry = async (
  req: Request<IdParams>,
  res: Response<ApiResponse<Payroll | null>>
) => {
  try {
    const staffId = req.params.id;
    const payrollMonth = normalizePayrollMonth(req.body?.month);
    const actor = getFinanceHistoryActor(req);
    const previousState = (await buildPayrollData(payrollMonth)).find((entry) => entry.id === staffId) || {};

    const staff = await prisma.staff.findUnique({ where: { id: staffId } });
    if (!staff || staff.deleted) {
      return res.status(404).json({
        success: false,
        message: "Staff member not found",
      });
    }

    const existingSalaryRecord = await prisma.staffFinancialRecord.findFirst({
      where: {
        staffId,
        date: { startsWith: `${payrollMonth}-` },
        OR: [
          { type: "salary" },
          { type: "payroll" },
          { type: "monthly_salary" },
        ],
      },
    });

    if (!existingSalaryRecord) {
      return res.status(404).json({
        success: false,
        message: "Payroll payment record not found",
      });
    }

    await prisma.staffFinancialRecord.update({
      where: { id: existingSalaryRecord.id },
      data: {
        staffName: staff.name,
        status: "pending",
        notes: existingSalaryRecord.notes || `${monthLabel(payrollMonth)} salary`,
      },
    });

    const data = (await buildPayrollData(payrollMonth)).find((entry) => entry.id === staffId) || null;
    if (data && payrollStateChanged(previousState, data)) {
      await createFinanceHistoryLog(prisma, {
        entityType: "payroll",
        entityId: staffId,
        context: payrollMonth,
        action: "unpay",
        previousState,
        newState: data,
        amount: toFiniteNumber(data.total),
        summary: `${data.name} payroll payment cancelled`,
        ...actor,
      });
    }

    res.json({ success: true, message: "Payroll payment reversed successfully", data });
  } catch (error) {
    console.error("[FINANCE UNPAY_PAYROLL_ENTRY] Error reversing payroll payment:", error);
    res.status(500).json({
      success: false,
      message: "Error reversing payroll payment",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const addPayrollBonus = async (
  req: Request<IdParams>,
  res: Response<ApiResponse<Payroll | null>>
) => {
  try {
    const staffId = req.params.id;
    const payrollMonth = normalizePayrollMonth(req.body?.month);
    const amount = toFiniteNumber(req.body?.amount);
    const bonusDate = resolvePayrollDate(req.body?.date, payrollMonth);
    const notes = String(req.body?.notes || "").trim();
    const actor = getFinanceHistoryActor(req);
    const previousState = (await buildPayrollData(payrollMonth)).find((entry) => entry.id === staffId) || {};

    if (amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Bonus amount must be greater than zero",
      });
    }

    const staff = await prisma.staff.findUnique({ where: { id: staffId } });
    if (!staff || staff.deleted) {
      return res.status(404).json({
        success: false,
        message: "Staff member not found",
      });
    }

    await prisma.staffFinancialRecord.create({
      data: {
        id: createStaffFinancialRecordId(),
        staffId: staff.id,
        staffName: staff.name,
        type: "bonus",
        amount,
        date: bonusDate,
        status: "approved",
        notes: notes || `${monthLabel(payrollMonth)} bonus`,
        repaymentSchedule: "",
      },
    });

    const data = (await buildPayrollData(payrollMonth)).find((entry) => entry.id === staffId) || null;
    if (data && payrollStateChanged(previousState, data)) {
      await createFinanceHistoryLog(prisma, {
        entityType: "payroll",
        entityId: staffId,
        context: payrollMonth,
        action: "bonus",
        previousState,
        newState: data,
        amount,
        summary: `${staff.name} payroll bonus added`,
        ...actor,
      });
    }
    res.status(201).json({ success: true, message: "Payroll bonus added successfully", data });
  } catch (error) {
    console.error("[FINANCE ADD_PAYROLL_BONUS] Error adding payroll bonus:", error);
    res.status(500).json({
      success: false,
      message: "Error adding payroll bonus",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const configurePayrollEntry = async (
  req: Request<IdParams>,
  res: Response<ApiResponse<Payroll | null>>
) => {
  try {
    const staffId = req.params.id;
    const payrollMonth = normalizePayrollMonth(req.body?.month);
    const payrollDate = resolvePayrollDate(req.body?.date || req.body?.paymentDate, payrollMonth);
    const hasBaseSalary = Object.prototype.hasOwnProperty.call(req.body || {}, "baseSalary");
    const hasManagedAdjustment = Object.prototype.hasOwnProperty.call(req.body || {}, "managedAdjustment");
    const adjustmentNotes = String(req.body?.adjustmentNotes || req.body?.notes || "").trim();
    const salaryNotes = String(req.body?.salaryNotes || "").trim();
    const actor = getFinanceHistoryActor(req);
    const previousState = (await buildPayrollData(payrollMonth)).find((entry) => entry.id === staffId) || {};

    const staff = await prisma.staff.findUnique({ where: { id: staffId } });
    if (!staff || staff.deleted) {
      return res.status(404).json({
        success: false,
        message: "Staff member not found",
      });
    }

    const nextBaseSalary = hasBaseSalary ? toFiniteNumber(req.body?.baseSalary) : toFiniteNumber(staff.baseSalary);
    if (nextBaseSalary < 0) {
      return res.status(400).json({
        success: false,
        message: "Base salary cannot be negative",
      });
    }

    const nextManagedAdjustment = hasManagedAdjustment ? toFiniteNumber(req.body?.managedAdjustment) : undefined;

    await prisma.$transaction(async (tx) => {
      if (hasBaseSalary && Math.abs(nextBaseSalary - toFiniteNumber(staff.baseSalary)) > 0.009) {
        await tx.staff.update({
          where: { id: staff.id },
          data: {
            baseSalary: nextBaseSalary,
            updatedAt: new Date(),
          },
        });
      }

      const existingSalaryRecord = await tx.staffFinancialRecord.findFirst({
        where: {
          staffId,
          date: { startsWith: `${payrollMonth}-` },
          OR: [
            { type: "salary" },
            { type: "payroll" },
            { type: "monthly_salary" },
          ],
        },
      });

      if (existingSalaryRecord) {
        await tx.staffFinancialRecord.update({
          where: { id: existingSalaryRecord.id },
          data: {
            amount: nextBaseSalary,
            staffName: staff.name,
            notes: salaryNotes || existingSalaryRecord.notes || `${monthLabel(payrollMonth)} salary`,
          },
        });
      } else {
        await tx.staffFinancialRecord.create({
          data: {
            id: createStaffFinancialRecordId(),
            staffId: staff.id,
            staffName: staff.name,
            type: "salary",
            amount: nextBaseSalary,
            date: payrollDate,
            status: "pending",
            notes: salaryNotes || `${monthLabel(payrollMonth)} salary`,
            repaymentSchedule: "",
          },
        });
      }

      if (hasManagedAdjustment) {
        const existingAdjustmentRecord = await tx.staffFinancialRecord.findFirst({
          where: {
            staffId,
            date: { startsWith: `${payrollMonth}-` },
            type: MANAGED_PAYROLL_ADJUSTMENT_TYPE,
          },
        });

        if (nextManagedAdjustment !== undefined && Math.abs(nextManagedAdjustment) > 0.009) {
          if (existingAdjustmentRecord) {
            await tx.staffFinancialRecord.update({
              where: { id: existingAdjustmentRecord.id },
              data: {
                amount: nextManagedAdjustment,
                date: payrollDate,
                staffName: staff.name,
                status: "approved",
                notes: adjustmentNotes || `${monthLabel(payrollMonth)} payroll adjustment`,
              },
            });
          } else {
            await tx.staffFinancialRecord.create({
              data: {
                id: createStaffFinancialRecordId(),
                staffId: staff.id,
                staffName: staff.name,
                type: MANAGED_PAYROLL_ADJUSTMENT_TYPE,
                amount: nextManagedAdjustment,
                date: payrollDate,
                status: "approved",
                notes: adjustmentNotes || `${monthLabel(payrollMonth)} payroll adjustment`,
                repaymentSchedule: "",
              },
            });
          }
        } else if (existingAdjustmentRecord) {
          await tx.staffFinancialRecord.delete({
            where: { id: existingAdjustmentRecord.id },
          });
        }
      }
    });

    const data = (await buildPayrollData(payrollMonth)).find((entry) => entry.id === staffId) || null;
    if (data && payrollStateChanged(previousState, data)) {
      await createFinanceHistoryLog(prisma, {
        entityType: "payroll",
        entityId: staffId,
        context: payrollMonth,
        action: "configure",
        previousState,
        newState: data,
        amount: toFiniteNumber(data.total),
        summary: `${staff.name} payroll configured`,
        ...actor,
      });
    }
    res.json({ success: true, message: "Payroll entry configured successfully", data });
  } catch (error) {
    console.error("[FINANCE CONFIGURE_PAYROLL_ENTRY] Error configuring payroll entry:", error);
    res.status(500).json({
      success: false,
      message: "Error configuring payroll entry",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const getRecentTransactions = async (
  req: Request,
  res: Response<ApiResponse<RecentTransaction[]>>
) => {
  try {
    const canSeeDeletedPayments = canViewDeletedPaymentRows(req);
    const requestedLimit = Number((req.query as Record<string, string | undefined>).limit || 25);
    const resultLimit = Math.max(1, Math.min(1000, Number.isFinite(requestedLimit) ? requestedLimit : 25));
    const sourceLimit = Math.min(5000, Math.max(100, resultLimit * 6));
    const [financeRecords, detailedExpenses, payments, appointmentPaymentLogs] = await Promise.all([
      prisma.financeRecord.findMany({
        where: { deleted: false },
        orderBy: { date: "desc" },
        take: sourceLimit,
      }),
      prisma.detailedExpense.findMany({
        where: activeDetailedExpenseWhere,
        orderBy: { date: "desc" },
        take: sourceLimit,
      }),
      prisma.payment.findMany({
        orderBy: { date: "desc" },
        take: sourceLimit,
      }),
      prisma.appointmentLog.findMany({
        where: {
          AND: [
            {
              OR: [
                { changeType: "payment" },
                { amount: { gt: 0 } },
              ],
            },
            { NOT: { changeType: "payment_adjustment" } },
          ],
        },
        orderBy: { changedAt: "desc" },
        take: sourceLimit,
      }),
    ]);

    const paymentIds = new Set(payments.map((payment) => payment.id));
    const appointmentIds = Array.from(new Set([
      ...payments.map((payment) => payment.appointmentId).filter(Boolean),
      ...appointmentPaymentLogs.map((log) => log.appointmentId).filter(Boolean),
      ...financeRecords
        .map((record) => extractAppointmentIdFromSnapshot(record.appointmentSnapshot))
        .filter((id): id is string => Boolean(id)),
      ...financeRecords
        .map((record) => extractAppointmentId(record.description))
        .filter((id): id is string => Boolean(id)),
    ]));
    const financeRecordDates = Array.from(new Set(
      financeRecords.map((record) => record.date).filter((date): date is string => Boolean(date))
    ));
    const [appointmentSnapshots, financeRecordAppointments] = await Promise.all([
      appointmentIds.length > 0
        ? prisma.appointment.findMany({ where: { id: { in: appointmentIds } } })
        : Promise.resolve([]),
      financeRecordDates.length > 0
        ? prisma.appointment.findMany({
            where: {
              deleted: false,
              date: { in: financeRecordDates },
            },
          })
        : Promise.resolve([]),
    ]);
    const appointmentSnapshotById = new Map(
      [...appointmentSnapshots, ...financeRecordAppointments].map((appointment) => [appointment.id, appointment])
    );

    const allPaymentTransactions = payments.map((payment) => {
      // Prefer any snapshot stored on the payment record; otherwise fallback to current appointment row
      const currentAppointmentSnapshot = appointmentSnapshotById.get(payment.appointmentId);
      const appointmentSnapshot = (payment as any).appointmentSnapshot || currentAppointmentSnapshot;
      const serviceName = appointmentSnapshot?.customType || appointmentSnapshot?.serviceType || "appointment";
      const paymentDate = dateOnlyKey(payment.date) || dateOnlyKey(payment.createdAt);

      return {
        id: payment.id,
        date: paymentDate,
        paymentDate,
        description: appointmentSnapshot
          ? `Payment for ${serviceName}`
          : `Payment ${payment.id} for appointment ${payment.appointmentId}`,
        amount: Math.abs(toFiniteNumber(payment.amount)),
        type: "income",
        method: normalizeMethod(payment.method),
        patientId: payment.patientId,
        appointmentId: payment.appointmentId,
        transactionId: payment.transactionId,
        paymentId: payment.id,
        paymentRecordId: payment.id,
        notes: payment.notes,
        currentAppointmentBalance: currentAppointmentSnapshot?.balance,
        currentAppointmentTotalPaid: currentAppointmentSnapshot?.totalPaid,
        currentAppointmentPrice: currentAppointmentSnapshot?.price,
        currentAppointmentDiscount: currentAppointmentSnapshot?.discount,
        currentPaymentStatus: currentAppointmentSnapshot?.paymentStatus,
        appointmentSnapshot,
        logDate: payment.createdAt ? toIsoDate(payment.createdAt) : paymentDate,
        source: "payment",
        deleted: Boolean(payment.deleted),
        deletedAt: toIsoDate(payment.deletedAt),
      };
    });
    const paymentTransactions = canSeeDeletedPayments
      ? allPaymentTransactions
      : allPaymentTransactions.filter((transaction) => !transaction.deleted && !transaction.deletedAt);

    const financeTransactions = financeRecords
      .filter((record) => isIncomeType(record.type) || isExpenseType(record.type))
      .filter((record) => {
        const paymentId = extractPaymentId(record.description);
        return !paymentId || !paymentIds.has(paymentId);
      })
      .map((record) => {
        const matchedAppointment = findAppointmentForFinanceRecord(record, financeRecordAppointments);
        const paymentDate = dateOnlyKey(record.date) || dateOnlyKey(record.createdAt);
        const appointmentId =
          extractAppointmentIdFromSnapshot(record.appointmentSnapshot) ||
          extractAppointmentId(record.description) ||
          matchedAppointment?.id ||
          undefined;

        return {
          id: record.id,
          date: paymentDate,
          paymentDate,
          description: record.description || `${record.type} record`,
          amount: isExpenseType(record.type)
            ? -Math.abs(toFiniteNumber(record.amount))
            : Math.abs(toFiniteNumber(record.amount)),
          type: isExpenseType(record.type) ? "expense" : "income",
          method: isIncomeType(record.type) ? "Payment" : "Finance record",
          appointmentId,
          currentAppointmentBalance: appointmentId ? appointmentSnapshotById.get(appointmentId)?.balance : undefined,
          currentAppointmentTotalPaid: appointmentId ? appointmentSnapshotById.get(appointmentId)?.totalPaid : undefined,
          currentAppointmentPrice: appointmentId ? appointmentSnapshotById.get(appointmentId)?.price : undefined,
          currentAppointmentDiscount: appointmentId ? appointmentSnapshotById.get(appointmentId)?.discount : undefined,
          currentPaymentStatus: appointmentId ? appointmentSnapshotById.get(appointmentId)?.paymentStatus : undefined,
          appointmentSnapshot: record.appointmentSnapshot
            ? record.appointmentSnapshot
            : (appointmentId ? appointmentSnapshotById.get(appointmentId) || matchedAppointment : matchedAppointment || undefined),
          logDate: record.createdAt ? toIsoDate(record.createdAt) : paymentDate,
          source: "finance-record",
        };
      });

    const representedPaymentTransactions = [...allPaymentTransactions, ...financeTransactions]
      .filter((transaction) => transaction.type === "income" && transaction.appointmentId && transaction.amount > 0);

    const appointmentLogTransactions = appointmentPaymentLogs
      .filter((log) => toFiniteNumber(log.amount) > 0)
      .map((log) => {
        const liveAppointment = appointmentSnapshotById.get(log.appointmentId);
        const logSnapshot = (log.newState && typeof log.newState === "object" ? log.newState : null) as any;
        const appointmentSnapshot = {
          ...(liveAppointment || {}),
          ...(logSnapshot || {}),
          id: logSnapshot?.id || liveAppointment?.id || log.appointmentId,
          appointmentId: log.appointmentId,
          changedAt: toIsoDate(log.changedAt),
          changedByName: log.changedByName || undefined,
        };
        const serviceName = getAppointmentServiceName(appointmentSnapshot);
        const changedAt = normalizeDate(log.changedAt) || new Date();
        const paymentDate = dateOnlyKey(logSnapshot?.paymentDate || (log as any).paymentDate);
        const createdDate = dateKey(changedAt);
        const transactionPaymentDate = paymentDate || createdDate;
        const logDate = toIsoDate(log.changedAt) || transactionPaymentDate;

        return {
          id: log.id,
          date: transactionPaymentDate,
          paymentDate: transactionPaymentDate,
          description: `Payment for ${serviceName}`,
          amount: Math.abs(toFiniteNumber(log.amount)),
          type: "income",
          method: normalizeMethod(appointmentSnapshot.paymentMethod || "Payment log"),
          appointmentId: log.appointmentId,
          currentAppointmentBalance: liveAppointment?.balance,
          currentAppointmentTotalPaid: liveAppointment?.totalPaid,
          currentAppointmentPrice: liveAppointment?.price,
          currentAppointmentDiscount: liveAppointment?.discount,
          currentPaymentStatus: liveAppointment?.paymentStatus,
          appointmentSnapshot,
          logDate,
          changedByName: log.changedByName || undefined,
          source: "appointment-log",
        };
      })
      .filter((transaction) =>
        !representedPaymentTransactions.some(
          (represented) =>
            isSamePaymentLogSource(transaction, represented) ||
            isSamePaymentEvent(transaction, represented)
        )
      );

    const expenseTransactions = detailedExpenses
      .filter((expense) => normalizeExpenseStatus(expense.status) === "paid")
      .map((expense) => {
        const paymentDate = expense.paymentDate || expense.date;

        return {
          id: expense.id,
          date: paymentDate,
          description: expense.description,
          amount: -Math.abs(toFiniteNumber(expense.amount)),
          type: "expense",
          method: normalizeMethod(expense.paymentMethod),
          logDate: paymentDate,
          source: "expense",
        };
      });

    const data = [...paymentTransactions, ...financeTransactions, ...appointmentLogTransactions, ...expenseTransactions]
      .sort((a, b) => {
        const aTime = normalizeDate(a.logDate || a.date)?.getTime() || 0;
        const bTime = normalizeDate(b.logDate || b.date)?.getTime() || 0;
        return bTime - aTime;
      })
      .slice(0, resultLimit);

    res.json({ success: true, message: "Recent transactions retrieved successfully", data });
  } catch (error) {
    console.error("[FINANCE RECENT_TRANSACTIONS] Error fetching recent transactions:", error);
    res.status(500).json({ success: false, message: "Error fetching recent transactions", error: error instanceof Error ? error.message : "Unknown error" });
  }
};
