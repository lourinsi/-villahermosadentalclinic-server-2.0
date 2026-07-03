import { Notification } from "../types/notification";
import { NotificationType } from "../shared/notificationStatuses";
import { getAppointmentTypeName } from "./appointment-types";
import { prisma } from "../lib/prisma";
import { isPatientCartStatus, normalizeStatus } from "../constants/appointmentStatuses";
import { findDoctorForValue } from "./doctorIdentity";

console.log("[notifications] SYSTEM LOADED - Prisma-backed");

const toNotification = (notification: any): Notification => ({
  ...notification,
  createdAt: notification.createdAt?.toISOString?.() || notification.createdAt || new Date().toISOString(),
  updatedAt: notification.updatedAt?.toISOString?.() || notification.updatedAt || undefined,
  deletedAt: notification.deletedAt?.toISOString?.() || notification.deletedAt || undefined,
  metadata: notification.metadata as Notification["metadata"],
  type: notification.type as NotificationType,
});

const sanitizeJson = (value: unknown): any => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeJson(item))
      .filter((item) => item !== undefined);
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).reduce<Record<string, any>>((acc, [key, nestedValue]) => {
      const cleanValue = sanitizeJson(nestedValue);
      if (cleanValue !== undefined) acc[key] = cleanValue;
      return acc;
    }, {});
  }

  return value;
};

const isReceptionistRole = (role?: unknown): boolean =>
  String(role || "").toLowerCase().includes("reception");

const getReceptionistNotificationUserIds = async (): Promise<string[]> => {
  const receptionists = await prisma.staff.findMany({
    where: { deleted: false },
    select: { id: true, role: true },
  });

  return receptionists
    .filter((staff) => staff.id && isReceptionistRole(staff.role))
    .map((staff) => String(staff.id));
};

const getManagementNotificationUserIds = async (): Promise<string[]> =>
  Array.from(new Set(["admin", ...(await getReceptionistNotificationUserIds())]));

type ChangeSummaryItem = {
  field: string;
  label: string;
  from?: string;
  to?: string;
};

type AppointmentNotificationState = Record<string, any>;

type AppointmentNotificationData = {
  patientName: string;
  date: string;
  time: string;
  type: string;
  doctor?: string;
  duration?: number;
  price?: number;
  discount?: number;
  balance?: number;
  totalPaid?: number;
  status?: string;
  paymentStatus?: string;
  cancellationReason?: string;
  treatmentNotes?: string;
  toothNumbers?: string;
  previousState?: AppointmentNotificationState;
  newState?: AppointmentNotificationState;
  changedFields?: { [key: string]: any };
};

export const createNotification = async (
  userId: string,
  title: string,
  message: string,
  type: NotificationType,
  metadata?: Notification["metadata"]
): Promise<Notification> => {
  // Try to populate a stable `notificationImage` in metadata so clients can
  // render avatars without querying staff/patient lists. Prefer an explicit
  // `notificationImage` if provided; otherwise try doctor/patient profiles.
  const resolveNotificationImage = async (meta?: Notification["metadata"]) => {
    if (!meta) return undefined;
    // explicit override
    if (meta.notificationImage) return meta.notificationImage;
    if (meta.doctorProfile) return meta.doctorProfile;
    if (meta.patientProfile) return meta.patientProfile;

    try {
      if (meta.doctorId) {
        const staff = await prisma.staff.findUnique({ where: { id: String(meta.doctorId) } });
        if (staff?.profilePicture) return staff.profilePicture;
      }

      if (meta.doctor) {
        const staff = await prisma.staff.findFirst({ where: { deleted: false, name: String(meta.doctor) } });
        if (staff?.profilePicture) return staff.profilePicture;
      }

      if (meta.patientId) {
        const patient = await prisma.patient.findUnique({ where: { id: String(meta.patientId) } });
        if (patient?.profilePicture) return patient.profilePicture;
      }
    } catch (err) {
      // ignore DB lookup failures and fall back to no image
      console.warn('[notifications] Failed to resolve notification image:', err);
    }

    return undefined;
  };

  const resolvedImage = await resolveNotificationImage(metadata);
  if (resolvedImage && (!metadata || !metadata.notificationImage)) {
    metadata = { ...(metadata || {}), notificationImage: resolvedImage } as any;
  }
  const created = await prisma.notification.create({
    data: {
      userId,
      title,
      message,
      type,
      metadata: sanitizeJson(metadata) as any,
      notificationImage: metadata?.notificationImage || undefined,
      appointmentId: metadata?.appointmentId || undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
      isRead: false,
      deleted: false,
      isLog: false,
    },
  });

  return toNotification(created);
};

