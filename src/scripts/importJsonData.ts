import fs from "fs";
import path from "path";
import { prisma } from "../lib/prisma";
import { normalizeStatus } from "../constants/appointmentStatuses";

const DATA_DIR =
  process.env.JSON_DATA_DIR ||
  path.resolve(__dirname, "..", "..", "..", "villahermosa backend data");

const readJson = <T>(filename: string, fallback: T): T => {
  const filePath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
};

const readArray = <T extends Record<string, any> = Record<string, any>>(
  filename: string
): T[] => {
  const value = readJson<T[] | Record<string, unknown>>(filename, []);
  return Array.isArray(value) ? value : [];
};

const toDate = (value: unknown): Date | null => {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
};

const toNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const toBool = (value: unknown, fallback = false): boolean => {
  if (typeof value === "boolean") return value;
  return fallback;
};

const text = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  return String(value);
};

const requiredText = (value: unknown, fallback: string): string => {
  const result = text(value);
  return result && result.length > 0 ? result : fallback;
};

const importRows = async <T extends Record<string, any>>(
  label: string,
  rows: T[],
  importRow: (row: T, index: number) => Promise<void>
) => {
  for (const [index, row] of rows.entries()) {
    await importRow(row, index);
  }
  console.log(`[IMPORT] ${label}: ${rows.length} row(s)`);
};

