import { getDefaultPaymentStatusColors, normalizePaymentStatus } from "./statusColors";

export interface PaymentStatusOption {
  key: number;
  value: string;
  label: string;
  description: string;
  bgColor: string;
  textColor: string;
}

export const PAYMENT_STATUSES: PaymentStatusOption[] = [
  {
    key: 1,
    value: "paid",
    label: "Paid",
    description: "Payment completed in full",
    ...getDefaultPaymentStatusColors("paid")
  },
  {
    key: 2,
    value: "unpaid",
    label: "Unpaid",
    description: "Payment not yet made",
    ...getDefaultPaymentStatusColors("unpaid")
  },
  {
    key: 3,
    value: "half-paid",
    label: "Partial",
    description: "Partial payment received",
    ...getDefaultPaymentStatusColors("half-paid")
  },
  {
    key: 4,
    value: "overdue",
    label: "Overdue",
    description: "Payment past due date",
    ...getDefaultPaymentStatusColors("overdue")
  },
  {
    key: 5,
    value: "over-paid",
    label: "Overpaid",
    description: "Payment exceeds appointment total",
    ...getDefaultPaymentStatusColors("over-paid")
  },
];

/**
 * Get payment status option by value/key
 */
export const getPaymentStatusOption = (statusValue: string | number): PaymentStatusOption | undefined => {
  if (typeof statusValue === 'number') {
    return PAYMENT_STATUSES.find(s => s.key === statusValue);
  }
  const normalizedStatus = normalizePaymentStatus(statusValue);
  return PAYMENT_STATUSES.find(s => normalizePaymentStatus(s.value) === normalizedStatus);
};

/**
 * Get payment status label by value
 */
export const getPaymentStatusLabel = (statusValue: string | number): string => {
  const status = getPaymentStatusOption(statusValue);
  return status?.label || String(statusValue);
};

/**
 * Get payment status description by value
 */
export const getPaymentStatusDescription = (statusValue: string | number): string => {
  const status = getPaymentStatusOption(statusValue);
  return status?.description || '';
};

/**
 * All valid payment status values
 */
export const VALID_PAYMENT_STATUS_VALUES = PAYMENT_STATUSES.map(s => s.value);

/**
 * Check if a value is a valid payment status
 */
export const isValidPaymentStatus = (value: string | number): boolean => {
  if (typeof value === 'number') {
    return PAYMENT_STATUSES.some(s => s.key === value);
  }
  return VALID_PAYMENT_STATUS_VALUES.includes(normalizePaymentStatus(value));
};

/**
 * Payment Status type for TypeScript
 */
export type PaymentStatus = typeof PAYMENT_STATUSES[number]['value'];