export const updateOrCreateNotificationForAppointment = async (
  userId: string,
  appointmentId: string,
  details: {
    title: string;
    message: string;
    type: NotificationType;
    metadata: Notification["metadata"];
  }
): Promise<Notification> => {
  const existingNotification = await prisma.notification.findFirst({
    where: {
      userId,
      type: details.type,
      isLog: false,
      OR: [
        {
          metadata: {
            path: ["appointmentId"],
            equals: appointmentId,
          },
        },
        { appointmentId: appointmentId },
      ],
    },
  });

  if (existingNotification) {
    const updated = await prisma.notification.update({
      where: { id: existingNotification.id },
      data: {
        title: details.title,
        message: details.message,
        type: details.type,
        metadata: sanitizeJson(details.metadata) as any,
        notificationImage: details.metadata?.notificationImage || undefined,
        appointmentId: details.metadata?.appointmentId || undefined,
        isRead: false,
        updatedAt: new Date(),
        deleted: false,
        deletedAt: null,
      },
    });
    return toNotification(updated);
  }

  return createNotification(userId, details.title, details.message, details.type, details.metadata);
};

export const notifyAdmin = async (
  title: string,
  message: string,
  type: NotificationType,
  metadata?: Notification["metadata"]
) => {
  const managementRecipients = await getManagementNotificationUserIds();

  await Promise.all(
    managementRecipients.map((userId) => {
      if (metadata?.appointmentId) {
        return updateOrCreateNotificationForAppointment(userId, metadata.appointmentId, {
          title,
          message,
          type,
          metadata,
        });
      }

      return createNotification(userId, title, message, type, metadata);
    })
  );
};

const formatDoctorName = (name?: string): string => {
  if (!name) return "";
  const cleanName = name.replace(/^Dr\.\s+/i, "");
  return `Dr. ${cleanName}`;
};

const normalizeText = (value: unknown): string => String(value ?? "").trim();

const normalizeDoctorText = (value: unknown): string =>
  normalizeText(value).replace(/^Dr\.\s+/i, "").toLowerCase();

const pickNumber = (...values: unknown[]): number | null => {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const numberValue = Number(value);
    if (Number.isFinite(numberValue)) return numberValue;
  }

  return null;
};

const parseDate = (date?: string): Date | null => {
  const raw = normalizeText(date);
  if (!raw) return null;

  const dateOnlyMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch;
    return new Date(Number(year), Number(month) - 1, Number(day));
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const formatDateLabel = (date?: string): string => {
  const parsed = parseDate(date);
  if (!parsed) return normalizeText(date) || "No date";

  return parsed.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
};

const formatTimeLabel = (time?: string): string => {
  const [hourPart, minutePart = "0"] = normalizeText(time).split(":");
  const hours = Number(hourPart);
  const minutes = Number(minutePart);

  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return normalizeText(time) || "No time";
  }

  return new Date(2000, 0, 1, hours, minutes).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
};

const formatTimeRange = (time?: string, duration?: unknown): string => {
  const startLabel = formatTimeLabel(time);
  const [hourPart, minutePart = "0"] = normalizeText(time).split(":");
  const hours = Number(hourPart);
  const minutes = Number(minutePart);
  const durationMinutes = Number(duration) || 0;

  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || durationMinutes <= 0) {
    return startLabel;
  }

  const end = new Date(2000, 0, 1, hours, minutes + durationMinutes);
  const endTime = `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`;

  return `${startLabel} - ${formatTimeLabel(endTime)}`;
};