const main = async () => {
  console.log(`[IMPORT] Reading JSON data from ${DATA_DIR}`);

  await importRows("patients", readArray("patients.json"), async (patient, index) => {
    const id = requiredText(patient.id, `patient_import_${index}`);
    const data = {
      id,
      name: requiredText(patient.name, `${text(patient.firstName) || ""} ${text(patient.lastName) || ""}`.trim() || id),
      firstName: text(patient.firstName),
      lastName: text(patient.lastName),
      email: text(patient.email),
      phone: text(patient.phone),
      alternateEmail: text(patient.alternateEmail),
      alternatePhone: text(patient.alternatePhone),
      password: text(patient.password),
      dateOfBirth: text(patient.dateOfBirth),
      address: text(patient.address),
      city: text(patient.city),
      zipCode: text(patient.zipCode),
      insurance: text(patient.insurance),
      status: text(patient.status),
      emergencyContact: text(patient.emergencyContact),
      emergencyPhone: text(patient.emergencyPhone),
      medicalHistory: text(patient.medicalHistory),
      treatmentPlan: text(patient.treatmentPlan),
      clinicalNotes: text(patient.clinicalNotes),
      allergies: text(patient.allergies),
      notes: text(patient.notes),
      profilePicture: text(patient.profilePicture),
      parentId: text(patient.parentId),
      isPrimary: typeof patient.isPrimary === "boolean" ? patient.isPrimary : null,
      relationship: text(patient.relationship),
      username: text(patient.username),
      dentalCharts: patient.dentalCharts ?? null,
      balance: toNumber(patient.balance),
      lastVisit: text(patient.lastVisit),
      gender: text(patient.gender),
      civilStatus: text(patient.civilStatus),
      age: text(patient.age),
      ethnicity: text(patient.ethnicity),
      religion: text(patient.religion),
      nationality: text(patient.nationality),
      currentStreet: text(patient.currentStreet),
      currentBarangay: text(patient.currentBarangay),
      currentProvince: text(patient.currentProvince),
      permanentStreet: text(patient.permanentStreet),
      permanentBarangay: text(patient.permanentBarangay),
      permanentCity: text(patient.permanentCity),
      permanentProvince: text(patient.permanentProvince),
      permanentZipCode: text(patient.permanentZipCode),
      landline: text(patient.landline),
      emergencyFirstName: text(patient.emergencyFirstName),
      emergencyLastName: text(patient.emergencyLastName),
      emergencyRelationship: text(patient.emergencyRelationship),
      education: text(patient.education),
      occupation: text(patient.occupation),
      company: text(patient.company),
      companyAddress: text(patient.companyAddress),
      height: text(patient.height),
      weight: text(patient.weight),
      createdAt: toDate(patient.createdAt),
      updatedAt: toDate(patient.updatedAt),
      deleted: toBool(patient.deleted),
      deletedAt: toDate(patient.deletedAt),
    };

    await prisma.patient.upsert({
      where: { id },
      create: data as any,
      update: data as any,
    });
  });

  await importRows("staff", readArray("staff.json"), async (staff, index) => {
    const id = requiredText(staff.id, `staff_import_${index}`);
    const data = {
      id,
      name: requiredText(staff.name, id),
      role: requiredText(staff.role, "Staff"),
      department: text(staff.department),
      email: text(staff.email),
      phone: text(staff.phone),
      hireDate: text(staff.hireDate),
      baseSalary: toNumber(staff.baseSalary),
      status: text(staff.status),
      employmentType: text(staff.employmentType),
      specialization: text(staff.specialization),
      licenseNumber: text(staff.licenseNumber),
      password: text(staff.password),
      profilePicture: text(staff.profilePicture),
      bio: text(staff.bio),
      createdAt: toDate(staff.createdAt),
      updatedAt: toDate(staff.updatedAt),
      deleted: toBool(staff.deleted),
      deletedAt: toDate(staff.deletedAt),
    };

    await prisma.staff.upsert({
      where: { id },
      create: data as any,
      update: data as any,
    });
  });

  await importRows("appointments", readArray("appointments.json"), async (appointment, index) => {
    const id = requiredText(appointment.id, `appointment_import_${index}`);
    const data = {
      id,
      patientId: requiredText(appointment.patientId, ""),
      patientName: requiredText(appointment.patientName, ""),
      date: requiredText(appointment.date, ""),
      time: requiredText(appointment.time, ""),
      type: Number.isInteger(appointment.type) ? appointment.type : Number(appointment.type || 0),
      customType: text(appointment.customType),
      price: toNumber(appointment.price),
      discount: toNumber(appointment.discount),
      doctor: text(appointment.doctor),
      duration: toNumber(appointment.duration),
      notes: text(appointment.notes),
      treatmentNotes: text(appointment.treatmentNotes),
      toothNumbers: text(appointment.toothNumbers ?? appointment.tooth_numbers),
      serviceType: text(appointment.serviceType),
      status: text(appointment.status) ? normalizeStatus(text(appointment.status)) : null,
      cancellationReason: text(appointment.cancellationReason),
      paymentStatus: text(appointment.paymentStatus),
      paymentMethod: text(appointment.paymentMethod),
      balance: toNumber(appointment.balance),
      totalPaid: toNumber(appointment.totalPaid),
      transactions: appointment.transactions ?? null,
      createdAt: toDate(appointment.createdAt),
      updatedAt: toDate(appointment.updatedAt),
      deleted: toBool(appointment.deleted),
      deletedAt: toDate(appointment.deletedAt),
    };

    await prisma.appointment.upsert({
      where: { id },
      create: data as any,
      update: data as any,
    });
  });

  await importRows("appointment_logs", readArray("appointment_logs.json"), async (log, index) => {
    const id = requiredText(log.id, `appointment_log_import_${index}`);
    const data = {
      id,
      appointmentId: requiredText(log.appointmentId, ""),
      previousState: log.previousState ?? {},
      newState: log.newState ?? {},
      changedBy: requiredText(log.changedBy, "unknown"),
      changedByName: text(log.changedByName),
      changedAt: toDate(log.changedAt),
      changeType: requiredText(log.changeType, "update"),
      amount: toNumber(log.amount),
      notes: text(log.notes),
    };

    await prisma.appointmentLog.upsert({
      where: { id },
      create: data as any,
      update: data as any,
    });
  });

  await importRows("payments", readArray("payments.json"), async (payment, index) => {
    const id = requiredText(payment.id, `payment_import_${index}`);
    const data = {
      id,
      appointmentId: requiredText(payment.appointmentId, ""),
      patientId: text(payment.patientId),
      amount: toNumber(payment.amount) ?? 0,
      method: requiredText(payment.method, ""),
      date: requiredText(payment.date, ""),
      transactionId: text(payment.transactionId),
      notes: text(payment.notes),
      status: text(payment.status),
      createdAt: toDate(payment.createdAt),
      updatedAt: toDate(payment.updatedAt),
      deleted: toBool(payment.deleted),
      deletedAt: toDate(payment.deletedAt),
    };

    await prisma.payment.upsert({
      where: { id },
      create: data as any,
      update: data as any,
    });
  });

  await importRows("payment_logs", readArray("payment_logs.json"), async (log, index) => {
    const id = requiredText(log.id, `payment_log_import_${index}`);
    const data = {
      id,
      appointmentId: requiredText(log.appointmentId, ""),
      amount: toNumber(log.amount) ?? 0,
      paymentMethod: requiredText(log.paymentMethod, ""),
      paymentStatus: requiredText(log.paymentStatus, ""),
      changedBy: requiredText(log.changedBy, "unknown"),
      changedByName: text(log.changedByName),
      changedAt: toDate(log.changedAt),
      previousBalance: toNumber(log.previousBalance),
      newBalance: toNumber(log.newBalance),
    };

    await prisma.paymentLog.upsert({
      where: { id },
      create: data as any,
      update: data as any,
    });
  });

  await importRows("payment_methods", readArray("payment_methods.json"), async (method, index) => {
    const id = requiredText(method.id, `payment_method_import_${index}`);
    const data = {
      id,
      name: requiredText(method.name, id),
      description: text(method.description),
      isActive: toBool(method.isActive, true),
      createdAt: toDate(method.createdAt),
      updatedAt: toDate(method.updatedAt),
    };

    await prisma.paymentMethod.upsert({
      where: { id },
      create: data as any,
      update: data as any,
    });
  });

  await importRows("notifications", readArray("notifications.json"), async (notification, index) => {
    const id = requiredText(notification.id, `notification_import_${index}`);
    const data = {
      id,
      userId: requiredText(notification.userId, ""),
      title: requiredText(notification.title, ""),
      message: requiredText(notification.message, ""),
      type: requiredText(notification.type, "system"),
      createdAt: toDate(notification.createdAt),
      updatedAt: toDate(notification.updatedAt),
      isRead: toBool(notification.isRead),
      link: text(notification.link),
      isLog: toBool(notification.isLog),
      metadata: notification.metadata ?? null,
      deleted: toBool(notification.deleted),
      deletedAt: toDate(notification.deletedAt),
    };

    await prisma.notification.upsert({
      where: { id },
      create: data as any,
      update: data as any,
    });
  });

  await importRows("finance_records", readArray("finance_records.json"), async (record, index) => {
    const id = requiredText(record.id, `finance_record_import_${index}`);
    const data = {
      id,
      patientId: text(record.patientId),
      type: requiredText(record.type, "charge"),
      amount: toNumber(record.amount) ?? 0,
      date: requiredText(record.date, ""),
      description: text(record.description),
      isSeeding: typeof record.isSeeding === "boolean" ? record.isSeeding : null,
      createdAt: toDate(record.createdAt),
      updatedAt: toDate(record.updatedAt),
      deleted: toBool(record.deleted),
      deletedAt: toDate(record.deletedAt),
    };

    await prisma.financeRecord.upsert({
      where: { id },
      create: data as any,
      update: data as any,
    });
  });

  await importRows("inventory", readArray("inventory.json"), async (item, index) => {
    const id = requiredText(item.id, `inventory_import_${index}`);
    const data = {
      id,
      item: requiredText(item.item, id),
      quantity: toNumber(item.quantity) ?? 0,
      unit: text(item.unit),
      costPerUnit: toNumber(item.costPerUnit),
      totalValue: toNumber(item.totalValue),
      supplier: text(item.supplier),
      lastOrdered: text(item.lastOrdered),
      createdAt: toDate(item.createdAt),
      updatedAt: toDate(item.updatedAt),
      deleted: toBool(item.deleted),
      deletedAt: toDate(item.deletedAt),
    };

    await prisma.inventoryItem.upsert({
      where: { id },
      create: data as any,
      update: data as any,
    });
  });

  await importRows("detailed_expenses", readArray("detailed_expenses.json"), async (expense, index) => {
    const id = requiredText(expense.id, `detailed_expense_import_${index}`);
    const data = {
      id,
      date: requiredText(expense.date, ""),
      category: requiredText(expense.category, ""),
      description: requiredText(expense.description, ""),
      amount: toNumber(expense.amount) ?? 0,
      vendor: text(expense.vendor),
      paymentMethod: text(expense.paymentMethod),
      status: text(expense.status),
      recurring: toBool(expense.recurring),
    };

    await prisma.detailedExpense.upsert({
      where: { id },
      create: data as any,
      update: data as any,
    });
  });

  await importRows("staff_financial_records", readArray("staff_financial_records.json"), async (record, index) => {
    const id = requiredText(record.id, `staff_financial_import_${index}`);
    const data = {
      id,
      staffId: requiredText(record.staffId, ""),
      staffName: requiredText(record.staffName, ""),
      type: requiredText(record.type, ""),
      amount: toNumber(record.amount) ?? 0,
      date: requiredText(record.date, ""),
      status: requiredText(record.status, ""),
      notes: text(record.notes),
      repaymentSchedule: text(record.repaymentSchedule),
    };

    await prisma.staffFinancialRecord.upsert({
      where: { id },
      create: data as any,
      update: data as any,
    });
  });

  await importRows("staff_attendance", readArray("staff_attendance.json"), async (attendance, index) => {
    const staffId = requiredText(attendance.staffId, `staff_attendance_${index}`);
    const id = requiredText(attendance.id, `staff_attendance_${staffId}`);
    const data = {
      id,
      staffId,
      staffName: requiredText(attendance.staffName, ""),
      hoursWorked: toNumber(attendance.hoursWorked) ?? 0,
      daysPresent: toNumber(attendance.daysPresent) ?? 0,
      daysAbsent: toNumber(attendance.daysAbsent) ?? 0,
      overtimeHours: toNumber(attendance.overtimeHours) ?? 0,
    };

    await prisma.staffAttendance.upsert({
      where: { id },
      create: data as any,
      update: data as any,
    });
  });

  const statuses = readJson<Record<string, unknown>>("statuses.json", {});
  for (const [key, value] of Object.entries(statuses)) {
    await prisma.statusConfig.upsert({
      where: { key },
      create: { key, value: value as any },
      update: { value: value as any },
    });
  }
  console.log(`[IMPORT] status_configs: ${Object.keys(statuses).length} row(s)`);

  const questionnairesDir = path.join(DATA_DIR, "questionnaires");
  if (fs.existsSync(questionnairesDir)) {
    const questionnaireFiles = fs
      .readdirSync(questionnairesDir)
      .filter((file) => file.endsWith(".json"));

    for (const file of questionnaireFiles) {
      const patientId = path.basename(file, ".json");
      const questionnaire = JSON.parse(
        fs.readFileSync(path.join(questionnairesDir, file), "utf-8")
      );
      await prisma.questionnaire.upsert({
        where: { patientId },
        create: {
          patientId,
          data: questionnaire,
          updatedAt: toDate(questionnaire.updatedAt),
        },
        update: {
          data: questionnaire,
          updatedAt: toDate(questionnaire.updatedAt),
        },
      });
    }

    console.log(`[IMPORT] questionnaires: ${questionnaireFiles.length} row(s)`);
  }

  console.log("[IMPORT] Done");
};

main()
  .catch((error) => {
    console.error("[IMPORT] Failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
