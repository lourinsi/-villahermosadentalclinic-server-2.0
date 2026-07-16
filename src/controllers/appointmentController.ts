import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { Appointment, ApiResponse } from "../types/appointment";
import {
  OTHER_APPOINTMENT_TYPE_INDEX,
  getAppointmentTypeName,
  getAppointmentPrice,
} from "../utils/appointment-types";
import { hasConflict } from "../utils/appointment-helpers";
import { normalizeAppointmentDuration } from "../utils/appointment-durations";
import {
  CART_APPOINTMENT_STATUS,
  isPatientCartStatus,
  normalizeStatus,
} from "../constants/appointmentStatuses";
import {
  notifyAppointmentChange,
  notifyStatusChange,
  notifyPaymentReceived,
  notifyAppointmentDetailsChange,
  resolveRecipients,
} from "../utils/notifications";
import { createAppointmentLog, getAppointmentLogs } from "../utils/appointmentLogs";
import { createPaymentLog, getPaymentLogs } from "../utils/paymentLogs";
import {
  getPastRestrictedAppointmentStatus,
  markPastAppointmentsAsTbd,
  readAppointmentsWithLifecycle,
} from "../utils/appointmentStatusLifecycle";
import {
  areSameDoctorIdentity,
  findDoctorForValue,
  getDoctorSearchText,
  withResolvedDoctor,
  DoctorIdentity,
} from "../utils/doctorIdentity";
import {
  getPatientDisplayName,
  getPatientSearchText,
  PatientIdentity,
  withResolvedPatient,
} from "../utils/patientIdentity";
import { prisma } from "../lib/prisma";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "your-super-secret-jwt-key-change-this-in-production";
const PUBLIC_APPOINTMENT_TOKEN_SCOPE = "public_appointment";

// Backward compatibility for older public tokens issued before JWT public tokens.
const publicAccessTokens = new Map<string, string>();

const createPublicAppointmentToken = (appointmentId: string) =>
  jwt.sign(
    { scope: PUBLIC_APPOINTMENT_TOKEN_SCOPE, appointmentId },
    JWT_SECRET,
    { expiresIn: "90d" }
  );

const resolvePublicAppointmentToken = (token: string): string | null => {
  if (!token) return null;

  const legacyAppointmentId = publicAccessTokens.get(token);
  if (legacyAppointmentId) return legacyAppointmentId;

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (
      decoded?.scope === PUBLIC_APPOINTMENT_TOKEN_SCOPE &&
      decoded?.appointmentId
    ) {
      return String(decoded.appointmentId);
    }
  } catch {
    return null;
  }

  return null;
};

const toAppointment = (appointment: unknown): Appointment => appointment as Appointment;
type IdParams = { id: string };
const NO_PAYMENT_METHOD_LABEL = "N/A";
const UNASSIGNED_DOCTOR_NAME = "N/A";
const isUnassignedAppointmentDoctor = (value: unknown): boolean =>
  /^(?:__assign_later__|n\/a|na|none|null|undefined|unassigned|no doctor assigned|to assign later|assign later)$/i.test(
    String(value ?? "").trim()
  );

const normalizeAppointmentToothNumbers = (value: unknown): string => {
  if (Array.isArray(value)) {
    return value
      .map((toothNumber) => String(toothNumber ?? "").trim())
      .filter(Boolean)
      .join(", ");
  }

  return String(value ?? "")
    .replace(/[\n;]+/g, ",")
    .split(",")
    .map((toothNumber) => toothNumber.trim())
    .filter(Boolean)
    .join(", ");
};

const normalizeAppointmentTreatments = (value: unknown): any[] | undefined => {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    return value
      .map((treatment) => {
        if (!treatment || typeof treatment !== "object") return null;
        const section = treatment as Record<string, unknown>;
        return {
          type: Number(section.type) || 0,
          customType: String(section.customType ?? section.custom_type ?? "").trim() || undefined,
          treatmentNotes: String(section.treatmentNotes ?? section.treatment_notes ?? "").trim() || undefined,
          toothNumbers: normalizeAppointmentToothNumbers(section.toothNumbers ?? section.tooth_numbers),
        };
      })
      .filter((item) => item !== null);
  }

  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (Array.isArray(parsed)) {
      return normalizeAppointmentTreatments(parsed);
    }
  } catch {
    // ignore invalid JSON
  }

  return undefined;
};

const getActiveDoctorStaff = async (): Promise<DoctorIdentity[]> =>
  prisma.staff.findMany({
    where: { deleted: false },
    select: {
      id: true,
      name: true,
      email: true,
      profilePicture: true,
      role: true,
      specialization: true,
    },
  }) as Promise<DoctorIdentity[]>;

const patientIdentitySelect = {
  id: true,
  name: true,
  firstName: true,
  lastName: true,
  username: true,
  email: true,
  phone: true,
  profilePicture: true,
  dateOfBirth: true,
} as const;

const getActivePatientIdentities = async (patientIds: string[]): Promise<PatientIdentity[]> => {
  const ids = Array.from(
    new Set(
      patientIds
        .map((id) => String(id || "").trim())
        .filter((id) => id && id !== "Occupied" && id !== "No patient assigned")
    )
  );

  if (ids.length === 0) return [];

  return prisma.patient.findMany({
    where: { id: { in: ids }, deleted: false },
    select: patientIdentitySelect,
  }) as Promise<PatientIdentity[]>;
};

const getActivePatientIdentity = async (patientId?: string | null): Promise<PatientIdentity | null> => {
  const id = String(patientId || "").trim();
  if (!id) return null;

  return prisma.patient.findFirst({
    where: { id, deleted: false },
    select: patientIdentitySelect,
  }) as Promise<PatientIdentity | null>;
};

const resolveAppointmentDoctorName = (
  appointment: Partial<Appointment>,
  doctorStaff: DoctorIdentity[]
): { doctor: string; doctorId?: string | null } => {
  if (
    isUnassignedAppointmentDoctor(appointment.doctor) ||
    isUnassignedAppointmentDoctor((appointment as any).doctorName)
  ) {
    return { doctor: UNASSIGNED_DOCTOR_NAME, doctorId: null };
  }

  const doctorValue = (appointment as any).doctorId || (appointment as any).doctorName || appointment.doctor;
  const doctor = findDoctorForValue(doctorStaff, doctorValue);
  return {
    doctor: String(doctor?.name || appointment.doctor || "").trim(),
    doctorId: doctor?.id ? String(doctor.id) : (appointment as any).doctorId,
  };
};

const enrichAppointmentLogReferences = (
  log: any,
  doctorStaff: DoctorIdentity[],
  patients: PatientIdentity[]
) => ({
  ...log,
  previousState: log.previousState
    ? withResolvedDoctor(
        withResolvedPatient(log.previousState as Record<string, any>, patients),
        doctorStaff
      )
    : log.previousState,
  newState: log.newState
    ? withResolvedDoctor(
        withResolvedPatient(log.newState as Record<string, any>, patients),
        doctorStaff
      )
    : log.newState,
});

const isStaffRole = (req: Request): boolean => {
  const role = String((req as any).user?.role || "").toLowerCase();
  return role === "admin" || role === "doctor" || role === "receptionist";
};

const isAdminRole = (req: Request): boolean => {
  const role = String((req as any).user?.role || "").toLowerCase();
  return role === "admin";
};

const isCashPaymentMethod = (method: unknown): boolean =>
  String(method || "").trim().toLowerCase() === "cash";

const normalizePaymentMethodValue = (method: unknown): string => {
  const value = String(method ?? "").trim();
  if (!value || /^(?:n\/?a|none|null|undefined|unknown|payment|payment log)$/i.test(value)) {
    return NO_PAYMENT_METHOD_LABEL;
  }

  return value;
};

type PaymentStatusValue = NonNullable<Appointment["paymentStatus"]>;

const PAYMENT_STATUS_ALIASES: Record<string, PaymentStatusValue | "pay-at-clinic"> = {
  "fully-paid": "paid",
  "full-paid": "paid",
  "paid-in-full": "paid",
  halfpaid: "half-paid",
  half_paid: "half-paid",
  partial: "half-paid",
  "partial-paid": "half-paid",
  "partially-paid": "half-paid",
  payatclinic: "pay-at-clinic",
  "pay-at-clinic": "pay-at-clinic",
  overpaid: "over-paid",
  "over-paid": "over-paid",
};