const formatScheduleLabel = (state?: AppointmentNotificationState): string => {
  if (!state) return "";
  const dateLabel = formatDateLabel(state.date);
  const timeLabel = formatTimeRange(state.time, state.duration);
  return [dateLabel, timeLabel].filter(Boolean).join(", ");
};

const resolveTreatmentName = (state?: AppointmentNotificationState, fallback?: string): string => {
  if (!state) return fallback || "Appointment";

  const type = state.type;
  const numericType =
    typeof type === "number"
      ? type
      : typeof type === "string" && type.trim() !== ""
        ? Number(type)
        : NaN;

  if (Number.isFinite(numericType)) {
    return getAppointmentTypeName(numericType, state.customType);
  }

  return normalizeText(type) || normalizeText(state.customType) || fallback || "Appointment";
};

const resolvePatientName = (state?: AppointmentNotificationState, fallback?: string): string => {
  if (!state) return fallback || "";

  const patient = state.patient;
  if (typeof patient === "string" && patient.trim()) return patient.trim();

  return (
    normalizeText(state.patientName) ||
    normalizeText(state.patient_name) ||
    normalizeText(patient?.name) ||
    normalizeText(patient?.fullName) ||
    [state.patientFirstName || patient?.firstName, state.patientLastName || patient?.lastName]
      .filter(Boolean)
      .join(" ") ||
    fallback ||
    ""
  );
};

const effectivePrice = (state?: AppointmentNotificationState): number | null => {
  if (!state) return null;
  const basePrice = pickNumber(state.price, state.amount, state.totalPrice);
  if (basePrice === null) return null;

  const discount = pickNumber(state.discount) || 0;
  return Math.max(0, basePrice - discount);
};

const formatMoney = (amount: number): string => `PHP ${amount.toLocaleString()}`;

const addChangeItem = (
  items: ChangeSummaryItem[],
  field: string,
  label: string,
  from?: string,
  to?: string
) => {
  const cleanFrom = normalizeText(from);
  const cleanTo = normalizeText(to);
  if (!cleanFrom && !cleanTo) return;
  if (cleanFrom && cleanTo && cleanFrom === cleanTo) return;

  items.push({
    field,
    label,
    ...(cleanFrom ? { from: cleanFrom } : {}),
    ...(cleanTo ? { to: cleanTo } : {}),
  });
};

