export interface FinanceRecord {
  id?: string;
  patientId?: string;
  appointmentSnapshot?: any;
  type: "charge" | "payment" | string;
  amount: number;
  date: string; // YYYY-MM-DD
  description?: string;
  createdAt?: Date;
  updatedAt?: Date;
  deleted?: boolean;
  deletedAt?: Date | null;
}

export interface Revenue {
  month: string;
  revenue: number;
  expenses: number;
  profit: number;
}

export interface ExpenseBreakdown {
  category: string;
  amount: number;
  percentage: number;
  color: string;
}

export interface DetailedExpense {
  id: string;
  date: string;
  category: string;
  description: string;
  amount: number;
  vendor: string;
  paymentMethod: string;
  paymentDate?: string;
  status: string;
  recurring: boolean;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  deleted?: boolean;
  deletedAt?: string | Date | null;
  inventoryItemId?: string;
  inventoryQuantity?: number;
}

export interface RecurringExpense {
  category: string;
  description: string;
  amount: number;
  frequency: string;
  nextDue: string;
}

export interface Payroll {
  id?: string;
  name: string;
  role: string;
  baseSalary: number;
  staffBaseSalary?: number;
  bonus: number;
  managedAdjustment?: number;
  total: number;
  status: string;
  salaryRecordId?: string;
  paymentDate?: string;
  month?: string;
}

export interface RecentTransaction {
  id?: string;
  date: string;
  description: string;
  amount: number;
  type: string;
  method: string;
  appointmentId?: string;
  appointmentSnapshot?: any;
  patientId?: string;
  paymentDate?: string;
  logDate?: string;
  transactionId?: string;
  paymentId?: string;
  paymentRecordId?: string;
  notes?: string;
  currentAppointmentBalance?: number | null;
  currentAppointmentTotalPaid?: number | null;
  currentAppointmentPrice?: number | null;
  currentAppointmentDiscount?: number | null;
  currentPaymentStatus?: string | null;
  deleted?: boolean;
  deletedAt?: string | null;
  changedByName?: string;
  source?: string;
}

export interface FinanceHistoryLog {
  id: string;
  entityType: string;
  entityId: string;
  context?: string;
  action: string;
  previousState: any;
  newState: any;
  changedBy: string;
  changedByName?: string;
  changedByRole?: string;
  changedAt?: string | Date;
  summary?: string;
}

export interface ApiResponse<T> {
  success: boolean;
  message: string;
  meta?: any;
  data?: T;
  error?: string;
}
