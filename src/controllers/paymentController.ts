import { Request, Response } from "express";
import { Payment, ApiResponse } from "../types/payment";
import { hasConflict } from "../utils/appointment-helpers";
import {
  notifyAdmin,
  notifyPaymentReceived,
  notifyStatusChange,
  resolveRecipients,
} from "../utils/notifications";
import { getAppointmentTypeName } from "../utils/appointment-types";
import { createAppointmentLog } from "../utils/appointmentLogs";
import { createPaymentLog } from "../utils/paymentLogs";
import { readAppointmentsWithLifecycle } from "../utils/appointmentStatusLifecycle";
import { prisma } from "../lib/prisma";
import {
  isPatientCartStatus,
  normalizeStatus,
} from "../constants/appointmentStatuses";
import { DoctorIdentity, withResolvedDoctor } from "../utils/doctorIdentity";
import { PatientIdentity, withResolvedPatient } from "../utils/patientIdentity";

const toPayment = (payment: unknown): Payment => payment as Payment;
const toAppointment = (appointment: unknown): any => appointment as any;
type IdParams = { id: string };

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

const getActivePatientIdentities = async (patientIds: Array<string | null | undefined>): Promise<PatientIdentity[]> => {
  const ids = Array.from(
    new Set(patientIds.map((id) => String(id || "").trim()).filter(Boolean))
  );
  if (ids.length === 0) return [];

  return prisma.patient.findMany({
    where: { id: { in: ids }, deleted: false },
    select: patientIdentitySelect,
  }) as Promise<PatientIdentity[]>;
};

const withResolvedAppointmentReferences = (
  appointment: any,
  doctorStaff: DoctorIdentity[],
  patients: PatientIdentity[]
) => withResolvedDoctor(withResolvedPatient(appointment, patients), doctorStaff);

const getPaymentSnapshotPatientIds = (payment: any): string[] => [
  payment.patientId,
  payment.appointmentSnapshot?.patientId,
  payment.appointmentSnapshot?.patient?.id,
].filter(Boolean).map(String);

const hydratePaymentSnapshots = async (payments: any[]): Promise<Payment[]> => {
  const snapshotPayments = payments.map(toPayment);
  const doctorStaff = await getActiveDoctorStaff();
  const patients = await getActivePatientIdentities(snapshotPayments.flatMap(getPaymentSnapshotPatientIds));

  return snapshotPayments.map((payment: any) => ({
    ...payment,
    appointmentSnapshot: payment.appointmentSnapshot
      ? withResolvedAppointmentReferences(payment.appointmentSnapshot, doctorStaff, patients)
      : payment.appointmentSnapshot,
  }));
};

const paymentStatusFor = (totalPaid: number, balance: number): string => {
  if (balance <= 0) return "paid";
  if (totalPaid > 0) return "half-paid";
  return "unpaid";
};

const appointmentData = (appointment: any, previousState?: any) => ({
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
  toothNumbers: appointment.toothNumbers,
  previousState,
  newState: appointment,
});

const isStaffRole = (req: Request): boolean => {
  const role = String((req as any).user?.role || "").toLowerCase();
  return role === "admin" || role === "doctor";
};

const isCashPaymentMethod = (method: unknown): boolean =>
  String(method || "").trim().toLowerCase() === "cash";

const todayDateKey = () => new Date().toISOString().split("T")[0];

const dateOnlyKey = (value: unknown): string => {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().split("T")[0];

  const text = String(value || "").trim();
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().split("T")[0];
};

const numericAmount = (value: unknown) => {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? amount : 0;
};

const normalizePaymentMethod = (method?: string | null) =>
  String(method || "").trim().toLowerCase();

const normalizeEditablePaymentLookupId = (id: string) => {
  const raw = String(id || "").trim();
  if (raw.startsWith("payment-log-pay_log_")) return raw.replace(/^payment-log-/, "");
  if (raw.startsWith("appointment-log-apt_log_")) return raw.replace(/^appointment-log-/, "");
  return raw;
};