const buildAppointmentChangeSummary = (
  data: AppointmentNotificationData,
  fallbackStatusChange?: { field: "status" | "paymentStatus"; from?: string; to?: string }
): ChangeSummaryItem[] => {
  const previousState = data.previousState || {};
  const newState = data.newState || {
    patientName: data.patientName,
    date: data.date,
    time: data.time,
    type: data.type,
    doctor: data.doctor,
    duration: data.duration,
    price: data.price,
    discount: data.discount,
    balance: data.balance,
    totalPaid: data.totalPaid,
    status: data.status,
    paymentStatus: data.paymentStatus,
    toothNumbers: data.toothNumbers,
  };
  const items: ChangeSummaryItem[] = [];
  const hasPreviousState = Object.values(previousState).some(
    (value) => value !== undefined && value !== null && value !== ""
  );

  const scheduleChanged =
    normalizeText(previousState.date) !== normalizeText(newState.date) ||
    normalizeText(previousState.time) !== normalizeText(newState.time) ||
    Number(previousState.duration || 0) !== Number(newState.duration || 0);

  if (hasPreviousState && scheduleChanged && (previousState.date || previousState.time || newState.date || newState.time)) {
    addChangeItem(items, "schedule", "Schedule", formatScheduleLabel(previousState), formatScheduleLabel(newState));
  }

  const previousTreatment = resolveTreatmentName(previousState, data.type);
  const nextTreatment = resolveTreatmentName(newState, data.type);
  if (hasPreviousState && previousTreatment !== nextTreatment) {
    addChangeItem(items, "treatment", "Treatment", previousTreatment, nextTreatment);
  }

  const previousDoctor = normalizeText(previousState.doctor || previousState.doctorName);
  const nextDoctor = normalizeText(newState.doctor || newState.doctorName || data.doctor);
  if (hasPreviousState && normalizeDoctorText(previousDoctor) !== normalizeDoctorText(nextDoctor)) {
    addChangeItem(
      items,
      "doctor",
      "Doctor",
      previousDoctor ? formatDoctorName(previousDoctor) : "No doctor assigned",
      nextDoctor ? formatDoctorName(nextDoctor) : "No doctor assigned"
    );
  }

  const previousPatient = resolvePatientName(previousState, data.patientName);
  const nextPatient = resolvePatientName(newState, data.patientName);
  if (hasPreviousState && previousPatient && nextPatient && previousPatient !== nextPatient) {
    addChangeItem(items, "patient", "Patient", previousPatient, nextPatient);
  }

  const previousPrice = effectivePrice(previousState);
  const nextPrice = effectivePrice(newState);
  if (hasPreviousState && previousPrice !== null && nextPrice !== null && previousPrice !== nextPrice) {
    addChangeItem(items, "price", "Price", formatMoney(previousPrice), formatMoney(nextPrice));
  }

  const previousStatus = normalizeText(previousState.status);
  const nextStatus = normalizeText(newState.status || data.status);
  if (previousStatus && nextStatus && previousStatus !== nextStatus) {
    addChangeItem(items, "status", "Status", previousStatus, nextStatus);
  }

  const previousPaymentStatus = normalizeText(previousState.paymentStatus);
  const nextPaymentStatus = normalizeText(newState.paymentStatus || data.paymentStatus);
  if (previousPaymentStatus && nextPaymentStatus && previousPaymentStatus !== nextPaymentStatus) {
    addChangeItem(items, "paymentStatus", "Payment", previousPaymentStatus, nextPaymentStatus);
  }

  if (hasPreviousState && normalizeText(previousState.notes) !== normalizeText(newState.notes) && (previousState.notes || newState.notes)) {
    addChangeItem(items, "notes", "Notes", previousState.notes ? "Previous notes" : "No notes", newState.notes ? "Updated notes" : "No notes");
  }

  if (
    hasPreviousState &&
    normalizeText(previousState.treatmentNotes) !== normalizeText(newState.treatmentNotes) &&
    (previousState.treatmentNotes || newState.treatmentNotes)
  ) {
    addChangeItem(
      items,
      "treatmentNotes",
      "Treatment Notes",
      previousState.treatmentNotes ? "Previous treatment notes" : "No treatment notes",
      newState.treatmentNotes ? "Updated treatment notes" : "No treatment notes"
    );
  }

  if (
    hasPreviousState &&
    normalizeText(previousState.toothNumbers) !== normalizeText(newState.toothNumbers) &&
    (previousState.toothNumbers || newState.toothNumbers)
  ) {
    addChangeItem(
      items,
      "toothNumbers",
      "Tooth No./s",
      previousState.toothNumbers ? String(previousState.toothNumbers) : "No tooth numbers",
      newState.toothNumbers ? String(newState.toothNumbers) : "No tooth numbers"
    );
  }

  if (
    fallbackStatusChange?.from &&
    fallbackStatusChange?.to &&
    !items.some((item) => item.field === fallbackStatusChange.field)
  ) {
    addChangeItem(
      items,
      fallbackStatusChange.field,
      fallbackStatusChange.field === "paymentStatus" ? "Payment" : "Status",
      fallbackStatusChange.from,
      fallbackStatusChange.to
    );
  }

  return items;
};

const formatChangeSentence = (change: ChangeSummaryItem): string => {
  if (change.from && change.to) return `${change.label} changed from ${change.from} to ${change.to}`;
  if (change.to) return `${change.label} set to ${change.to}`;
  return `${change.label} updated`;
};

const formatChangePreview = (changes: ChangeSummaryItem[], maxItems = 2): string => {
  const preview = changes.slice(0, maxItems).map(formatChangeSentence).join("; ");
  const remaining = changes.length - maxItems;
  if (remaining <= 0) return preview;

  return `${preview}; plus ${remaining} more change${remaining === 1 ? "" : "s"}`;
};

