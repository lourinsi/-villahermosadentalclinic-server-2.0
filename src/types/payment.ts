export type PaymentStatus =
  | "paid"
  | "unpaid"
  | "half-paid"
  | "overdue"
  | "over-paid"
  | (string & {});

export interface PaymentStatusOption {
  key: number;
  value: PaymentStatus;
  label: string;
  description: string;
  bgColor: string;
  textColor: string;
}

export interface Payment {
  id: string;
  appointmentId: string;
  patientId?: string;
  appointmentSnapshot?: any;
  amount: number;
  method: string;
  date: string;
  transactionId: string;
  notes?: string;
  status?: PaymentStatus;
  createdAt?: Date;
  updatedAt?: Date;
  deleted?: boolean;
  deletedAt?: Date | null;
}

export interface ApiResponse<T> {
  success: boolean;
  message?: string;
  data?: T;
  error?: any;
}