const getClosestAppointmentPaymentLog = async (paymentLog: any) => {
  const appointmentLogs = await prisma.appointmentLog.findMany({
    where: {
      appointmentId: paymentLog.appointmentId,
      OR: [
        { changeType: "payment" },
        { amount: paymentLog.amount },
      ],
    },
    orderBy: { changedAt: "desc" },
  });

  const paymentLogTime = paymentLog.changedAt ? new Date(paymentLog.changedAt).getTime() : 0;
  const amount = Math.abs(numericAmount(paymentLog.amount));

  return (
    appointmentLogs.find((log) => {
      const logTime = log.changedAt ? new Date(log.changedAt).getTime() : 0;
      const timeMatches = paymentLogTime && logTime ? Math.abs(paymentLogTime - logTime) <= 10_000 : true;
      const amountMatches = Math.abs(Math.abs(numericAmount(log.amount)) - amount) < 0.01;
      return timeMatches && amountMatches;
    }) ||
    appointmentLogs.find((log) => Math.abs(Math.abs(numericAmount(log.amount)) - amount) < 0.01) ||
    appointmentLogs[0]
  );
};

const materializePaymentFromPaymentLog = async (paymentLogId: string): Promise<Payment | null> => {
  if (!paymentLogId.startsWith("pay_log_")) return null;

  const paymentLog = await prisma.paymentLog.findUnique({ where: { id: paymentLogId } });
  if (!paymentLog || !paymentLog.appointmentId || numericAmount(paymentLog.amount) <= 0) return null;

  const appointment = toAppointment(await prisma.appointment.findUnique({ where: { id: paymentLog.appointmentId } }));
  if (!appointment || appointment.deleted || normalizeStatus(appointment.status) === "deleted") return null;

  const matchingAppointmentLog = await getClosestAppointmentPaymentLog(paymentLog);
  const logSnapshot =
    matchingAppointmentLog?.newState && typeof matchingAppointmentLog.newState === "object"
      ? matchingAppointmentLog.newState as any
      : null;
  const doctorStaff = await getActiveDoctorStaff();
  const patients = await getActivePatientIdentities([appointment.patientId]);
  const appointmentSnapshot = withResolvedAppointmentReferences(
    {
      ...appointment,
      ...(logSnapshot || {}),
      id: logSnapshot?.id || appointment.id,
      appointmentId: paymentLog.appointmentId,
      paymentDate: dateOnlyKey(logSnapshot?.paymentDate) || dateOnlyKey(paymentLog.changedAt) || todayDateKey(),
      paymentMethod: paymentLog.paymentMethod || logSnapshot?.paymentMethod || appointment.paymentMethod,
    },
    doctorStaff,
    patients
  );
  const paymentDate = dateOnlyKey(appointmentSnapshot.paymentDate) || dateOnlyKey(paymentLog.changedAt) || todayDateKey();
  const paymentAmount = Math.abs(numericAmount(paymentLog.amount));
  const paymentMethod = paymentLog.paymentMethod || appointmentSnapshot.paymentMethod || "unknown";

  const existingPayments = await prisma.payment.findMany({
    where: {
      deleted: false,
      appointmentId: paymentLog.appointmentId,
      amount: paymentAmount,
    },
    orderBy: { createdAt: "desc" },
  });
  const existing =
    existingPayments.find((payment) => payment.transactionId === paymentLog.id) ||
    existingPayments.find((payment) =>
      dateOnlyKey(payment.date) === paymentDate &&
      (!payment.method || normalizePaymentMethod(payment.method) === normalizePaymentMethod(paymentMethod))
    ) ||
    existingPayments.find((payment) => dateOnlyKey(payment.date) === paymentDate);

  if (existing) return toPayment(existing);

  const payment = toPayment(await prisma.payment.create({
    data: {
      id: `pay_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      appointmentId: paymentLog.appointmentId,
      patientId: appointment.patientId || null,
      amount: paymentAmount,
      method: paymentMethod,
      date: paymentDate,
      appointmentSnapshot,
      transactionId: paymentLog.id,
      notes: paymentLog.changedByName ? `Recorded by ${paymentLog.changedByName}` : "",
      status: paymentLog.paymentStatus || "completed",
      createdAt: paymentLog.changedAt || new Date(),
      updatedAt: new Date(),
      deleted: false,
    },
  }));

  await prisma.financeRecord.create({
    data: {
      id: `fin_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      patientId: appointment.patientId || null,
      type: "payment",
      amount: paymentAmount,
      date: paymentDate,
      description: `Payment ${payment.id} for appointment ${paymentLog.appointmentId}`,
      appointmentSnapshot,
      createdAt: new Date(),
      updatedAt: new Date(),
      deleted: false,
    },
  });

  return payment;
};

const materializePaymentFromAppointmentLog = async (appointmentLogId: string): Promise<Payment | null> => {
  if (!appointmentLogId.startsWith("apt_log_")) return null;

  const appointmentLog = await prisma.appointmentLog.findUnique({ where: { id: appointmentLogId } });
  if (!appointmentLog || !appointmentLog.appointmentId || numericAmount(appointmentLog.amount) <= 0) return null;
  if (String(appointmentLog.changeType || "").toLowerCase() === "payment_adjustment") return null;

  const appointment = toAppointment(await prisma.appointment.findUnique({ where: { id: appointmentLog.appointmentId } }));
  if (!appointment || appointment.deleted || normalizeStatus(appointment.status) === "deleted") return null;

  const logSnapshot =
    appointmentLog.newState && typeof appointmentLog.newState === "object"
      ? appointmentLog.newState as any
      : null;
  const doctorStaff = await getActiveDoctorStaff();
  const patients = await getActivePatientIdentities([appointment.patientId]);
  const appointmentSnapshot = withResolvedAppointmentReferences(
    {
      ...appointment,
      ...(logSnapshot || {}),
      id: logSnapshot?.id || appointment.id,
      appointmentId: appointmentLog.appointmentId,
      paymentDate: dateOnlyKey(logSnapshot?.paymentDate) || dateOnlyKey(appointmentLog.changedAt) || todayDateKey(),
      paymentMethod: logSnapshot?.paymentMethod || appointment.paymentMethod,
    },
    doctorStaff,
    patients
  );
  const paymentDate = dateOnlyKey(appointmentSnapshot.paymentDate) || dateOnlyKey(appointmentLog.changedAt) || todayDateKey();
  const paymentAmount = Math.abs(numericAmount(appointmentLog.amount));
  const paymentMethod = appointmentSnapshot.paymentMethod || "unknown";

  const existingPayments = await prisma.payment.findMany({
    where: {
      deleted: false,
      appointmentId: appointmentLog.appointmentId,
      amount: paymentAmount,
    },
    orderBy: { createdAt: "desc" },
  });
  const existing =
    existingPayments.find((payment) => payment.transactionId === appointmentLog.id) ||
    existingPayments.find((payment) =>
      dateOnlyKey(payment.date) === paymentDate &&
      (!payment.method || normalizePaymentMethod(payment.method) === normalizePaymentMethod(paymentMethod))
    ) ||
    existingPayments.find((payment) => dateOnlyKey(payment.date) === paymentDate);

  if (existing) return toPayment(existing);

  const payment = toPayment(await prisma.payment.create({
    data: {
      id: `pay_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      appointmentId: appointmentLog.appointmentId,
      patientId: appointment.patientId || null,
      amount: paymentAmount,
      method: paymentMethod,
      date: paymentDate,
      appointmentSnapshot,
      transactionId: appointmentLog.id,
      notes: appointmentLog.notes || "",
      status: appointmentSnapshot.paymentStatus || "completed",
      createdAt: appointmentLog.changedAt || new Date(),
      updatedAt: new Date(),
      deleted: false,
    },
  }));

  await prisma.financeRecord.create({
    data: {
      id: `fin_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      patientId: appointment.patientId || null,
      type: "payment",
      amount: paymentAmount,
      date: paymentDate,
      description: `Payment ${payment.id} for appointment ${appointmentLog.appointmentId}`,
      appointmentSnapshot,
      createdAt: new Date(),
      updatedAt: new Date(),
      deleted: false,
    },
  });

  return payment;
};

const findPaymentOrMaterialize = async (id: string): Promise<Payment | null> => {
  const lookupId = normalizeEditablePaymentLookupId(id);
  const existing = toPayment(await prisma.payment.findUnique({ where: { id: lookupId } }));
  if (existing && !existing.deleted) return existing;
  return (await materializePaymentFromPaymentLog(lookupId)) || materializePaymentFromAppointmentLog(lookupId);
};

const buildPaymentAdjustmentDetails = (oldPayment: Payment, updatedPayment: Payment, amountDiff: number) => ({
  isAdjustment: true,
  paymentId: oldPayment.id,
  transactionId: updatedPayment.transactionId || oldPayment.transactionId || null,
  previousAmount: Number(oldPayment.amount || 0),
  newAmount: Number(updatedPayment.amount || 0),
  delta: amountDiff,
  previousMethod: oldPayment.method || null,
  newMethod: updatedPayment.method || null,
  previousDate: oldPayment.date || null,
  newDate: updatedPayment.date || null,
});

export const createPayment = async (req: Request, res: Response<ApiResponse<any>>) => {
  try {
    const { appointmentId, patientId, amount, method, date, transactionId, notes } = req.body;
    if (!appointmentId || amount === undefined || isNaN(Number(amount))) {
      return res.status(400).json({ success: false, message: "Missing appointmentId or invalid amount" });
    }
    if (isCashPaymentMethod(method) && !isStaffRole(req)) {
      return res.status(403).json({ success: false, message: "Cash payments can only be recorded by admins or doctors" });
    }

    const appointment = toAppointment(
      await prisma.appointment.findUnique({ where: { id: appointmentId } })
    );
    if (!appointment || appointment.deleted || normalizeStatus(appointment.status) === "deleted") {
      return res.status(404).json({ success: false, message: "Appointment not found" });
    }
    const doctorStaff = await getActiveDoctorStaff();
    const patients = await getActivePatientIdentities([patientId || appointment.patientId]);
    const appointmentForDisplay = withResolvedAppointmentReferences(appointment, doctorStaff, patients);

    if (transactionId) {
      const existing = await prisma.payment.findFirst({
        where: { transactionId, deleted: false },
      });
      if (existing) {
        return res.json({
          success: true,
          message: "Payment already exists",
          data: { payment: toPayment(existing) },
        });
      }
    }

    const payAmount = Number(amount);
    const isPayAtClinic = method === "Pay at Clinic";
    const newPaymentData = {
      id: `pay_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      appointmentId,
      patientId: patientId || appointment.patientId,
      amount: payAmount,
      method: method || "unknown",
      date: date || new Date().toISOString().split("T")[0],
      transactionId:
        transactionId ||
        `${isPayAtClinic ? "PAC" : "T"}-${Math.random().toString(36).slice(2, 9).toUpperCase()}`,
      notes: notes || (isPayAtClinic ? "Cash upon appointment" : ""),
      status: isPayAtClinic && payAmount === 0 ? "pending" : "completed",
      createdAt: new Date(),
      updatedAt: new Date(),
      deleted: false,
    };

    const newPayment =
      !isPayAtClinic || payAmount > 0
        ? toPayment(await prisma.payment.create({ data: newPaymentData }))
        : (newPaymentData as Payment);
    const paymentDate = newPayment.date;

    const oldAppointment = { ...appointment };
    const totalPaid = (appointment.totalPaid || 0) + payAmount;
    const balance = (appointment.price || 0) - (appointment.discount || 0) - totalPaid;
    const oldStatus = normalizeStatus(appointment.status);
    const oldPaymentStatus = appointment.paymentStatus || "unpaid";
    let newStatus = appointment.status;
    const newPaymentStatus = paymentStatusFor(totalPaid, balance);

    if (isPatientCartStatus(appointment.status)) {
      const appointments = await readAppointmentsWithLifecycle();
      const conflict = hasConflict(
        appointments,
        appointment.date,
        appointment.time,
        appointment.duration || 60,
        appointment.doctorId || appointment.doctor || "",
        appointment.id,
        undefined,
        doctorStaff
      );

      if (conflict) {
        await notifyAdmin(
          "Appointment Conflict Detected",
          `${appointmentForDisplay.patientName} tried to confirm an appointment on ${appointment.date} at ${appointment.time}, but this slot is already taken.`,
          "appointment",
          { appointmentId: appointment.id, patientName: appointmentForDisplay.patientName }
        );
      } else if (!isPayAtClinic) {
        if (newPaymentStatus === "paid") newStatus = "scheduled";
        else if (newPaymentStatus === "half-paid") newStatus = "reserved";
      }
    }

    const updatedAppointment = toAppointment(
      await prisma.appointment.update({
        where: { id: appointmentId },
        data: {
          totalPaid,
          balance,
          paymentStatus: newPaymentStatus,
          status: newStatus,
          updatedAt: new Date(),
        },
      })
    );

    const changedBy = (req as any).user?.id || (req as any).user?.username || "admin";
    const changedByName =
      (req as any).user?.name ||
      (req as any).user?.username ||
      (changedBy === "admin" ? "Admin" : changedBy);

    const updatedAppointmentWithPaymentDate = {
      ...updatedAppointment,
      paymentDate,
      paymentMethod: method || updatedAppointment.paymentMethod,
    };

    await createAppointmentLog(
      appointmentId,
      oldAppointment,
      updatedAppointmentWithPaymentDate,
      changedBy,
      changedByName,
      "payment",
      payAmount,
      notes
    );

    if (payAmount > 0) {
      await createPaymentLog(
        appointmentId,
        payAmount,
        method || "unknown",
        updatedAppointment.paymentStatus || "unpaid",
        changedBy,
        oldAppointment.balance || 0,
        updatedAppointment.balance || 0,
        changedByName
      );
    }

    const recipients = await resolveRecipients(updatedAppointment);
    const oldAppointmentForNotifications = withResolvedAppointmentReferences(oldAppointment, doctorStaff, patients);
    const updatedAppointmentForNotifications = withResolvedAppointmentReferences(updatedAppointmentWithPaymentDate, doctorStaff, patients);
    if (updatedAppointment.status !== oldStatus) {
      await notifyStatusChange(
        appointmentId,
        "status",
        oldStatus,
        updatedAppointment.status,
        recipients,
        appointmentData(updatedAppointmentForNotifications, oldAppointmentForNotifications)
      );
    }
    if (updatedAppointment.paymentStatus !== oldPaymentStatus) {
      await notifyStatusChange(
        appointmentId,
        "payment",
        oldPaymentStatus,
        updatedAppointment.paymentStatus,
        recipients,
        appointmentData(updatedAppointmentForNotifications, oldAppointmentForNotifications)
      );
    }
    if (payAmount > 0) {
      await notifyPaymentReceived(
        appointmentId,
        payAmount,
        recipients,
        appointmentData(updatedAppointmentForNotifications, oldAppointmentForNotifications),
        newPayment.id
      );
    }

    await prisma.patient.updateMany({
      where: { id: patientId || appointment.patientId },
      data: { balance: { decrement: payAmount }, updatedAt: new Date() },
    });

    // Persist an immutable appointment snapshot on the payment record (if payment persisted)
    try {
      if (newPayment && (newPayment as any).id) {
        await prisma.payment.update({
          where: { id: (newPayment as any).id },
          data: { appointmentSnapshot: updatedAppointmentForNotifications },
        });
        // refresh newPayment object to include appointmentSnapshot
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        // (we intentionally keep types loose for snapshot payload)
        // Note: ignore result; returning object below will include updated appointment from DB
      }
    } catch (err) {
      console.warn("Failed to attach appointmentSnapshot to payment record:", err);
    }

    await prisma.financeRecord.create({
      data: {
        id: `fin_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        patientId: newPayment.patientId,
        type: "payment",
        amount: newPayment.amount,
        date: newPayment.date,
        description: `Payment ${newPayment.id} for appointment ${appointmentId}`,
        appointmentSnapshot: updatedAppointmentForNotifications,
        createdAt: new Date(),
        updatedAt: new Date(),
        deleted: false,
      },
    });

    res.status(201).json({
      success: true,
      message: "Payment created",
      data: { payment: newPayment, appointment: updatedAppointmentForNotifications },
    });
  } catch (error) {
    console.error("[CREATE PAYMENT] Error:", error);
    res.status(500).json({
      success: false,
      message: "Error creating payment",
      error: error instanceof Error ? error.message : error,
    });
  }
};