const changedFieldsFromSummary = (changes: ChangeSummaryItem[], changedAt: string) => {
  const fields = changes.reduce<Record<string, any>>((acc, change) => {
    acc[change.field] = {
      from: change.from,
      to: change.to,
    };
    return acc;
  }, {});

  return {
    ...fields,
    changedAt,
    updatedAt: changedAt,
  };
};

const buildAppointmentSnapshotMetadata = (
  appointmentId: string,
  data: AppointmentNotificationData,
  changedAt: string
) => {
  const newState = data.newState || {
    id: appointmentId,
    patientName: data.patientName,
    date: data.date,
    time: data.time,
    type: data.type,
    doctor: data.doctor,
    duration: data.duration,
    price: data.price,
    discount: data.discount,
    balance: data.balance,
    totalPaid: data.totalPaid,
    status: data.status,
    paymentStatus: data.paymentStatus,
    treatmentNotes: data.treatmentNotes,
    toothNumbers: data.toothNumbers,
  };

  return {
    ...newState,
    id: newState.id || appointmentId,
    previousState: data.previousState,
    newState,
    changedAt,
  };
};

const detailedNotificationTitle = (changes: ChangeSummaryItem[]): string => {
  if (changes.length > 1) return "Appointment Details Updated";

  switch (changes[0]?.field) {
    case "schedule":
      return "Schedule Updated";
    case "treatment":
      return "Treatment Updated";
    case "doctor":
      return "Doctor Updated";
    case "patient":
      return "Patient Updated";
    case "price":
      return "Price Updated";
    case "notes":
      return "Appointment Notes Updated";
    case "treatmentNotes":
      return "Treatment Notes Updated";
    case "toothNumbers":
      return "Tooth Numbers Updated";
    default:
      return "Appointment Updated";
  }
};

const possessiveName = (name: string): string => {
  const cleanName = normalizeText(name) || "Patient";
  return cleanName.endsWith("s") ? `${cleanName}'` : `${cleanName}'s`;
};

const detailNotificationMessage = (
  change: ChangeSummaryItem,
  appointmentData: AppointmentNotificationData,
  userId: string
): string => {
  const owner = userId === "admin" || userId.startsWith("staff_")
    ? possessiveName(appointmentData.patientName)
    : "Your";
  const fromTo = change.from && change.to
    ? ` from ${change.from} to ${change.to}`
    : change.to
      ? ` to ${change.to}`
      : "";

  switch (change.field) {
    case "schedule":
      return `${owner} appointment schedule was adjusted${fromTo}.`;
    case "treatment":
      return `${owner} appointment treatment was adjusted${fromTo}.`;
    case "doctor":
      return `${owner} appointment doctor was changed${fromTo}.`;
    case "patient":
      return `The appointment patient was changed${fromTo}.`;
    case "price":
      return `${owner} appointment price was adjusted${fromTo}.`;
    case "notes":
      return `${owner} appointment notes were updated.`;
    case "treatmentNotes":
      return `${owner} appointment treatment notes were updated.`;
    case "toothNumbers":
      return `${owner} appointment tooth numbers were updated.`;
    default:
      return `${owner} appointment ${change.label.toLowerCase()} was updated${fromTo}.`;
  }
};

export const resolveRecipients = async (appointment: any): Promise<string[]> => {
  const recipients = new Set<string>();

  if (appointment.patientId) {
    recipients.add(appointment.patientId);
  }

  const doctorKey = appointment.doctorId || appointment.doctorName || appointment.doctor;
  if (doctorKey) {
    const staff = await prisma.staff.findMany({ where: { deleted: false } });
    const doctor = findDoctorForValue(staff, doctorKey);

    if (doctor?.id) {
      recipients.add(String(doctor.id));
    }
  }

  const managementRecipients = await getManagementNotificationUserIds();
  managementRecipients.forEach((userId) => recipients.add(userId));
  return Array.from(recipients).filter(Boolean);
};

