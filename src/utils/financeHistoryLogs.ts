import { Request } from "express";

export type FinanceHistoryEntityType = "expense" | "inventory" | "payroll";

type FinanceHistoryActor = {
  changedBy: string;
  changedByName?: string;
  changedByRole?: string;
};

type FinanceHistoryLogInput = FinanceHistoryActor & {
  entityType: FinanceHistoryEntityType;
  entityId: string;
  context?: string;
  action: string;
  previousState?: unknown;
  newState?: unknown;
  changedAt?: Date;
  amount?: number;
  quantityChange?: number;
  payrollRecordId?: string;
  notes?: string;
  summary?: string;
};

type FindFinanceHistoryLogInput = {
  entityType: FinanceHistoryEntityType;
  entityId?: string;
  context?: string;
  limit?: number;
};

const sanitizeJson = (value: unknown) => {
  if (value === undefined || value === null) return {};
  return JSON.parse(JSON.stringify(value));
};

const makeLogId = (prefix: string) =>
  `${prefix}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

export const getFinanceHistoryActor = (req: Request): FinanceHistoryActor => {
  const user = (req as any).user || {};
  const changedBy = String(user.id || user.username || user.email || "system").trim() || "system";
  const changedByName =
    String(user.name || user.fullName || user.username || user.email || "").trim() || undefined;
  const changedByRole = String(user.role || "").trim() || undefined;

  return { changedBy, changedByName, changedByRole };
};

export const createFinanceHistoryLog = async (client: any, input: FinanceHistoryLogInput) => {
  if (!input.entityType || !input.entityId || !input.action) return null;

  const baseData = {
    previousState: sanitizeJson(input.previousState),
    newState: sanitizeJson(input.newState),
    changedBy: input.changedBy,
    changedByName: input.changedByName || null,
    changedByRole: input.changedByRole || null,
    changedAt: input.changedAt || new Date(),
    changeType: input.action,
    notes: input.notes || input.summary || null,
  };

  if (input.entityType === "expense") {
    return client.expenseLog.create({
      data: {
        id: makeLogId("exp_log"),
        expenseId: input.entityId,
        amount: input.amount ?? null,
        ...baseData,
      },
    });
  }

  if (input.entityType === "inventory") {
    return client.inventoryLog.create({
      data: {
        id: makeLogId("inv_log"),
        inventoryItemId: input.entityId,
        quantityChange: input.quantityChange ?? null,
        ...baseData,
      },
    });
  }

  return client.payrollLog.create({
    data: {
      id: makeLogId("pay_log"),
      staffId: input.entityId,
      payrollMonth: input.context || null,
      payrollRecordId: input.payrollRecordId || null,
      amount: input.amount ?? null,
      ...baseData,
    },
  });
};

const normalizeLog = (entityType: FinanceHistoryEntityType, log: any) => ({
  id: log.id,
  entityType,
  entityId:
    entityType === "expense"
      ? log.expenseId
      : entityType === "inventory"
        ? log.inventoryItemId
        : log.staffId,
  context: entityType === "payroll" ? log.payrollMonth || undefined : undefined,
  action: log.changeType,
  previousState: log.previousState,
  newState: log.newState,
  changedBy: log.changedBy,
  changedByName: log.changedByName || undefined,
  changedByRole: log.changedByRole || undefined,
  changedAt: log.changedAt,
  summary: log.notes || undefined,
  amount: log.amount ?? log.quantityChange ?? undefined,
});

export const findFinanceHistoryLogs = async (client: any, input: FindFinanceHistoryLogInput) => {
  const take = Math.min(200, Math.max(1, input.limit || 100));

  if (input.entityType === "expense") {
    const logs = await client.expenseLog.findMany({
      where: input.entityId ? { expenseId: input.entityId } : undefined,
      orderBy: { changedAt: "desc" },
      // An entity-specific expense request powers version navigation and must be complete.
      // Keep the cap only for broad, cross-expense history queries.
      ...(input.entityId ? {} : { take }),
    });
    return logs.map((log: any) => normalizeLog("expense", log));
  }

  if (input.entityType === "inventory") {
    const logs = await client.inventoryLog.findMany({
      where: input.entityId ? { inventoryItemId: input.entityId } : undefined,
      orderBy: { changedAt: "desc" },
      take,
    });
    return logs.map((log: any) => normalizeLog("inventory", log));
  }

  const logs = await client.payrollLog.findMany({
    where: {
      ...(input.entityId && { staffId: input.entityId }),
      ...(input.context && { payrollMonth: input.context }),
    },
    orderBy: { changedAt: "desc" },
    take,
  });
  return logs.map((log: any) => normalizeLog("payroll", log));
};