export const getPaymentsByAppointment = async (
  req: Request<IdParams>,
  res: Response<ApiResponse<Payment[]>>
) => {
  try {
    const payments = await prisma.payment.findMany({
      where: { deleted: false, appointmentId: req.params.id },
      orderBy: { createdAt: "desc" },
    });
    res.json({ success: true, data: await hydratePaymentSnapshots(payments) });
  } catch (error) {
    console.error("[GET PAYMENTS] Error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching payments",
      error: error instanceof Error ? error.message : error,
    });
  }
};

export const getPaymentsByPatient = async (
  req: Request<IdParams>,
  res: Response<ApiResponse<Payment[]>>
) => {
  try {
    const payments = await prisma.payment.findMany({
      where: { deleted: false, patientId: req.params.id },
      orderBy: { createdAt: "desc" },
    });
    res.json({ success: true, data: await hydratePaymentSnapshots(payments) });
  } catch (error) {
    console.error("[GET PAYMENTS PATIENT] Error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching payments",
      error: error instanceof Error ? error.message : error,
    });
  }
};

export const getPaymentById = async (
  req: Request<IdParams>,
  res: Response<ApiResponse<Payment>>
) => {
  try {
    const normalizedPayment = await findPaymentOrMaterialize(req.params.id);

    if (!normalizedPayment || normalizedPayment.deleted) {
      return res.status(404).json({ success: false, message: "Payment not found" });
    }

    const [hydratedPayment] = await hydratePaymentSnapshots([normalizedPayment]);
    res.json({ success: true, data: hydratedPayment });
  } catch (error) {
    console.error("[GET PAYMENT] Error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching payment",
      error: error instanceof Error ? error.message : error,
    });
  }
};