export const notifyAppointmentChange = async (
  appointment: any,
  actionType: "created" | "updated" | "public_request",
  context?: { oldStatus?: string; changedFields?: { [key: string]: any } }
) => {
  const normalizedStatus = normalizeStatus(appointment.status);
  if (isPatientCartStatus(normalizedStatus)) return;

  const serviceName = getAppointmentTypeName(appointment.type, appointment.customType);
  const isRequest = ["reserved", "to-pay", "half-paid", "tbd"].includes(normalizedStatus);
  const recipients = new Map<
    string,
    { title: string; message: string; isDoctor?: boolean; isAdmin?: boolean; isPatient?: boolean }
  >();

  if (appointment.patientId) {
    let title = "Appointment Update";
    let message = `Your appointment for ${serviceName} on ${appointment.date} is now ${appointment.status}.`;

    if (actionType === "created") {
      title = "Appointment Scheduled";
      message = `Your appointment for ${serviceName} is scheduled for ${appointment.date} at ${appointment.time}.`;
    } else if (actionType === "public_request") {
      title = "Appointment Request Received";
      message = `Your request for a ${serviceName} appointment on ${appointment.date} at ${appointment.time} has been received and is awaiting confirmation.`;
    } else if (context?.changedFields?.date || context?.changedFields?.time) {
      title = "Appointment Updated";
      message = `Your appointment for ${serviceName} has been updated to ${appointment.date} at ${appointment.time}.`;
    }

    recipients.set(appointment.patientId, { title, message, isPatient: true });
  }

  const doctorKey = appointment.doctorId || appointment.doctorName || appointment.doctor;
  const staff = doctorKey ? await prisma.staff.findMany({ where: { deleted: false } }) : [];
  const doctorRecord = findDoctorForValue(staff, doctorKey);
  const appointmentDoctorName = String(doctorRecord?.name || appointment.doctor || "").trim();

  if (doctorKey) {
    const doctor = doctorRecord;
    if (doctor?.id) {
      recipients.set(String(doctor.id), {
        title: isRequest ? "New Appointment Request" : "Appointment Update",
        message: `${appointment.patientName} has a ${appointment.status} appointment for ${serviceName} on ${appointment.date} at ${appointment.time}.`,
        isDoctor: true,
      });
    }
  }

  const managementRecipients = await getManagementNotificationUserIds();
  const doctorText = appointmentDoctorName ? ` with ${formatDoctorName(appointmentDoctorName)}` : "";
  managementRecipients.forEach((userId) => {
    if (recipients.has(userId)) return;
    recipients.set(userId, {
      title: isRequest ? "New Appointment Request" : "Appointment Update",
      message: `${appointment.patientName} has a ${appointment.status} appointment${doctorText} for ${serviceName} on ${appointment.date} at ${appointment.time}.`,
      isAdmin: true,
    });
  });

  if (!recipients.has("admin")) {
    recipients.set("admin", {
      title: isRequest ? "New Appointment Request" : "Appointment Update",
      message: `${appointment.patientName} has a ${appointment.status} appointment${doctorText} for ${serviceName} on ${appointment.date} at ${appointment.time}.`,
      isAdmin: true,
    });
  }

  await Promise.all(
    Array.from(recipients.entries()).map(([userId, data]) =>
      updateOrCreateNotificationForAppointment(userId, appointment.id, {
        title: data.title,
        message: data.message,
        type: "appointment",
        metadata: {
          appointmentId: appointment.id,
          currentStatus: appointment.status,
          patientName: appointment.patientName,
          appointmentDate: appointment.date,
          appointmentTime: appointment.time,
          isRequest,
          isDoctorView: data.isDoctor,
          isAdminView: data.isAdmin,
          isPatientView: data.isPatient,
          changedFields: context?.changedFields,
        },
      })
    )
  );
};

