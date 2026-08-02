import { Appointment } from "../types/appointment";
import { normalizeStatus } from "../constants/appointmentStatuses";
import { createAppointmentLog } from "./appointmentLogs";
import { getAppointmentTypeName } from "./appointment-types";
import { notifyStatusChange, resolveRecipients } from "./notifications";
import { prisma } from "../lib/prisma";
import { DoctorIdentity, withResolvedDoctor } from "./doctorIdentity";
import { PatientIdentity, withResolvedPatient } from "./patientIdentity";

const TBD_STATUS = "tbd";
const FINAL_STATUSES = new Set(["cancelled", "completed", "deleted"]);
const PAST_APPOINTMENT_STATUSES = new Set([TBD_STATUS, ...FINAL_STATUSES]);

interface LifecycleResult {
  updatedCount: number;
  updatedIds: string[];
}

const toAppointment = (appointment: unknown): Appointment => appointment as Appointment;

const appointmentNotificationData = (appointment: Appointment, previousState: Appointment) => ({
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
  toothNumbers: appointment.toothNumbers,
  previousState,
  newState: appointment,
});

const parseAppointmentDate = (dateValue?: string): Date | null => {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue || "");
  if (!dateMatch) return null;

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const date = new Date(year, month - 1, day);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }

  return date;
};

export const isPastAppointmentDate = (
  dateValue?: string,
  now: Date = new Date()
): boolean => {
  const appointmentDate = parseAppointmentDate(dateValue);
  if (!appointmentDate) return false;

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return appointmentDate.getTime() < today.getTime();
};

export const getPastRestrictedAppointmentStatus = (
  dateValue?: string,
  status?: string,
  now: Date = new Date(),
  paymentStatus?: string
): string => {
  const normalizedStatus = normalizeStatus(status);
  if (FINAL_STATUSES.has(normalizedStatus)) {
    return normalizedStatus;
  }

  const isPast = isPastAppointmentDate(dateValue, now);

  if (!isPast) {
    if (normalizedStatus === "tbd" || normalizedStatus === "overdue") {
      return "scheduled";
    }
    return normalizedStatus || "scheduled";
  }

  const normPayment = String(paymentStatus || "").toLowerCase().trim();
  const isFullyPaid = normPayment === "paid" || normPayment === "over-paid" || normPayment === "fully-paid";

  if (isFullyPaid && (normalizedStatus === "overdue" || normalizedStatus === "tbd")) {
    return TBD_STATUS;
  }

  return PAST_APPOINTMENT_STATUSES.has(normalizedStatus) ? normalizedStatus : TBD_STATUS;
};


const shouldMarkAppointmentAsTbd = (appointment: Appointment, now: Date): boolean => {
  if (appointment.deleted) return false;

  const normalizedStatus = normalizeStatus(appointment.status);
  if (FINAL_STATUSES.has(normalizedStatus) || normalizedStatus === TBD_STATUS) return false;

  return isPastAppointmentDate(appointment.date, now);
};

export const markPastAppointmentsAsTbd = async (
  appointments: Appointment[],
  now: Date = new Date()
): Promise<LifecycleResult> => {
  const updatedIds: string[] = [];

  for (const appointment of appointments) {
    if (!shouldMarkAppointmentAsTbd(appointment, now) || !appointment.id) continue;

    const previousState: Appointment = { ...appointment };
    appointment.status = TBD_STATUS;
    appointment.updatedAt = now;
    updatedIds.push(appointment.id);

    await prisma.appointment.update({
      where: { id: appointment.id },
      data: { status: TBD_STATUS, updatedAt: now },
    });

    const [patientRecord, doctorStaff] = await Promise.all([
      appointment.patientId
        ? prisma.patient.findFirst({
            where: { id: appointment.patientId, deleted: false },
            select: {
              id: true,
              name: true,
              firstName: true,
              lastName: true,
              username: true,
              email: true,
              phone: true,
              profilePicture: true,
              dateOfBirth: true,
            },
          }) as Promise<PatientIdentity | null>
        : Promise.resolve(null),
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
      }) as Promise<DoctorIdentity[]>,
    ]);
    const patientRecords = patientRecord ? [patientRecord] : [];
    const previousStateForLog = withResolvedDoctor(
      withResolvedPatient(previousState as any, patientRecords),
      doctorStaff
    ) as Appointment;
    const appointmentForLog = withResolvedDoctor(
      withResolvedPatient({ ...appointment } as any, patientRecords),
      doctorStaff
    ) as Appointment;

    await createAppointmentLog(
      appointment.id,
      previousStateForLog,
      appointmentForLog,
      "system",
      "System",
      "status_change",
      0,
      "Automatically marked TBD because the appointment date passed without completion or cancellation."
    );

    await notifyStatusChange(
      appointment.id,
      "status",
      normalizeStatus(previousStateForLog.status),
      TBD_STATUS,
      await resolveRecipients(appointmentForLog),
      appointmentNotificationData(appointmentForLog, previousStateForLog)
    );
  }

  if (updatedIds.length > 0) {
    console.log(
      `[APPOINTMENT LIFECYCLE] Marked ${updatedIds.length} past appointment(s) as TBD: ${updatedIds.join(", ")}`
    );
  }

  return {
    updatedCount: updatedIds.length,
    updatedIds,
  };
};

export const syncPastAppointmentsToTbd = async (
  now: Date = new Date()
): Promise<LifecycleResult> => {
  const appointments = (await prisma.appointment.findMany({
    where: { deleted: false },
  })).map(toAppointment);

  return markPastAppointmentsAsTbd(appointments, now);
};

export const readAppointmentsWithLifecycle = async (
  now: Date = new Date()
): Promise<Appointment[]> => {
  const appointments = (await prisma.appointment.findMany()).map(toAppointment);
  await markPastAppointmentsAsTbd(appointments, now);
  return appointments;
};