export const updatePayment = async (req: Request<IdParams>, res: Response<ApiResponse<any>>) => {
  try {
    const { id } = req.params;
    const { amount, method, date, transactionId, notes, appointmentId } = req.body;

    const oldPayment = await findPaymentOrMaterialize(id);
    if (!oldPayment || oldPayment.deleted) {
      return res.status(404).json({ success: false, message: "Payment not found" });
    }
    const paymentId = oldPayment.id;

    const updatedPayment = toPayment(
      await prisma.payment.update({
        where: { id: paymentId },
        data: {
          amount: amount !== undefined ? Number(amount) : oldPayment.amount,
          method: method || oldPayment.method,
          date: date || oldPayment.date,
          transactionId: transactionId || oldPayment.transactionId,
          notes: notes !== undefined ? notes : oldPayment.notes,
          appointmentId: appointmentId || oldPayment.appointmentId,
          updatedAt: new Date(),
        },
      })
    );

    const amountDiff = updatedPayment.amount - oldPayment.amount;
    if (amountDiff !== 0) {
      const appointment = toAppointment(
        await prisma.appointment.findUnique({ where: { id: oldPayment.appointmentId } })
      );
      if (appointment) {
        const doctorStaff = await getActiveDoctorStaff();
        const patients = await getActivePatientIdentities([appointment.patientId, oldPayment.patientId]);
        const oldAppointment = { ...appointment };
        const totalPaid = Math.max(0, (appointment.totalPaid || 0) + amountDiff);
        const balance = (appointment.price || 0) - (appointment.discount || 0) - totalPaid;
        const oldPaymentStatus = appointment.paymentStatus || "unpaid";
        const newPaymentStatus = paymentStatusFor(totalPaid, balance);
        const savedAppointment = toAppointment(
          await prisma.appointment.update({
            where: { id: oldPayment.appointmentId },
            data: { totalPaid, balance, paymentStatus: newPaymentStatus, updatedAt: new Date() },
          })
        );

        const changedBy = (req as any).user?.id || (req as any).user?.username || "admin";
        const changedByName =
          (req as any).user?.name ||
          (req as any).user?.username ||
          (changedBy === "admin" ? "Admin" : changedBy);
        const paymentAdjustment = buildPaymentAdjustmentDetails(oldPayment, updatedPayment, amountDiff);
        const savedAppointmentWithPaymentDate = {
          ...savedAppointment,
          paymentDate: updatedPayment.date || oldPayment.date,
          paymentMethod: updatedPayment.method || oldPayment.method,
          paymentAdjustment,
        };
        await createAppointmentLog(
          oldPayment.appointmentId,
          oldAppointment,
          savedAppointmentWithPaymentDate,
          changedBy,
          changedByName,
          "payment_adjustment",
          amountDiff,
          notes
        );

        const recipients = await resolveRecipients(savedAppointment);
        const oldAppointmentForNotifications = withResolvedAppointmentReferences(oldAppointment, doctorStaff, patients);
        const savedAppointmentForNotifications = withResolvedAppointmentReferences(savedAppointmentWithPaymentDate, doctorStaff, patients);
        if (savedAppointment.paymentStatus !== oldPaymentStatus) {
          await notifyStatusChange(
            oldPayment.appointmentId,
            "payment",
            oldPaymentStatus,
            savedAppointment.paymentStatus,
            recipients,
            appointmentData(savedAppointmentForNotifications, oldAppointmentForNotifications)
          );
        }

        await prisma.payment.update({
          where: { id: paymentId },
          data: { appointmentSnapshot: savedAppointmentForNotifications as any, updatedAt: new Date() },
        });
      }

      await prisma.patient.updateMany({
        where: { id: oldPayment.patientId || undefined },
        data: { balance: { decrement: amountDiff }, updatedAt: new Date() },
      });

    }

    await prisma.financeRecord.updateMany({
      where: { description: { contains: `Payment ${paymentId}` } },
      data: { amount: updatedPayment.amount, date: updatedPayment.date, updatedAt: new Date() },
    });

    res.json({ success: true, message: "Payment updated", data: { payment: updatedPayment } });
  } catch (error) {
    console.error("[UPDATE PAYMENT] Error:", error);
    res.status(500).json({
      success: false,
      message: "Error updating payment",
      error: error instanceof Error ? error.message : error,
    });
  }
};