export const createStatusChangeNotification = async (
  userId: string,
  appointmentId: string,
  changeDetails: {
    oldStatus?: string;
    newStatus?: string;
    oldPaymentStatus?: string;
    newPaymentStatus?: string;
  },
  appointmentData: AppointmentNotificationData,
  amount?: number
) => {
  const { oldStatus, newStatus, oldPaymentStatus, newPaymentStatus } = changeDetails;
  const { patientName, date, time, type, doctor, cancellationReason } = appointmentData;
  const docName = formatDoctorName(doctor);
  const doctorWithSuffix = docName ? ` with ${docName}` : "";
  const receptionistIds = await getReceptionistNotificationUserIds();
  const isAdmin = userId === "admin" || receptionistIds.includes(userId);
  const isDoctor = !isAdmin && userId.startsWith("staff_");

  let title = "Appointment Updated";
  let message = "";
  let notificationType: NotificationType = "appointment";

  let subjectText = `Your appointment${doctorWithSuffix}`;
  if (isAdmin) subjectText = `${patientName}'s appointment${doctorWithSuffix}`;
  else if (isDoctor) subjectText = `${patientName}'s appointment`;

  if (newStatus) {
    title = "Appointment Status Changed";
    message =
      newStatus === "cancelled" && cancellationReason
        ? `${subjectText} for ${type} on ${date} has been cancelled. Reason: ${cancellationReason}`
        : `${subjectText} for ${type} on ${date} is now ${newStatus}.`;
  } else if (newPaymentStatus) {
    title = "Payment Status Updated";
    notificationType = "payment";
    const amountText = amount ? ` of PHP ${amount.toLocaleString()}` : "";
    let paymentSubjectText = `The payment status for your ${type} appointment${doctorWithSuffix}`;
    if (isAdmin) paymentSubjectText = `The payment status for ${patientName}'s ${type} appointment${doctorWithSuffix}`;
    else if (isDoctor) paymentSubjectText = `The payment status for ${patientName}'s ${type} appointment`;
    message = `${paymentSubjectText}${amountText} on ${date} is now ${newPaymentStatus}.`;
  }

  const changedAt = new Date().toISOString();
  const targetChangeField = newStatus ? "status" : "paymentStatus";
  let changeSummary = buildAppointmentChangeSummary(
    appointmentData,
    newStatus
      ? { field: "status", from: oldStatus, to: newStatus }
      : { field: "paymentStatus", from: oldPaymentStatus, to: newPaymentStatus }
  ).filter((change) => change.field === targetChangeField);

  if (changeSummary.length === 0) {
    changeSummary = [{
      field: targetChangeField,
      label: targetChangeField === "paymentStatus" ? "Payment" : "Status",
      from: newStatus ? oldStatus : oldPaymentStatus,
      to: newStatus || newPaymentStatus,
    }];
  }

  await createNotification(userId, title, message, notificationType, {
    appointmentId,
    currentStatus: newStatus || oldStatus,
    patientName,
    appointmentDate: date,
    appointmentTime: time,
    doctor: docName,
    amount,
    cancellationReason,
    changedFields: changedFieldsFromSummary(changeSummary, changedAt),
    changeSummary,
    appointmentSnapshot: buildAppointmentSnapshotMetadata(appointmentId, appointmentData, changedAt),
    logDate: changedAt,
  });
};

export const updateNotificationMetadata = async (
  userId: string,
  appointmentId: string,
  updates: {
    title?: string;
    message?: string;
    metadata?: Partial<Notification["metadata"]>;
  }
) => {
  const existing = await prisma.notification.findFirst({
    where: {
      userId,
      isLog: false,
      OR: [
        { metadata: { path: ["appointmentId"], equals: appointmentId } },
        { appointmentId: appointmentId },
      ],
    },
  });

  if (!existing) return;

  await prisma.notification.update({
    where: { id: existing.id },
    data: {
      ...(updates.title && { title: updates.title }),
      ...(updates.message && { message: updates.message }),
      metadata: {
        ...sanitizeJson((existing.metadata as Record<string, unknown>) || {}),
        ...sanitizeJson(updates.metadata || {}),
      } as any,
      updatedAt: new Date(),
    },
  });
};