const hasOwnField = (value: object, field: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, field);

const normalizePaymentStatusValue = (status: unknown): string => {
  const normalized = String(status ?? "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-");
  if (!normalized) return "";

  return PAYMENT_STATUS_ALIASES[normalized] || normalized;
};

const toPaymentNumber = (value: unknown, fallback = 0): number => {
  if (value === null || value === undefined || value === "") return fallback;

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const normalizePaymentDateInput = (value: unknown): string => {
  const text = String(value || "").trim();
  if (!text) return "";

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return "";

  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${parsed.getFullYear()}-${month}-${day}`;
};

const isFuturePaymentDate = (dateValue: string, now: Date = new Date()): boolean => {
  const paymentDate = normalizePaymentDateInput(dateValue);
  if (!paymentDate) return false;

  const [year, month, day] = paymentDate.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return date.getTime() > today.getTime();
};

const buildPaymentDatedAppointmentSnapshot = <T extends Record<string, any>>(
  appointment: T,
  paymentDate: string,
  amount: number
): T => {
  if (amount <= 0 || !paymentDate) return appointment;
  return { ...appointment, paymentDate };
};

const getAppointmentTotalDue = (appointment: Pick<Appointment, "price" | "discount">): number =>
  Math.max(0, toPaymentNumber(appointment.price) - toPaymentNumber(appointment.discount));

const getStoredAppointmentTotalPaid = (appointment: Appointment): number => {
  if (appointment.totalPaid !== undefined && appointment.totalPaid !== null) {
    return Math.max(0, toPaymentNumber(appointment.totalPaid));
  }

  const totalDue = getAppointmentTotalDue(appointment);
  const balance = toPaymentNumber(appointment.balance, totalDue);
  return Math.max(0, totalDue - balance);
};

const getPaymentStatusFromTotals = (totalPaid: number, balance: number): PaymentStatusValue => {
  if (balance < -0.01) return "over-paid";
  if (balance <= 0.01) return "paid";
  if (totalPaid > 0) return "half-paid";
  return "unpaid";
};

const getProjectedPaymentTotals = (
  oldAppointment: Appointment,
  updates: Partial<Appointment>,
  currentTotalPaid: number
) => {
  const updateRecord = updates as Record<string, unknown>;
  const oldPrice = toPaymentNumber(oldAppointment.price);
  const oldDiscount = toPaymentNumber(oldAppointment.discount);
  const nextPrice = hasOwnField(updates, "price")
    ? toPaymentNumber(updateRecord.price, oldPrice)
    : oldPrice;
  const nextDiscount = hasOwnField(updates, "discount")
    ? toPaymentNumber(updateRecord.discount, oldDiscount)
    : oldDiscount;
  const nextTotalPaid = hasOwnField(updates, "totalPaid")
    ? Math.max(0, toPaymentNumber(updateRecord.totalPaid, currentTotalPaid))
    : currentTotalPaid;
  const computedBalance = Math.max(0, nextPrice - nextDiscount - nextTotalPaid);
  const nextBalance = hasOwnField(updates, "balance")
    ? Math.max(0, toPaymentNumber(updateRecord.balance, computedBalance))
    : computedBalance;

  return {
    totalPaid: nextTotalPaid,
    balance: nextBalance,
    computedBalance,
  };
};

const appointmentData = (appointment: Appointment, previousState?: Appointment) => ({
  patientId: appointment.patientId,
  patientName: appointment.patientName,
  date: appointment.date,
  time: appointment.time,
  type: getAppointmentTypeName(appointment.type, appointment.customType),
  doctor: appointment.doctor,
  duration: appointment.duration,
  price: appointment.price,
  discount: appointment.discount,
  balance: appointment.balance,
  totalPaid: appointment.totalPaid,
  status: appointment.status,
  paymentStatus: appointment.paymentStatus,
  cancellationReason: appointment.cancellationReason,
  treatmentNotes: appointment.treatmentNotes,
  toothNumbers: appointment.toothNumbers,
  treatments: appointment.treatments,
  previousState,
  newState: appointment,
});

const todayDateKey = () => new Date().toISOString().split("T")[0];

const createEditablePaymentRecordForAppointment = async ({
  appointment,
  amount,
  method,
  paymentDate,
  appointmentSnapshot,
  notes,
}: {
  appointment: Appointment;
  amount: number;
  method?: string | null;
  paymentDate?: string;
  appointmentSnapshot?: any;
  notes?: string | null;
}) => {
  const paymentAmount = Math.max(0, toPaymentNumber(amount));
  if (!appointment.id || paymentAmount <= 0) return null;

  const recordDate = normalizePaymentDateInput(paymentDate) || todayDateKey();
  const paymentId = `pay_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const paymentMethod = normalizePaymentMethodValue(method || appointment.paymentMethod);
  const snapshot = appointmentSnapshot || appointment;

  const payment = await prisma.payment.create({
    data: {
      id: paymentId,
      appointmentId: appointment.id,
      patientId: appointment.patientId || null,
      amount: paymentAmount,
      method: paymentMethod,
      date: recordDate,
      appointmentSnapshot: snapshot as any,
      transactionId: `T-${Math.random().toString(36).slice(2, 9).toUpperCase()}`,
      notes: notes || "",
      status: "completed",
      createdAt: new Date(),
      updatedAt: new Date(),
      deleted: false,
    },
  });

  await prisma.financeRecord.create({
    data: {
      id: `fin_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      patientId: appointment.patientId || null,
      type: "payment",
      amount: paymentAmount,
      date: recordDate,
      description: `Payment ${payment.id} for appointment ${appointment.id}`,
      appointmentSnapshot: snapshot as any,
      createdAt: new Date(),
      updatedAt: new Date(),
      deleted: false,
    },
  });

  return payment;
};

const buildAppointmentCreateData = (appointment: Appointment) => {
  const basePrice = getAppointmentPrice(appointment.type);
  const discount = Number(appointment.discount) || 0;
  const price = appointment.price ?? basePrice;
  const status = getPastRestrictedAppointmentStatus(
    appointment.date,
    appointment.status || "scheduled"
  );

  return {
    id: `apt_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    patientId: appointment.patientId,
    patientName: appointment.patientName,
    date: appointment.date,
    time: appointment.time,
    type: appointment.type,
    customType: appointment.customType || "",
    price,
    discount,
    doctor: appointment.doctor || "",
    doctorId: appointment.doctorId || null,
    duration: normalizeAppointmentDuration(appointment.duration),
    notes: appointment.notes || "",
    treatmentNotes: appointment.treatmentNotes || "",
    toothNumbers: normalizeAppointmentToothNumbers(appointment.toothNumbers),
    treatments: normalizeAppointmentTreatments(appointment.treatments),
    serviceType: appointment.serviceType || null,
    status,
    cancellationReason: appointment.cancellationReason || null,
    paymentStatus: appointment.paymentStatus || "unpaid",
    paymentMethod: appointment.paymentMethod || null,
    totalPaid: appointment.totalPaid || 0,
    balance: appointment.balance != null ? appointment.balance : Math.max(0, price - discount),
    transactions: appointment.transactions || null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deleted: false,
  };
};

const buildAppointmentUpdateData = (updates: Partial<Appointment>) => {
  const allowed = [
    "patientId",
    "patientName",
    "date",
    "time",
    "type",
    "customType",
    "price",
    "discount",
    "doctor",
    "doctorId",
    "duration",
    "notes",
    "treatmentNotes",
    "toothNumbers",
    "treatments",
    "serviceType",
    "status",
    "cancellationReason",
    "paymentStatus",
    "paymentMethod",
    "balance",
    "totalPaid",
    "transactions", // Keep transactions for backward compatibility if needed, but it's deprecated.
    "deleted",
    "deletedAt",
  ] as const;

  const data: Record<string, any> = {};
  for (const field of allowed) {
    if (Object.prototype.hasOwnProperty.call(updates, field)) {
      data[field] = (updates as any)[field];
    }
  }
  if (Object.prototype.hasOwnProperty.call(data, "duration")) {
    data.duration = normalizeAppointmentDuration(data.duration);
  }
  if (Object.prototype.hasOwnProperty.call(data, "toothNumbers")) {
    data.toothNumbers = normalizeAppointmentToothNumbers(data.toothNumbers);
  }
  if (Object.prototype.hasOwnProperty.call(data, "treatments")) {
    data.treatments = normalizeAppointmentTreatments(data.treatments);
  }
  data.updatedAt = new Date();
  return data;
};

const timeToMinutes = (timeStr: string): number => {
  const [hours, minutes] = String(timeStr || "").split(":").map(Number);
  return (hours || 0) * 60 + (minutes || 0);
};

const REQUEST_APPOINTMENT_STATUSES = new Set(["reserved", "to-pay", "half-paid", "tbd"]);
const HISTORY_APPOINTMENT_STATUSES = new Set(["scheduled", "completed", "cancelled", "deleted"]);

const isDeletedAppointmentStatus = (status?: string | null): boolean =>
  normalizeStatus(status) === "deleted";

const isSoftDeletedAppointment = (appointment: Pick<Appointment, "status" | "deleted">): boolean =>
  Boolean(appointment.deleted) || isDeletedAppointmentStatus(appointment.status);

const getAppointmentResponseStatus = (appointment: Pick<Appointment, "status" | "deleted">): string =>
  isSoftDeletedAppointment(appointment) ? "deleted" : normalizeStatus(appointment.status);

const getAppointmentSortValue = (
  appointment: Appointment,
  sortBy?: string,
  doctorStaff: DoctorIdentity[] = [],
  patients: PatientIdentity[] = []
): string | number => {
  switch (sortBy) {
    case "patient":
      return String(withResolvedPatient(appointment as any, patients).patientName || "").toLowerCase();
    case "service":
      return getAppointmentTypeName(appointment.type, appointment.customType).toLowerCase();
    case "doctor":
      return String(withResolvedDoctor(appointment as any, doctorStaff).doctor || "").toLowerCase();
    case "status":
      return getAppointmentResponseStatus(appointment);
    case "payment":
      return normalizeStatus(appointment.paymentStatus || "unpaid");
    case "booked":
      return appointment.createdAt ? new Date(appointment.createdAt).getTime() : Number.MIN_VALUE;
    case "updated":
      return appointment.updatedAt ? new Date(appointment.updatedAt).getTime() : Number.MIN_VALUE;
    case "date":
    default:
      return `${appointment.date || ""}T${appointment.time || ""}`;
  }
};

const sortAppointments = (
  appointments: Appointment[],
  sortBy?: string,
  sortDirection?: string,
  doctorStaff: DoctorIdentity[] = [],
  patients: PatientIdentity[] = []
) => {
  const direction = sortDirection === "asc" ? "asc" : "desc";
  const column = sortBy || "date";

  return [...appointments].sort((a, b) => {
    const aVal = getAppointmentSortValue(a, column, doctorStaff, patients);
    const bVal = getAppointmentSortValue(b, column, doctorStaff, patients);

    if (aVal < bVal) return direction === "asc" ? -1 : 1;
    if (aVal > bVal) return direction === "asc" ? 1 : -1;
    return 0;
  });
};

const cancelOverlappingPendingAppointments = async (
  appointments: Appointment[],
  newAppointment: Appointment,
  changedBy: string,
  changedByName?: string,
  doctorStaff: DoctorIdentity[] = []
) => {
  const normalizedNewStatus = normalizeStatus(newAppointment.status);
  if (
    isPatientCartStatus(normalizedNewStatus) ||
    normalizedNewStatus === "cancelled" ||
    normalizedNewStatus === "deleted"
  ) return;

  const newStart = timeToMinutes(newAppointment.time);
  const newEnd = newStart + normalizeAppointmentDuration(newAppointment.duration);

  for (const apt of appointments) {
    if (
      apt.deleted ||
      apt.id === newAppointment.id ||
      isDeletedAppointmentStatus(apt.status) ||
      apt.date !== newAppointment.date ||
      !isPatientCartStatus(apt.status)
    ) {
      continue;
    }

    const isSamePatient = newAppointment.patientId && apt.patientId === newAppointment.patientId;
    const newDoctorIdentity = newAppointment.doctorId || newAppointment.doctor;
    const existingDoctorIdentity = apt.doctorId || apt.doctor;
    const isSameDoctor = Boolean(
      newDoctorIdentity &&
      existingDoctorIdentity &&
      areSameDoctorIdentity(newDoctorIdentity, existingDoctorIdentity, doctorStaff)
    );
    if (!isSamePatient && !isSameDoctor) continue;

    const aptStart = timeToMinutes(apt.time);
    const aptEnd = aptStart + normalizeAppointmentDuration(apt.duration);
    if (!(newStart < aptEnd && newEnd > aptStart) || !apt.id) continue;

    const previousState = { ...apt };
    apt.status = "cancelled";
    apt.updatedAt = new Date();

    await prisma.appointment.update({
      where: { id: apt.id },
      data: { status: "cancelled", updatedAt: apt.updatedAt },
    });

    await createAppointmentLog(
      apt.id,
      previousState,
      apt,
      changedBy,
      changedByName || "System",
      "status_change",
      0,
      `Automatically cancelled due to overlap with a ${newAppointment.status} appointment`
    );

    await notifyStatusChange(
      apt.id,
        "status",
        CART_APPOINTMENT_STATUS,
        "cancelled",
      await resolveRecipients(apt),
      appointmentData(withResolvedDoctor(apt as any, doctorStaff) as Appointment)
    );
  }
};

export const addAppointment = async (
  req: Request,
  res: Response<ApiResponse<Appointment>>
) => {
  try {
    const appointments = await readAppointmentsWithLifecycle();
    const doctorStaff = await getActiveDoctorStaff();
    const appointmentInput: Appointment = req.body;
    const appointmentLogNotes = (req.body as any).logNotes || appointmentInput.notes || "";
    const isSeeding = req.body.isSeeding === true;
    const requestedPaymentDate = normalizePaymentDateInput((req.body as any).paymentDate);
    const requestedInitialPaymentAmount = toPaymentNumber(appointmentInput.totalPaid);

    if (requestedInitialPaymentAmount > 0 && (req.body as any).paymentDate && !requestedPaymentDate) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment date",
      });
    }
    if (requestedInitialPaymentAmount > 0 && isFuturePaymentDate(requestedPaymentDate)) {
      return res.status(400).json({
        success: false,
        message: "Payment date cannot be in the future",
      });
    }

    const requestedStatus = getPastRestrictedAppointmentStatus(
      appointmentInput.date,
      appointmentInput.status || "scheduled"
    );

    if (!isSeeding && isStaffRole(req) && isPatientCartStatus(requestedStatus)) {
      return res.status(400).json({
        success: false,
        message: "Staff users cannot create Add to Cart appointments.",
      });
    }
    if (!isSeeding && isCashPaymentMethod(appointmentInput.paymentMethod) && !isStaffRole(req)) {
      return res.status(403).json({
        success: false,
        message: "Cash payments can only be recorded by staff",
      });
    }

    if (
      !appointmentInput.patientId ||
      !appointmentInput.date ||
      !appointmentInput.time ||
      appointmentInput.type == null ||
      appointmentInput.type < 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: patientId, date, time, type",
      });
    }

    const patientRecord = await getActivePatientIdentity(appointmentInput.patientId);
    if (!patientRecord && !isSeeding) {
      return res.status(404).json({
        success: false,
        message: "Patient not found",
      });
    }

    appointmentInput.duration = normalizeAppointmentDuration(appointmentInput.duration);
    appointmentInput.toothNumbers = normalizeAppointmentToothNumbers(
      appointmentInput.toothNumbers ?? (appointmentInput as any).tooth_numbers
    );
    appointmentInput.patientName = getPatientDisplayName(patientRecord, appointmentInput.patientName || appointmentInput.patientId);
    const resolvedDoctor = resolveAppointmentDoctorName(appointmentInput, doctorStaff);
    appointmentInput.doctor = resolvedDoctor.doctor;
    appointmentInput.doctorId = resolvedDoctor.doctorId;

    if (
      !isSeeding &&
      hasConflict(
        appointments,
        appointmentInput.date,
        appointmentInput.time,
        appointmentInput.duration,
        appointmentInput.doctor || "",
        undefined,
        appointmentInput.patientId,
        doctorStaff
      )
    ) {
      return res.status(409).json({
        success: false,
        message: "Conflict detected: Either the doctor or the patient is already busy during this time.",
      });
    }

    if (appointmentInput.type === OTHER_APPOINTMENT_TYPE_INDEX && !appointmentInput.customType) {
      return res.status(400).json({
        success: false,
        message: "Custom type description is required when 'Other' is selected.",
      });
    }

    const createData = buildAppointmentCreateData(appointmentInput);
    const newAppointment = toAppointment(createData);
    const changedBy = (req as any).user?.id || (req as any).user?.username || "admin";
    const changedByName =
      (req as any).user?.name ||
      (req as any).user?.username ||
      (changedBy === "admin" ? "Admin" : changedBy);

    await cancelOverlappingPendingAppointments(appointments, newAppointment, changedBy, changedByName, doctorStaff);

    const created = toAppointment(await prisma.appointment.create({ data: createData as any }));
    const createdForResponse = withResolvedDoctor(
      withResolvedPatient(created as any, patientRecord ? [patientRecord] : []),
      doctorStaff
    ) as Appointment;
    await notifyAppointmentChange(createdForResponse, "created");

    const recipients = await resolveRecipients(createdForResponse);
    if (created.paymentStatus && created.paymentStatus !== "unpaid") {
      await notifyStatusChange(
        created.id || "",
        "payment",
        "unpaid",
        created.paymentStatus,
        recipients,
        appointmentData(createdForResponse)
      );
    }

    const createdLogSnapshot = buildPaymentDatedAppointmentSnapshot(
      created,
      requestedPaymentDate,
      created.totalPaid || 0
    );

    await createAppointmentLog(
      created.id!,
      { status: "none", paymentStatus: "none", price: 0, balance: 0, totalPaid: 0 } as any,
      createdLogSnapshot,
      changedBy,
      changedByName,
      "update",
      created.totalPaid || 0,
      appointmentLogNotes
    );

    if (created.totalPaid && created.totalPaid > 0) {
      const createdPaymentRecord = await createEditablePaymentRecordForAppointment({
        appointment: created,
        amount: created.totalPaid,
        method: normalizePaymentMethodValue(created.paymentMethod),
        paymentDate: requestedPaymentDate,
        appointmentSnapshot: createdLogSnapshot,
        notes: appointmentLogNotes,
      });

      await createPaymentLog(
        created.id!,
        created.totalPaid,
        normalizePaymentMethodValue(created.paymentMethod),
        created.paymentStatus || "unpaid",
        changedBy,
        created.price || 0,
        created.balance || 0,
        changedByName
      );
      await notifyPaymentReceived(
        created.id || "",
        created.totalPaid,
        recipients,
        appointmentData(createdForResponse),
        createdPaymentRecord?.id || `initial_${created.id}`
      );
    }

    res.status(201).json({
      success: true,
      message: "Appointment added successfully",
      data: createdForResponse,
    });
  } catch (error) {
    console.error("[APPOINTMENT CREATE] ERROR:", error);
    res.status(500).json({
      success: false,
      message: "Error adding appointment",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const getAppointments = async (
  req: Request,
  res: Response<ApiResponse<Appointment[]>>
) => {
  try {
    const appointments = await readAppointmentsWithLifecycle();
    const doctorStaff = await getActiveDoctorStaff();
    const {
      startDate,
      endDate,
      search,
      doctor,
      type,
      status,
      patientId,
      parentId,
      anonymize,
      includeUnpaid,
      matchType,
      view,
      page,
      limit,
      sortBy,
      sortDirection,
    } = req.query as Record<string, string>;
    const shouldPaginate = Boolean(page || limit);
    const pageNum = Math.max(1, parseInt(page || "1", 10) || 1);
    const limitNum = Math.max(1, Math.min(100, parseInt(limit || "20", 10) || 20));

    const canSeeDeletedAppointments = isAdminRole(req);
    let filtered = appointments.filter((appointment) => {
      if (isSoftDeletedAppointment(appointment)) {
        return canSeeDeletedAppointments;
      }
      return true;
    });

    if (!canSeeDeletedAppointments) {
      filtered = filtered.filter((appointment) => !isDeletedAppointmentStatus(appointment.status));
    }

    if (isStaffRole(req)) {
      filtered = filtered.filter((appointment) => !isPatientCartStatus(appointment.status));
      if (isPatientCartStatus(status)) filtered = [];
    }

    if (includeUnpaid !== "true" && !isPatientCartStatus(status)) {
      filtered = filtered.filter((appointment) => !isPatientCartStatus(appointment.status));
    }

    const isGlobal = anonymize === "true";

    if (startDate) filtered = filtered.filter((appointment) => appointment.date >= startDate);
    if (endDate) filtered = filtered.filter((appointment) => appointment.date <= endDate);

    const searchablePatients = !isGlobal && search?.trim()
      ? await getActivePatientIdentities(filtered.map((appointment) => appointment.patientId))
      : [];

    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      filtered = filtered.filter(
        (appointment) =>
          getPatientSearchText(appointment.patientId || appointment.patientName, searchablePatients).includes(q) ||
          getAppointmentTypeName(appointment.type, appointment.customType).toLowerCase().includes(q) ||
          getDoctorSearchText(appointment.doctorId || appointment.doctor, doctorStaff).includes(q)
      );
    } else if (matchType === "or" && (doctor || patientId || parentId)) {
      let familyIds: string[] = [];
      if (parentId && !isGlobal) {
        const patients = await prisma.patient.findMany({
          where: { deleted: false, OR: [{ parentId }, { id: parentId }] },
          select: { id: true },
        });
        familyIds = patients.map((patient) => patient.id);
      }

      filtered = filtered.filter((appointment) => {
        if (doctor && doctor !== "all" && areSameDoctorIdentity(appointment.doctorId || appointment.doctor, doctor, doctorStaff)) return true;
        if (!isGlobal && patientId && appointment.patientId === patientId) return true;
        if (!isGlobal && parentId && familyIds.includes(appointment.patientId)) return true;
        return false;
      });
    } else {
      if (parentId && !isGlobal) {
        const patients = await prisma.patient.findMany({
          where: { deleted: false, OR: [{ parentId }, { id: parentId }] },
          select: { id: true },
        });
        const familyIds = new Set(patients.map((patient) => patient.id));
        filtered = filtered.filter((appointment) => familyIds.has(appointment.patientId));
      } else if (patientId && !isGlobal) {
        filtered = filtered.filter((appointment) => appointment.patientId === patientId);
      }

      if (doctor && doctor !== "all") {
        filtered = filtered.filter((appointment) =>
          areSameDoctorIdentity(appointment.doctorId || appointment.doctor, doctor, doctorStaff)
        );
      }
    }

    if (type && type !== "all") {
      filtered = filtered.filter((appointment) => appointment.type === parseInt(type, 10));
    }
    if (view === "requests") {
      filtered = filtered.filter((appointment) =>
        REQUEST_APPOINTMENT_STATUSES.has(normalizeStatus(appointment.status))
      );
    } else if (view === "history") {
      filtered = filtered.filter((appointment) =>
        HISTORY_APPOINTMENT_STATUSES.has(normalizeStatus(appointment.status))
      );
    }
    if (status && status !== "all") {
      filtered = filtered.filter(
        (appointment) =>
          (includeUnpaid === "true" &&
            (appointment.paymentStatus === "unpaid" ||
              isPatientCartStatus(appointment.status) ||
              normalizeStatus(appointment.status) === "tbd")) ||
          normalizeStatus(appointment.status) === normalizeStatus(status)
      );
    }

    if (isGlobal) {
      filtered = filtered.map((appointment) => ({
        ...appointment,
        patientName: "Occupied",
        patientId: "Occupied",
        notes: "",
        price: 0,
        balance: 0,
        totalPaid: 0,
        customType: appointment.type === OTHER_APPOINTMENT_TYPE_INDEX ? "Other" : "",
      }));
    }

    if (sortBy || view || shouldPaginate) {
      const sortPatients = !isGlobal && sortBy === "patient"
        ? await getActivePatientIdentities(filtered.map((appointment) => appointment.patientId))
        : [];
      filtered = sortAppointments(
        filtered,
        sortBy || (view === "requests" ? "booked" : "date"),
        sortDirection,
        doctorStaff,
        sortPatients
      );
    }

    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / limitNum));
    const pageData = shouldPaginate
      ? filtered.slice((pageNum - 1) * limitNum, (pageNum - 1) * limitNum + limitNum)
      : filtered;
    const patientIds = Array.from(
      new Set(pageData.map((appointment) => appointment.patientId).filter(Boolean))
    );
    const pagePatients = isGlobal ? [] : await getActivePatientIdentities(patientIds);

    const response: ApiResponse<Appointment[]> = {
      success: true,
      message: "Appointments retrieved successfully",
      data: pageData.map((appointment) =>
        withResolvedDoctor(
          withResolvedPatient({
            ...appointment,
            status: normalizeStatus(appointment.status),
          }, pagePatients),
          doctorStaff
        ) as Appointment
      ),
    };

    if (shouldPaginate) {
      response.meta = { total, page: pageNum, limit: limitNum, totalPages };
    }

    res.json(response);
  } catch (error) {
    console.error("[APPOINTMENT GET_ALL] Error fetching appointments:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching appointments",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const getPublicAppointmentAvailability = async (
  req: Request,
  res: Response<ApiResponse<Appointment[]>>
) => {
  try {
    const appointments = await readAppointmentsWithLifecycle();
    const doctorStaff = await getActiveDoctorStaff();
    const { startDate, endDate, doctor } = req.query as Record<string, string>;

    let filtered = appointments.filter((appointment) => !appointment.deleted);

    if (startDate) filtered = filtered.filter((appointment) => appointment.date >= startDate);
    if (endDate) filtered = filtered.filter((appointment) => appointment.date <= endDate);
    if (doctor && doctor !== "all") {
      filtered = filtered.filter(
        (appointment) => areSameDoctorIdentity(appointment.doctorId || appointment.doctor, doctor, doctorStaff)
      );
    }

    filtered = filtered.filter((appointment) => {
      const status = normalizeStatus(appointment.status);
      return status !== "cancelled" && status !== "deleted" && !isPatientCartStatus(status);
    });

    res.json({
      success: true,
      message: "Public appointment availability retrieved successfully",
      data: filtered.map((appointment) =>
        withResolvedDoctor({
          ...appointment,
          patientName: "Occupied",
          patientId: "Occupied",
          notes: "",
          price: 0,
          balance: 0,
          totalPaid: 0,
          status: normalizeStatus(appointment.status),
        }, doctorStaff) as Appointment
      ),
    });
  } catch (error) {
    console.error("[PUBLIC APPOINTMENT AVAILABILITY] Error fetching appointments:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching public appointment availability",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const getAppointmentById = async (
  req: Request<IdParams>,
  res: Response<ApiResponse<Appointment | null>>
) => {
  try {
    const doctorStaff = await getActiveDoctorStaff();
    const appointment = toAppointment(
      await prisma.appointment.findUnique({ where: { id: req.params.id } })
    );

    if (
      !appointment ||
      (!isAdminRole(req) && isSoftDeletedAppointment(appointment))
    ) {
      return res.status(404).json({ success: false, message: "Appointment not found" });
    }

    await markPastAppointmentsAsTbd([appointment]);

    if (isStaffRole(req) && isPatientCartStatus(appointment.status)) {
      return res.status(404).json({ success: false, message: "Appointment not found" });
    }

    const patientRecord = await getActivePatientIdentity(appointment.patientId);

    res.json({
      success: true,
      message: "Appointment retrieved successfully",
      data: withResolvedDoctor(
        withResolvedPatient(
          { ...appointment, status: getAppointmentResponseStatus(appointment) },
          patientRecord ? [patientRecord] : []
        ),
        doctorStaff
      ) as Appointment,
    });
  } catch (error) {
    console.error("[APPOINTMENT GET_BY_ID] Error fetching appointment:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching appointment",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const updateAppointment = async (
  req: Request<IdParams>,
  res: Response<ApiResponse<Appointment | null>>
) => {
  try {
    const appointments = await readAppointmentsWithLifecycle();
    const doctorStaff = await getActiveDoctorStaff();
    const { id } = req.params;
    const updates: Partial<Appointment> = req.body;
    if (
      !Object.prototype.hasOwnProperty.call(updates, "toothNumbers") &&
      Object.prototype.hasOwnProperty.call(req.body, "tooth_numbers")
    ) {
      updates.toothNumbers = (req.body as any).tooth_numbers;
    }
    const requestedPaymentDate = normalizePaymentDateInput((req.body as any).paymentDate);
    if ((req.body as any).paymentDate && !requestedPaymentDate) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment date",
      });
    }
    const oldAppointment = appointments.find((appointment) => appointment.id === id);
    if (
      !oldAppointment ||
      (isStaffRole(req) && isPatientCartStatus(oldAppointment.status)) ||
      (!isAdminRole(req) && isSoftDeletedAppointment(oldAppointment))
    ) {
      return res.status(404).json({ success: false, message: "Appointment not found" });
    }
    if (
      Object.prototype.hasOwnProperty.call(updates, "paymentMethod") &&
      isCashPaymentMethod(updates.paymentMethod) &&
      !isStaffRole(req)
    ) {
      return res.status(403).json({
        success: false,
        message: "Cash payments can only be recorded by staff",
      });
    }
    if (Object.prototype.hasOwnProperty.call(updates, "toothNumbers")) {
      updates.toothNumbers = normalizeAppointmentToothNumbers((updates as any).toothNumbers);
    }

    const derivedTotalPaid = getStoredAppointmentTotalPaid(oldAppointment);
    if (
      hasOwnField(updates, "paymentStatus") &&
      normalizePaymentStatusValue(updates.paymentStatus) !== normalizePaymentStatusValue(oldAppointment.paymentStatus || "unpaid") &&
      !isAdminRole(req)
    ) {
      const projectedPaymentTotals = getProjectedPaymentTotals(oldAppointment, updates, derivedTotalPaid);
      const expectedPaymentStatus = getPaymentStatusFromTotals(
        projectedPaymentTotals.totalPaid,
        projectedPaymentTotals.balance
      );
      const paymentAmount = projectedPaymentTotals.totalPaid - derivedTotalPaid;
      const requestedPaymentStatus = normalizePaymentStatusValue(updates.paymentStatus);
      const balanceMatchesTotals = Math.abs(projectedPaymentTotals.balance - projectedPaymentTotals.computedBalance) < 0.01;
      const isDerivedPaymentStatusChange =
        paymentAmount > 0 &&
        balanceMatchesTotals &&
        requestedPaymentStatus === normalizePaymentStatusValue(expectedPaymentStatus);

      if (!isDerivedPaymentStatusChange) {
        return res.status(403).json({
          success: false,
          message: "Only admins can edit payment statuses directly",
        });
      }

      updates.paymentStatus = expectedPaymentStatus;
    }

    const updatedAppointment: Appointment = {
      ...oldAppointment,
      totalPaid: derivedTotalPaid,
      ...updates,
      id: oldAppointment.id,
      updatedAt: new Date(),
    };
    const patientRecord = await getActivePatientIdentity(updatedAppointment.patientId);
    if (!patientRecord && Object.prototype.hasOwnProperty.call(updates, "patientId")) {
      return res.status(404).json({ success: false, message: "Patient not found" });
    }
    if (patientRecord) {
      updatedAppointment.patientName = getPatientDisplayName(
        patientRecord,
        updatedAppointment.patientName || updatedAppointment.patientId
      );
    }
    const resolvedDoctor = resolveAppointmentDoctorName(updatedAppointment, doctorStaff);
    updatedAppointment.doctor = resolvedDoctor.doctor;
    updatedAppointment.doctorId = resolvedDoctor.doctorId;
    updatedAppointment.duration = normalizeAppointmentDuration(updatedAppointment.duration);
    if (updates.duration !== undefined) {
      updates.duration = updatedAppointment.duration;
    }
    const oldWasSoftDeleted = isSoftDeletedAppointment(oldAppointment);
    const statusWasProvided = hasOwnField(updates, "status");
    const deletedWasProvided = hasOwnField(updates, "deleted");
    if (!oldWasSoftDeleted) {
      const restrictedStatus = getPastRestrictedAppointmentStatus(
        updatedAppointment.date,
        updatedAppointment.status
      );
      if (restrictedStatus !== updatedAppointment.status) {
        updatedAppointment.status = restrictedStatus;
        updates.status = restrictedStatus;
      }
    }

    const requestedStatus = statusWasProvided
      ? normalizeStatus(updates.status)
      : normalizeStatus(updatedAppointment.status);
    const shouldRestoreAppointment =
      oldWasSoftDeleted &&
      !(requestedStatus === "deleted" || (deletedWasProvided && updates.deleted === true)) &&
      ((statusWasProvided && requestedStatus !== "deleted") || (deletedWasProvided && updates.deleted === false));
    const shouldDeleteAppointment =
      !shouldRestoreAppointment &&
      (oldWasSoftDeleted || requestedStatus === "deleted" || (deletedWasProvided && updates.deleted === true));

    if (shouldDeleteAppointment) {
      const deletedAt = oldWasSoftDeleted && oldAppointment.deletedAt ? oldAppointment.deletedAt : new Date();
      updatedAppointment.status = "deleted";
      updatedAppointment.deleted = false;
      updatedAppointment.deletedAt = deletedAt;
      updates.status = "deleted";
      updates.deleted = false;
      updates.deletedAt = deletedAt;
    } else if (shouldRestoreAppointment) {
      updatedAppointment.status = "cancelled";
      updatedAppointment.deleted = false;
      updatedAppointment.deletedAt = null;
      updates.status = "cancelled";
      updates.deleted = false;
      updates.deletedAt = updatedAppointment.deletedAt;
    }

    if (isStaffRole(req) && isPatientCartStatus(updatedAppointment.status)) {
      return res.status(400).json({
        success: false,
        message: "Staff users cannot set appointments to Add to Cart.",
      });
    }

    if (updates.date || updates.time || updates.duration !== undefined || updates.doctor || updates.doctorId || updates.patientId) {
      if (
        hasConflict(
          appointments,
          updatedAppointment.date,
          updatedAppointment.time,
          updatedAppointment.duration,
          updatedAppointment.doctor || "",
          id,
          updatedAppointment.patientId,
          doctorStaff
        )
      ) {
        return res.status(409).json({
          success: false,
          message: "Conflict detected: Either the doctor or the patient is already busy during this time.",
        });
      }
    }

    if (
      hasOwnField(updates, "price") ||
      hasOwnField(updates, "discount") ||
      hasOwnField(updates, "totalPaid")
    ) {
      const price = updatedAppointment.price || 0;
      const discount = (updatedAppointment as any).discount || 0;
      updatedAppointment.balance = Math.max(0, price - discount - (updatedAppointment.totalPaid || 0));
      updates.balance = updatedAppointment.balance;
    }

    const changedBy = (req as any).user?.id || (req as any).user?.username || "admin";
    const changedByName =
      (req as any).user?.name ||
      (req as any).user?.username ||
      (changedBy === "admin" ? "Admin" : changedBy);
    await cancelOverlappingPendingAppointments(appointments, updatedAppointment, changedBy, changedByName, doctorStaff);

    const oldStatus = getAppointmentResponseStatus(oldAppointment);
    const oldPaymentStatus = oldAppointment.paymentStatus || "unpaid";
    const oldTotalPaidValue = derivedTotalPaid || 0;
    const newTotalPaidValue = updatedAppointment.totalPaid || 0;
    const paymentAmount = newTotalPaidValue - oldTotalPaidValue;

    if (paymentAmount > 0 && isFuturePaymentDate(requestedPaymentDate)) {
      return res.status(400).json({
        success: false,
        message: "Payment date cannot be in the future",
      });
    }

    let logChangeType: any = "update";
    if (paymentAmount > 0) logChangeType = "payment";
    else if (updates.status && updates.status !== oldStatus) logChangeType = "status_change";
    else if ((updates.date && updates.date !== oldAppointment.date) || (updates.time && updates.time !== oldAppointment.time)) logChangeType = "rescheduled";
    else if (updates.notes !== undefined && updates.notes !== oldAppointment.notes) logChangeType = "notes_update";
    else if ((updates as any).treatmentNotes !== undefined && (updates as any).treatmentNotes !== (oldAppointment as any).treatmentNotes) logChangeType = "notes_update";
    else if ((updates as any).toothNumbers !== undefined && (updates as any).toothNumbers !== (oldAppointment as any).toothNumbers) logChangeType = "notes_update";
    else if ((updates as any).treatments !== undefined && JSON.stringify((updates as any).treatments) !== JSON.stringify((oldAppointment as any).treatments)) logChangeType = "notes_update";
    else if (updates.paymentStatus && updates.paymentStatus !== oldPaymentStatus) logChangeType = "payment";

    if (paymentAmount > 0 || (updates.paymentStatus && updates.paymentStatus !== oldPaymentStatus)) {
      await createPaymentLog(
        id,
        paymentAmount > 0 ? paymentAmount : 0,
        normalizePaymentMethodValue(updatedAppointment.paymentMethod),
        updatedAppointment.paymentStatus || "unpaid",
        changedBy,
        oldAppointment.balance || 0,
        updatedAppointment.balance || 0,
        changedByName
      );
    }

    const saved = toAppointment(
      await prisma.appointment.update({
        where: { id },
        data: buildAppointmentUpdateData(updatedAppointment) as any,
      })
    );
    const savedLogSnapshot = buildPaymentDatedAppointmentSnapshot(saved, requestedPaymentDate, paymentAmount);
    await createAppointmentLog(id, oldAppointment, savedLogSnapshot, changedBy, changedByName, logChangeType, paymentAmount, updates.notes);
    const oldPatientRecord = oldAppointment.patientId === updatedAppointment.patientId
      ? patientRecord
      : await getActivePatientIdentity(oldAppointment.patientId);
    const savedForNotifications = withResolvedDoctor(
      withResolvedPatient(
        { ...saved, status: getAppointmentResponseStatus(saved) } as any,
        patientRecord ? [patientRecord] : []
      ),
      doctorStaff
    ) as Appointment;
    const oldForNotifications = withResolvedDoctor(
      withResolvedPatient(
        { ...oldAppointment, status: getAppointmentResponseStatus(oldAppointment) } as any,
        oldPatientRecord ? [oldPatientRecord] : []
      ),
      doctorStaff
    ) as Appointment;

    const updatedPaymentRecord = paymentAmount > 0
      ? await createEditablePaymentRecordForAppointment({
          appointment: saved,
          amount: paymentAmount,
          method: normalizePaymentMethodValue(updatedAppointment.paymentMethod),
          paymentDate: requestedPaymentDate,
          appointmentSnapshot: buildPaymentDatedAppointmentSnapshot(savedForNotifications as any, requestedPaymentDate, paymentAmount),
          notes: updates.notes || "",
        })
      : null;

    const recipients = await resolveRecipients(savedForNotifications);

    if (paymentAmount > 0) {
      await notifyPaymentReceived(saved.id || "", paymentAmount, recipients, appointmentData(savedForNotifications, oldForNotifications), updatedPaymentRecord?.id || `update_${saved.id}_${Date.now()}`);
    }

    if (updates.status && updates.status !== oldStatus) {
      await notifyStatusChange(saved.id || "", "status", oldStatus, updates.status, recipients, appointmentData(savedForNotifications, oldForNotifications));
    }

    if (updates.paymentStatus && updates.paymentStatus !== oldPaymentStatus) {
      await notifyStatusChange(saved.id || "", "payment", oldPaymentStatus, updates.paymentStatus, recipients, appointmentData(savedForNotifications, oldForNotifications));
    }

    const detailFieldsChanged =
      Object.prototype.hasOwnProperty.call(updates, "date") ||
      Object.prototype.hasOwnProperty.call(updates, "time") ||
      Object.prototype.hasOwnProperty.call(updates, "duration") ||
      Object.prototype.hasOwnProperty.call(updates, "doctor") ||
      Object.prototype.hasOwnProperty.call(updates, "type") ||
      Object.prototype.hasOwnProperty.call(updates, "customType") ||
      Object.prototype.hasOwnProperty.call(updates, "price") ||
      Object.prototype.hasOwnProperty.call(updates, "discount") ||
      Object.prototype.hasOwnProperty.call(updates, "notes") ||
      Object.prototype.hasOwnProperty.call(updates, "treatmentNotes") ||
      Object.prototype.hasOwnProperty.call(updates, "toothNumbers") ||
      Object.prototype.hasOwnProperty.call(updates, "patientId") ||
      Object.prototype.hasOwnProperty.call(updates, "patientName");

    if (detailFieldsChanged && saved.id) {
      await notifyAppointmentDetailsChange(saved.id, recipients, appointmentData(savedForNotifications, oldForNotifications));
    }

    res.json({
      success: true,
      message: "Appointment updated successfully",
      data: savedForNotifications,
    });
  } catch (error) {
    console.error("[APPOINTMENT UPDATE] Error updating appointment:", error);
    res.status(500).json({
      success: false,
      message: "Error updating appointment",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const deleteAppointment = async (
  req: Request<IdParams>,
  res: Response<ApiResponse<Appointment | null>>
) => {
  try {
    const doctorStaff = await getActiveDoctorStaff();
    const appointmentId = req.params.id;
    const hardDeleteRequested = String(req.query.hardDelete || "").toLowerCase() === "true";
    const appointment = toAppointment(
      await prisma.appointment.findUnique({ where: { id: appointmentId } })
    );

    if (!appointment || (isStaffRole(req) && isPatientCartStatus(appointment.status))) {
      return res.status(404).json({ success: false, message: "Appointment not found" });
    }

    if (isSoftDeletedAppointment(appointment)) {
      if (!isAdminRole(req)) {
        return res.status(404).json({ success: false, message: "Appointment not found" });
      }

      if (!hardDeleteRequested) {
        return res.status(400).json({
          success: false,
          message: "Appointment is already deleted. Confirm hard delete to permanently remove it.",
        });
      }

      const payments = await prisma.payment.findMany({
        where: { appointmentId },
        select: { id: true },
      });
      const paymentIds = payments.map((payment) => payment.id);
      const financeRecordFilters: any[] = [
        { description: { contains: appointmentId } },
        { appointmentSnapshot: { path: ["id"], equals: appointmentId } },
      ];

      for (const paymentId of paymentIds) {
        financeRecordFilters.push({ description: { contains: paymentId } });
      }

      await prisma.$transaction([
        prisma.paymentLog.deleteMany({ where: { appointmentId } }),
        prisma.appointmentLog.deleteMany({ where: { appointmentId } }),
        prisma.financeRecord.deleteMany({ where: { OR: financeRecordFilters } }),
        prisma.payment.deleteMany({ where: { appointmentId } }),
        prisma.notification.deleteMany({
          where: {
            OR: [
              { appointmentId },
              { metadata: { path: ["appointmentId"], equals: appointmentId } },
            ],
          },
        }),
        prisma.appointment.delete({ where: { id: appointmentId } }),
      ]);

      return res.json({
        success: true,
        message: "Appointment permanently deleted successfully",
        data: null,
      });
    }

    if (normalizeStatus(appointment.status) !== "cancelled") {
      return res.status(400).json({
        success: false,
        message: "Only cancelled appointments can be deleted",
      });
    }

    const deletedAppointment = toAppointment(await prisma.appointment.update({
      where: { id: appointmentId },
      data: { status: "deleted", deleted: false, deletedAt: new Date(), updatedAt: new Date() },
    }));

    if (appointment.id) {
      const patientRecord = await getActivePatientIdentity(appointment.patientId);
      const notificationAppointment = withResolvedDoctor(
        withResolvedPatient(
          { ...deletedAppointment, status: getAppointmentResponseStatus(deletedAppointment) } as any,
          patientRecord ? [patientRecord] : []
        ),
        doctorStaff
      ) as Appointment;
      await notifyStatusChange(
        appointment.id,
        "status",
        getAppointmentResponseStatus(appointment),
        "deleted",
        await resolveRecipients(notificationAppointment),
        appointmentData(notificationAppointment)
      );
    }

    const patientRecord = await getActivePatientIdentity(deletedAppointment.patientId);
    res.json({
      success: true,
      message: "Appointment marked as deleted successfully",
      data: withResolvedDoctor(
        withResolvedPatient(
          { ...deletedAppointment, status: getAppointmentResponseStatus(deletedAppointment) },
          patientRecord ? [patientRecord] : []
        ),
        doctorStaff
      ) as Appointment,
    });
  } catch (error) {
    console.error("[APPOINTMENT DELETE] Error deleting appointment:", error);
    res.status(500).json({
      success: false,
      message: "Error deleting appointment",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const bookPublicAppointment = async (
  req: Request,
  res: Response<ApiResponse<Appointment>>
) => {
  try {
    const appointments = await readAppointmentsWithLifecycle();
    const doctorStaff = await getActiveDoctorStaff();
    const {
      firstName,
      lastName,
      email,
      phone,
      date,
      time,
      duration,
      type,
      customType,
      doctor,
      notes,
      toothNumbers,
      patientId,
      serviceType,
      // Optional fields that public callers may provide when paying or confirming
      status: requestedStatusFromClient,
      paymentStatus: paymentStatusFromClient,
      totalPaid: totalPaidFromClient,
      paymentMethod: paymentMethodFromClient,
      paymentDate: paymentDateFromClient,
      price: clientPrice,
      discount: clientDiscount,
    } = req.body;
    const requestedPaymentDate = normalizePaymentDateInput(paymentDateFromClient);
    const requestedInitialPaymentAmount = toPaymentNumber(totalPaidFromClient);

    if (!firstName || !lastName || !phone || !date || !time || type == null) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: firstName, lastName, phone, date, time, type",
      });
    }
    if (isCashPaymentMethod(paymentMethodFromClient)) {
      return res.status(403).json({
        success: false,
        message: "Cash payments can only be recorded by staff",
      });
    }
    if (requestedInitialPaymentAmount > 0 && paymentDateFromClient && !requestedPaymentDate) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment date",
      });
    }
    if (requestedInitialPaymentAmount > 0 && isFuturePaymentDate(requestedPaymentDate)) {
      return res.status(400).json({
        success: false,
        message: "Payment date cannot be in the future",
      });
    }

    let patient = patientId
      ? await prisma.patient.findUnique({ where: { id: patientId } })
      : await prisma.patient.findFirst({
          where: {
            deleted: false,
            OR: [{ phone }, ...(email ? [{ email }] : [])],
          },
        });

    if (!patient) {
      const passwordHash = await bcrypt.hash("villahermosa123", 10);
      const newPatientId = `patient_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
      patient = await prisma.patient.create({
        data: {
          id: newPatientId,
          name: `${firstName} ${lastName}`,
          firstName,
          lastName,
          email: email || "",
          phone,
          password: passwordHash,
          parentId: null,
          isPrimary: true,
          dateOfBirth: "",
          address: "",
          city: "",
          zipCode: "",
          emergencyContact: "",
          emergencyPhone: "",
          status: "active",
          createdAt: new Date(),
          updatedAt: new Date(),
          deleted: false,
        },
      });
    }

    // Determine the status the appointment should have, defaulting to cart.
    const requestedStatus = getPastRestrictedAppointmentStatus(
      date,
      String(requestedStatusFromClient || CART_APPOINTMENT_STATUS)
    );

    // Conflict check
    const appointmentDuration = normalizeAppointmentDuration(duration);
    const resolvedDoctor = resolveAppointmentDoctorName({ doctor }, doctorStaff);
    const appointmentDoctor = resolvedDoctor.doctor;
    const patientDisplayName = getPatientDisplayName(patient, `${firstName} ${lastName}`);

    if (hasConflict(appointments, date, time, appointmentDuration, appointmentDoctor, undefined, patient.id, doctorStaff)) {
      return res.status(409).json({
        success: false,
        message: "The selected time is no longer available. Please choose another time.",
      });
    }

    // Build appointment input and create data using helper to keep shapes consistent
    const appointmentInput: Appointment = {
      id: "",
      patientId: patient.id,
      patientName: patientDisplayName,
      date,
      time,
      duration: appointmentDuration,
      type,
      customType: customType || "",
      price: clientPrice ?? getAppointmentPrice(type),
      discount: clientDiscount ?? 0,
      doctor: appointmentDoctor,
      doctorId: resolvedDoctor.doctorId,
      notes: notes || "",
      treatmentNotes: req.body.treatmentNotes || "",
      toothNumbers: normalizeAppointmentToothNumbers(toothNumbers ?? req.body.tooth_numbers),
      treatments: normalizeAppointmentTreatments(req.body.treatments ?? req.body.treatments),
      serviceType: serviceType || "",
      status: requestedStatus,
      cancellationReason: null,
      paymentStatus: paymentStatusFromClient || "unpaid",
      paymentMethod: paymentMethodFromClient || null,
      totalPaid: totalPaidFromClient || 0,
      balance:
        (clientPrice ?? getAppointmentPrice(type)) - (clientDiscount ?? 0) - (totalPaidFromClient || 0),
      transactions: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deleted: false,
    } as any;

    const appointmentLogNotes = (req.body as any).logNotes || notes || "";
    const createData = buildAppointmentCreateData(appointmentInput as Appointment);
    const newAppointment = toAppointment(createData);

    // If the new appointment is not a cart item, cancel overlapping cart appointments.
    const normalizedNewStatus = normalizeStatus(newAppointment.status);
    if (!isPatientCartStatus(normalizedNewStatus) && normalizedNewStatus !== "cancelled") {
      await cancelOverlappingPendingAppointments(appointments, newAppointment, "patient", patientDisplayName, doctorStaff);
    }

    let created = toAppointment(await prisma.appointment.create({ data: createData as any }));
    const createdForResponse = withResolvedDoctor(
      withResolvedPatient(created as any, [patient as PatientIdentity]),
      doctorStaff
    ) as Appointment;

    await notifyAppointmentChange(createdForResponse, "public_request");

    const createdLogSnapshot = buildPaymentDatedAppointmentSnapshot(
      created,
      requestedPaymentDate,
      created.totalPaid || 0
    );

    await createAppointmentLog(
      created.id!,
      { status: "none", paymentStatus: "none", price: 0, balance: 0, totalPaid: 0 } as any,
      createdLogSnapshot,
      "patient",
      patientDisplayName,
      "update",
      created.totalPaid || 0,
      appointmentLogNotes
    );

    if (created.totalPaid && created.totalPaid > 0) {
      const createdPaymentRecord = await createEditablePaymentRecordForAppointment({
        appointment: created,
        amount: created.totalPaid,
        method: normalizePaymentMethodValue(created.paymentMethod),
        paymentDate: requestedPaymentDate,
        appointmentSnapshot: createdLogSnapshot,
        notes: appointmentLogNotes,
      });

      await createPaymentLog(
        created.id!,
        created.totalPaid,
        normalizePaymentMethodValue(created.paymentMethod),
        created.paymentStatus || "unpaid",
        "patient",
        created.price || 0,
        created.balance || 0,
        patientDisplayName
      );
      await notifyPaymentReceived(
        created.id || "",
        created.totalPaid,
        await resolveRecipients(createdForResponse),
        appointmentData(createdForResponse),
        createdPaymentRecord?.id || `initial_${created.id}`
      );
    }

    // Generate a public token so the patient can fetch logs/payments for this appointment
    try {
      const token = createPublicAppointmentToken(created.id!);
      publicAccessTokens.set(token, created.id!);
      const response = { ...createdForResponse, publicToken: token, publicAccessToken: token } as (typeof created) & {
        publicToken: string;
        publicAccessToken: string;
      };
      return res.status(201).json({
        success: true,
        message: "Appointment requested successfully.",
        data: response,
      });
    } catch (err) {
      console.warn("Failed to generate public token for appointment", err);
      res.status(201).json({
        success: true,
        message: "Appointment requested successfully.",
        data: createdForResponse,
      });
    }
  } catch (error) {
    console.error("[PUBLIC BOOKING] ERROR:", error);
    res.status(500).json({
      success: false,
      message: "Error processing your appointment request",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const fetchAppointmentLogs = async (req: Request<IdParams>, res: Response) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ success: false, message: "Appointment ID is required" });
    // attempt to populate req.user from auth token (if present)
    try {
      const authToken = (req as any).cookies?.authToken || (req.headers.authorization || "").split(" ")[1];
      if (authToken) {
        try {
          (req as any).user = jwt.verify(authToken, JWT_SECRET);
        } catch (e) {
          // ignore invalid token
        }
      }
    } catch {
      // ignore auth cookie/header parsing failures
    }

    const appointment = await prisma.appointment.findUnique({ where: { id } });
    if (
      !appointment ||
      (!isAdminRole(req) && isSoftDeletedAppointment(appointment as Appointment))
    ) return res.status(404).json({ success: false, message: "Appointment not found" });

    const publicToken = String(req.query.publicToken || req.headers["x-public-token"] || "");
    const authUser = (req as any).user;
    const isAllowed =
      isStaffRole(req) || // staff can always view
      (authUser && (authUser.id === appointment.patientId || authUser.patientId === appointment.patientId)) || // owning patient
      resolvePublicAppointmentToken(publicToken) === id;

    if (!isAllowed) return res.status(403).json({ success: false, message: "Not authorized to view logs" });

    const doctorStaff = await getActiveDoctorStaff();
    const rawLogs = await getAppointmentLogs(id);
    const logPatientIds = new Set<string>([String(appointment.patientId || "")]);
    for (const log of rawLogs) {
      const previousPatientId = String((log.previousState as any)?.patientId || (log.previousState as any)?.patient?.id || "");
      const nextPatientId = String((log.newState as any)?.patientId || (log.newState as any)?.patient?.id || "");
      if (previousPatientId) logPatientIds.add(previousPatientId);
      if (nextPatientId) logPatientIds.add(nextPatientId);
    }
    const patients = await getActivePatientIdentities(Array.from(logPatientIds));
    const logs = rawLogs.map((log) =>
      enrichAppointmentLogReferences(log, doctorStaff, patients)
    );
    res.json({ success: true, message: "Appointment logs retrieved successfully", data: logs });
  } catch (error) {
    console.error("[APPOINTMENT LOGS GET] Error fetching logs:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching logs",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const fetchPaymentLogs = async (req: Request<IdParams>, res: Response) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ success: false, message: "Appointment ID is required" });
    // attempt to populate req.user from auth token (if present)
    try {
      const authToken = (req as any).cookies?.authToken || (req.headers.authorization || "").split(" ")[1];
      if (authToken) {
        try {
          (req as any).user = jwt.verify(authToken, JWT_SECRET);
        } catch (e) {
          // ignore invalid token
        }
      }
    } catch {
      // ignore auth cookie/header parsing failures
    }

    const appointment = await prisma.appointment.findUnique({ where: { id } });
    if (
      !appointment ||
      (!isAdminRole(req) && isSoftDeletedAppointment(appointment as Appointment))
    ) return res.status(404).json({ success: false, message: "Appointment not found" });

    const publicToken = String(req.query.publicToken || req.headers["x-public-token"] || "");
    const authUser = (req as any).user;
    const isAllowed =
      isStaffRole(req) || // staff can always view
      (authUser && (authUser.id === appointment.patientId || authUser.patientId === appointment.patientId)) || // owning patient
      resolvePublicAppointmentToken(publicToken) === id;

    if (!isAllowed) return res.status(403).json({ success: false, message: "Not authorized to view logs" });

    const logs = await getPaymentLogs(id);
    res.json({ success: true, message: "Payment logs retrieved successfully", data: logs });
  } catch (error) {
    console.error("[PAYMENT LOGS GET] Error fetching logs:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching logs",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