export const deletePayment = async (req: Request<IdParams>, res: Response<ApiResponse<any>>) => {
  try {
    const { id } = req.params;
    const payment = await findPaymentOrMaterialize(id);
    if (!payment || payment.deleted) {
      return res.status(404).json({ success: false, message: "Payment not found" });
    }

    await prisma.payment.update({
      where: { id: payment.id },
      data: { deleted: true, updatedAt: new Date() },
    });

    const appointment = toAppointment(
      await prisma.appointment.findUnique({ where: { id: payment.appointmentId } })
    );
    if (appointment) {
      const doctorStaff = await getActiveDoctorStaff();
      const patients = await getActivePatientIdentities([appointment.patientId, payment.patientId]);
      const oldAppointment = { ...appointment };
      const totalPaid = Math.max(0, (appointment.totalPaid || 0) - payment.amount);
      const balance = (appointment.price || 0) - (appointment.discount || 0) - totalPaid;
      const oldPaymentStatus = appointment.paymentStatus || "unpaid";
      const newPaymentStatus = paymentStatusFor(totalPaid, balance);
      const savedAppointment = toAppointment(
        await prisma.appointment.update({
          where: { id: payment.appointmentId },
          data: { totalPaid, balance, paymentStatus: newPaymentStatus, updatedAt: new Date() },
        })
      );

      const changedBy = (req as any).user?.id || (req as any).user?.username || "admin";
      const changedByName =
        (req as any).user?.name ||
        (req as any).user?.username ||
        (changedBy === "admin" ? "Admin" : changedBy);
      await createAppointmentLog(
        payment.appointmentId,
        oldAppointment,
        savedAppointment,
        changedBy,
        changedByName,
        "payment",
        -payment.amount,
        "Payment deleted"
      );

      await createPaymentLog(
        payment.appointmentId,
        -payment.amount,
        payment.method || "unknown",
        savedAppointment.paymentStatus || "unpaid",
        changedBy,
        oldAppointment.balance || 0,
        savedAppointment.balance || 0,
        changedByName
      );

      if (savedAppointment.paymentStatus !== oldPaymentStatus) {
        const oldAppointmentForNotifications = withResolvedAppointmentReferences(oldAppointment, doctorStaff, patients);
        const savedAppointmentForNotifications = withResolvedAppointmentReferences(savedAppointment, doctorStaff, patients);
        await notifyStatusChange(
          payment.appointmentId,
          "payment",
          oldPaymentStatus,
          savedAppointment.paymentStatus,
          await resolveRecipients(savedAppointment),
          appointmentData(savedAppointmentForNotifications, oldAppointmentForNotifications)
        );
      }
    }

    await prisma.patient.updateMany({
      where: { id: payment.patientId || undefined },
      data: { balance: { increment: payment.amount }, updatedAt: new Date() },
    });

    await prisma.financeRecord.updateMany({
      where: { description: { contains: `Payment ${payment.id}` } },
      data: { deleted: true, updatedAt: new Date() },
    });

    res.json({
      success: true,
      message: "Payment deleted successfully",
      data: { payment: { ...payment, deleted: true } },
    });
  } catch (error) {
    console.error("[DELETE PAYMENT] Error:", error);
    res.status(500).json({
      success: false,
      message: "Error deleting payment",
      error: error instanceof Error ? error.message : error,
    });
  }
};