export const archiveNotificationAsLog = async (
  userId: string,
  appointmentId: string,
  type?: NotificationType
) => {
  const notifications = await prisma.notification.findMany({
    where: {
      userId,
      isLog: false,
      ...(type ? { type } : {}),
      OR: [
        { metadata: { path: ["appointmentId"], equals: appointmentId } },
        { appointmentId: appointmentId },
      ],
    },
  });

  await Promise.all(
    notifications.map((notification) =>
      prisma.notification.update({
        where: { id: notification.id },
        data: { isLog: true, isRead: true, updatedAt: new Date() },
      })
    )
  );
};

export const notifyAppointmentDetailsChange = async (
  appointmentId: string,
  recipientUserIds: string[],
  appointmentData: AppointmentNotificationData
) => {
  const changeSummary = buildAppointmentChangeSummary(appointmentData).filter(
    (change) => change.field !== "status" && change.field !== "paymentStatus"
  );

  if (changeSummary.length === 0) return;

  await Promise.all(
    recipientUserIds.map(async (userId) => {
      const docName = formatDoctorName(appointmentData.doctor);

      await Promise.all(
        changeSummary.map((change) => {
          const changedAt = new Date().toISOString();
          const singleChangeSummary = [change];

          return createNotification(userId, detailedNotificationTitle(singleChangeSummary), detailNotificationMessage(change, appointmentData, userId), "appointment", {
            appointmentId,
            currentStatus: appointmentData.status || appointmentData.newState?.status || appointmentData.previousState?.status,
            patientName: appointmentData.patientName,
            appointmentDate: appointmentData.date,
            appointmentTime: appointmentData.time,
            doctor: docName,
            changedFields: changedFieldsFromSummary(singleChangeSummary, changedAt),
            changeSummary: singleChangeSummary,
            appointmentSnapshot: buildAppointmentSnapshotMetadata(appointmentId, appointmentData, changedAt),
            logDate: changedAt,
          });
        })
      );
    })
  );
};

export const notifyStatusChange = async (
  appointmentId: string,
  changeType: "status" | "payment",
  oldValue: string,
  newValue: string,
  recipientUserIds: string[],
  appointmentData: AppointmentNotificationData,
  amount?: number
) => {
  await Promise.all(
    recipientUserIds.map(async (userId) => {
      if (changeType === "status") {
        await archiveNotificationAsLog(userId, appointmentId, "appointment");
        await createStatusChangeNotification(
          userId,
          appointmentId,
          { oldStatus: oldValue, newStatus: newValue },
          appointmentData
        );
      } else {
        await createStatusChangeNotification(
          userId,
          appointmentId,
          { oldPaymentStatus: oldValue, newPaymentStatus: newValue },
          appointmentData,
          amount
        );
      }
    })
  );
};

export const notifyPaymentReceived = async (
  appointmentId: string,
  amount: number,
  recipients: string[],
  appointmentData: AppointmentNotificationData,
  paymentId?: string
) => {
  const { patientName, date, type, doctor } = appointmentData;
  const formattedAmount = `PHP ${amount.toLocaleString()}`;
  const receptionistIds = await getReceptionistNotificationUserIds();

  await Promise.all(
    recipients.map((userId) => {
      const isAdmin = userId === "admin" || receptionistIds.includes(userId);
      const isDoctor = !isAdmin && userId.startsWith("staff_");
      const docName = formatDoctorName(doctor);
      const doctorWithSuffix = docName ? ` with ${docName}` : "";

      let title = "Payment Received";
      let message = `We've received a payment of ${formattedAmount} for your ${type} appointment${doctorWithSuffix} on ${date}.`;

      if (isAdmin) {
        title = "New Payment Recorded";
        message = `A payment of ${formattedAmount} has been recorded for ${patientName}'s ${type} appointment${doctorWithSuffix} on ${date}.`;
      } else if (isDoctor) {
        message = `A payment of ${formattedAmount} has been recorded for ${patientName}'s ${type} appointment on ${date}.`;
      }

      return createNotification(userId, title, message, "payment", {
        appointmentId,
        paymentId,
        patientName,
        appointmentDate: date,
        appointmentTime: appointmentData.time,
        doctor: docName,
        amount,
        paymentDate: new Date().toISOString(),
      });
    })
  );
};
