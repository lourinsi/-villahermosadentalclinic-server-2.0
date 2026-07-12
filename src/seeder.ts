#!/usr/bin/env ts-node
// Seed the database with stable demo data for the Villahermosa Dental Clinic app.
// Run with: npm run seed, or a segmented command such as npm run seed:patients.

import "dotenv/config";
import bcrypt from "bcryptjs";
import { prisma } from "./lib/prisma";
import { APPOINTMENT_STATUSES } from "./shared/appointmentStatuses";
import { PAYMENT_STATUSES } from "./shared/paymentStatuses";
import {
  APPOINTMENT_TYPES,
  OTHER_APPOINTMENT_TYPE_INDEX,
  getAppointmentPrice,
  getAppointmentTypeName,
} from "./utils/appointment-types";

const SEED_PREFIX = "seed_";
const now = new Date();

type JsonRecord = Record<string, unknown>;
type SeedModel = {
  create: (args: { data: any }) => Promise<unknown>;
};

const dateFromToday = (offsetDays: number): string => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString().slice(0, 10);
};

const dateTimeFromToday = (offsetDays: number): Date => {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return date;
};

const monthFromNow = (offsetMonths: number): string => {
  const date = new Date();
  date.setMonth(date.getMonth() + offsetMonths);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
};

const appointmentTypeIndex = (typeName: string): number => {
  const index = APPOINTMENT_TYPES.indexOf(typeName);
  return index >= 0 ? index : OTHER_APPOINTMENT_TYPE_INDEX;
};

const createRecords = async (model: SeedModel, records: any[]) => {
  for (const record of records) {
    await model.create({ data: record });
  }
};

const requiredSeedSchema: Record<string, string[]> = {
  detailed_expenses: [
    "id",
    "paymentDate",
    "createdAt",
    "inventoryItemId",
    "inventoryQuantity",
  ],
  expense_logs: [
    "id",
    "expenseId",
    "previousState",
    "newState",
    "changedBy",
    "changedByName",
    "changedByRole",
    "changedAt",
    "changeType",
    "amount",
    "notes",
  ],
  inventory_logs: [
    "id",
    "inventoryItemId",
    "previousState",
    "newState",
    "changedBy",
    "changedByName",
    "changedByRole",
    "changedAt",
    "changeType",
    "quantityChange",
    "notes",
  ],
  payroll_logs: [
    "id",
    "staffId",
    "payrollMonth",
    "payrollRecordId",
    "previousState",
    "newState",
    "changedBy",
    "changedByName",
    "changedByRole",
    "changedAt",
    "changeType",
    "amount",
    "notes",
  ],
};

const assertRequiredSeedSchema = async () => {
  const tableNames = Object.keys(requiredSeedSchema);
  const quotedTableNames = tableNames.map((tableName) => `'${tableName}'`).join(", ");
  const columns = await prisma.$queryRawUnsafe<Array<{ table_name: string; column_name: string }>>(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name IN (${quotedTableNames})`
  );
  const existingColumns = new Set(columns.map((column) => `${column.table_name}.${column.column_name}`));
  const missingColumns = tableNames.flatMap((tableName) =>
    requiredSeedSchema[tableName]
      .filter((columnName) => !existingColumns.has(`${tableName}.${columnName}`))
      .map((columnName) => `${tableName}.${columnName}`)
  );

  if (missingColumns.length > 0) {
    throw new Error(
      `Database schema is missing columns required by the seeder: ${missingColumns.join(", ")}. ` +
        "Run npm run prisma:migrate or npx prisma migrate deploy in villahermosadentalclinic-server, then rerun npm run seed."
    );
  }
};

const resetSeedData = async () => {
  await prisma.expenseLog.deleteMany({
    where: {
      OR: [
        { id: { startsWith: SEED_PREFIX } },
        { expenseId: { startsWith: `${SEED_PREFIX}expense_` } },
      ],
    },
  });
  await prisma.inventoryLog.deleteMany({
    where: {
      OR: [
        { id: { startsWith: SEED_PREFIX } },
        { inventoryItemId: { startsWith: `${SEED_PREFIX}inventory_` } },
      ],
    },
  });
  await prisma.payrollLog.deleteMany({
    where: {
      OR: [
        { id: { startsWith: SEED_PREFIX } },
        { staffId: { startsWith: `${SEED_PREFIX}staff_` } },
        { payrollRecordId: { startsWith: `${SEED_PREFIX}staff_finance_` } },
      ],
    },
  });
  await prisma.paymentLog.deleteMany({
    where: {
      OR: [
        { id: { startsWith: SEED_PREFIX } },
        { appointmentId: { startsWith: `${SEED_PREFIX}appt_` } },
      ],
    },
  });
  await prisma.appointmentLog.deleteMany({
    where: {
      OR: [
        { id: { startsWith: SEED_PREFIX } },
        { appointmentId: { startsWith: `${SEED_PREFIX}appt_` } },
      ],
    },
  });
  await prisma.payment.deleteMany({
    where: {
      OR: [
        { id: { startsWith: `${SEED_PREFIX}payment_` } },
        { appointmentId: { startsWith: `${SEED_PREFIX}appt_` } },
        { patientId: { startsWith: `${SEED_PREFIX}patient_` } },
      ],
    },
  });
  await prisma.financeRecord.deleteMany({ where: { id: { startsWith: SEED_PREFIX } } });
  await prisma.notification.deleteMany({
    where: {
      OR: [
        { id: { startsWith: SEED_PREFIX } },
        { userId: { startsWith: SEED_PREFIX } },
      ],
    },
  });
  await prisma.questionnaire.deleteMany({
    where: { patientId: { startsWith: SEED_PREFIX } },
  });
  await prisma.appointment.deleteMany({
    where: {
      OR: [
        { id: { startsWith: SEED_PREFIX } },
        { patientId: { startsWith: SEED_PREFIX } },
        { doctorId: { startsWith: `${SEED_PREFIX}staff_` } },
      ],
    },
  });
  await prisma.staffFinancialRecord.deleteMany({
    where: { id: { startsWith: SEED_PREFIX } },
  });
  await prisma.staffAttendance.deleteMany({ where: { id: { startsWith: SEED_PREFIX } } });
  await prisma.inventoryItem.deleteMany({ where: { id: { startsWith: SEED_PREFIX } } });
  await prisma.expensePaymentLog.deleteMany({ where: { expenseId: { startsWith: SEED_PREFIX } } });
  await prisma.expensePayment.deleteMany({ where: { expenseId: { startsWith: SEED_PREFIX } } });
  await prisma.detailedExpense.deleteMany({ where: { id: { startsWith: SEED_PREFIX } } });
  await prisma.paymentMethod.deleteMany({ where: { id: { startsWith: SEED_PREFIX } } });
  await prisma.staff.deleteMany({ where: { id: { startsWith: SEED_PREFIX } } });
  await prisma.patient.deleteMany({ where: { id: { startsWith: SEED_PREFIX } } });
};

const makeAppointment = ({
  id,
  patientId,
  patientName,
  offsetDays,
  time,
  typeName,
  customType,
  doctor,
  status,
  paymentStatus,
  paymentMethod,
  notes,
  toothNumbers = "",
  discount = 0,
  duration = 60,
}: {
  id: string;
  patientId: string;
  patientName: string;
  offsetDays: number;
  time: string;
  typeName: string;
  customType?: string;
  doctor: string;
  status: string;
  paymentStatus: string;
  paymentMethod?: string;
  notes?: string;
  toothNumbers?: string;
  discount?: number;
  duration?: number;
}) => {
  const type = appointmentTypeIndex(typeName);
  const serviceType = getAppointmentTypeName(type, customType);
  const basePrice = customType ? 2000 : getAppointmentPrice(type);
  const price = Math.max(basePrice - discount, 0);
  const totalPaid =
    paymentStatus === "paid"
      ? price
      : paymentStatus === "half-paid"
        ? Math.round(price / 2)
        : 0;
  const balance = Math.max(price - totalPaid, 0);

  // Ensure createdAt is never in the future. For future appointments, clamp
  // the appointment creation timestamp to at most yesterday so logs remain
  // historical (logs should never be in the future).
  const rawCreatedAt = dateTimeFromToday(offsetDays - 7);
  const clampedCreatedAt = rawCreatedAt > now ? dateTimeFromToday(-1) : rawCreatedAt;

  return {
    id,
    patientId,
    patientName,
    date: dateFromToday(offsetDays),
    time,
    type,
    customType,
    price,
    discount,
    doctor,
    doctorId: null as string | null,
    duration,
    notes,
    treatmentNotes: "",
    toothNumbers,
    serviceType,
    status,
    cancellationReason: status === "cancelled" ? notes || "Seed cancelled appointment." : null,
    paymentStatus,
    paymentMethod: paymentMethod || null,
    balance,
    totalPaid,
    transactions: null,
    createdAt: clampedCreatedAt,
    updatedAt: now,
    deleted: false,
    deletedAt: null,
  };
};

const appointmentSnapshot = (appointment: any): JsonRecord => ({
  id: appointment.id,
  patientId: appointment.patientId,
  patientName: appointment.patientName,
  date: appointment.date,
  time: appointment.time,
  type: appointment.type,
  customType: appointment.customType || "",
  doctor: appointment.doctor,
  doctorId: appointment.doctorId || null,
  duration: appointment.duration,
  notes: appointment.notes || "",
  treatmentNotes: appointment.treatmentNotes || "",
  toothNumbers: appointment.toothNumbers || "",
  serviceType: appointment.serviceType,
  status: appointment.status,
  cancellationReason: appointment.cancellationReason || null,
  paymentStatus: appointment.paymentStatus,
  paymentMethod: appointment.paymentMethod || null,
  price: appointment.price,
  discount: appointment.discount || 0,
  balance: appointment.balance,
  totalPaid: appointment.totalPaid || 0,
});

const financeSeedActor = {
  changedBy: `${SEED_PREFIX}staff_carlo`,
  changedByName: "Carlo Mendoza",
  changedByRole: "Receptionist",
};

const expenseSnapshot = (expense: any): JsonRecord => ({
  id: expense.id,
  date: expense.date,
  category: expense.category,
  description: expense.description,
  amount: expense.amount,
  vendor: expense.vendor || "",
  paymentMethod: expense.paymentMethod || "",
  paymentDate: expense.paymentDate || null,
  status: expense.status || "pending",
  recurring: Boolean(expense.recurring),
  createdAt: expense.createdAt instanceof Date ? expense.createdAt.toISOString() : expense.createdAt || null,
  inventoryItemId: expense.inventoryItemId || null,
  inventoryQuantity: expense.inventoryQuantity || null,
});

const inventorySnapshot = (item: any): JsonRecord => ({
  id: item.id,
  item: item.item,
  quantity: item.quantity,
  unit: item.unit || "",
  costPerUnit: item.costPerUnit || 0,
  totalValue: item.totalValue || 0,
  supplier: item.supplier || "",
  lastOrdered: item.lastOrdered || "",
  createdAt: item.createdAt instanceof Date ? item.createdAt.toISOString() : item.createdAt || null,
  updatedAt: item.updatedAt instanceof Date ? item.updatedAt.toISOString() : item.updatedAt || null,
});

const payrollRecordSnapshot = (record: any): JsonRecord => ({
  id: record.id,
  staffId: record.staffId,
  staffName: record.staffName,
  type: record.type,
  amount: record.amount,
  date: record.date,
  status: record.status,
  notes: record.notes || "",
  repaymentSchedule: record.repaymentSchedule || "",
});

const payrollLogRecordTypes = new Set(["bonus", "commission", "overtime", "allowance", "deduction", "salary", "payroll"]);

const shouldCreatePayrollLog = (record: any) =>
  payrollLogRecordTypes.has(String(record.type || "").toLowerCase().replace(/[^a-z0-9]/g, ""));

async function buildSeedData() {
  const patientPasswordHash = await bcrypt.hash("villahermosa123", 10);
  const doctorPasswordHash = await bcrypt.hash("doctor123", 10);
  const testDoctorPasswordHash = await bcrypt.hash("password", 10);
  const receptionistPasswordHash = await bcrypt.hash("password", 10);

  const paymentMethods = [
    {
      id: `${SEED_PREFIX}payment_cash`,
      name: "Cash",
      description: "Clinic counter cash payment",
      isActive: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: `${SEED_PREFIX}payment_card`,
      name: "Card",
      description: "Credit or debit card",
      isActive: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: `${SEED_PREFIX}payment_gcash`,
      name: "GCash",
      description: "GCash wallet transfer",
      isActive: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: `${SEED_PREFIX}payment_maya`,
      name: "Maya",
      description: "Maya wallet transfer",
      isActive: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: `${SEED_PREFIX}payment_bank`,
      name: "Bank Transfer",
      description: "Manual bank transfer",
      isActive: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: `${SEED_PREFIX}payment_clinic`,
      name: "Pay at Clinic",
      description: "Patient will settle in person",
      isActive: true,
      createdAt: now,
      updatedAt: now,
    },
  ];
 

  const staff = [
    {
      id: `${SEED_PREFIX}staff_test_doctor`,
      name: "Dr. Test Doctor",
      role: "Doctor",
      department: "Clinical",
      email: "doctor@villahermosa.test",
      phone: "09170001001",
      hireDate: dateFromToday(-900),
      baseSalary: 65000,
      status: "active",
      employmentType: "Full-time",
      specialization: "General Dentistry",
      licenseNumber: "PRC-DEN-00001",
      password: testDoctorPasswordHash,
      bio: "Seed doctor used for testing the doctor dashboard and appointment workflow.",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: `${SEED_PREFIX}staff_maria`,
      name: "Dr. Maria Villahermosa",
      role: "Doctor",
      department: "Clinical",
      email: "maria.villahermosa@example.com",
      phone: "09170001002",
      hireDate: dateFromToday(-1500),
      baseSalary: 85000,
      status: "active",
      employmentType: "Full-time",
      specialization: "Restorative Dentistry",
      licenseNumber: "PRC-DEN-01842",
      password: doctorPasswordHash,
      bio: "Focuses on restorative care, fillings, crowns, and long-term treatment planning.",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: `${SEED_PREFIX}staff_paolo`,
      name: "Dr. Paolo Reyes",
      role: "Doctor",
      department: "Clinical",
      email: "paolo.reyes@example.com",
      phone: "09170001003",
      hireDate: dateFromToday(-620),
      baseSalary: 78000,
      status: "active",
      employmentType: "Full-time",
      specialization: "Orthodontics",
      licenseNumber: "PRC-DEN-02219",
      password: doctorPasswordHash,
      bio: "Handles orthodontic consults, adjustments, and treatment monitoring.",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: `${SEED_PREFIX}staff_nina`,
      name: "Dr. Nina Santos",
      role: "Doctor",
      department: "Clinical",
      email: "nina.santos@example.com",
      phone: "09170001004",
      hireDate: dateFromToday(-450),
      baseSalary: 72000,
      status: "active",
      employmentType: "Part-time",
      specialization: "Pediatric Dentistry",
      licenseNumber: "PRC-DEN-03115",
      password: doctorPasswordHash,
      bio: "Works with children and family dental care cases.",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: `${SEED_PREFIX}staff_liza`,
      name: "Liza Mercado",
      role: "Dental Assistant",
      department: "Clinical",
      email: "liza.mercado@example.com",
      phone: "09170001005",
      hireDate: dateFromToday(-300),
      baseSalary: 28000,
      status: "active",
      employmentType: "Full-time",
      specialization: "Chairside Assistance",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: `${SEED_PREFIX}staff_carlo`,
      name: "Carlo Mendoza",
      role: "Receptionist",
      department: "Front Desk",
      email: "carlo.mendoza@example.com",
      phone: "09170001006",
      hireDate: dateFromToday(-210),
      baseSalary: 24000,
      status: "active",
      employmentType: "Full-time",
      specialization: "Scheduling and Billing",
      password: receptionistPasswordHash,
      createdAt: now,
      updatedAt: now,
    },
  ];

  const patients = [
    {
      id: `${SEED_PREFIX}patient_test`,
      name: "Test Patient",
      firstName: "Test",
      lastName: "Patient",
      email: "test@patient.com",
      phone: "09915341237",
      alternateEmail: "test.patient.alt@example.com",
      alternatePhone: "09915341238",
      password: patientPasswordHash,
      dateOfBirth: "1996-04-18",
      address: "123 Demo Street, Villahermosa",
      city: "Villahermosa",
      zipCode: "6503",
      insurance: "None",
      status: "active",
      emergencyContact: "Demo Contact",
      emergencyPhone: "09175550100",
      medicalHistory: "No major medical history reported.",
      treatmentPlan: "Initial cleaning, baseline x-rays, and whitening consult.",
      clinicalNotes: "Good demo account for testing patient login and appointment booking.",
      allergies: "None",
      notes: "Seeded login account. Password: villahermosa123",
      isPrimary: true,
      relationship: "Self",
      username: "testpatient",
      balance: 0,
      lastVisit: dateFromToday(-10),
      gender: "Female",
      civilStatus: "Single",
      age: "30",
      ethnicity: "Filipino",
      religion: "Catholic",
      nationality: "Filipino",
      currentStreet: "123 Demo Street",
      currentBarangay: "Poblacion",
      currentProvince: "Leyte",
      permanentStreet: "123 Demo Street",
      permanentBarangay: "Poblacion",
      permanentCity: "Villahermosa",
      permanentProvince: "Leyte",
      permanentZipCode: "6503",
      landline: "053-555-0100",
      emergencyFirstName: "Demo",
      emergencyLastName: "Contact",
      emergencyRelationship: "Sibling",
      education: "College",
      occupation: "Teacher",
      company: "Villahermosa National High School",
      companyAddress: "Villahermosa, Leyte",
      height: "160 cm",
      weight: "55 kg",
      createdAt: dateTimeFromToday(-45),
      updatedAt: now,
    },
    {
      id: `${SEED_PREFIX}patient_ana`,
      name: "Ana Cruz",
      firstName: "Ana",
      lastName: "Cruz",
      email: "ana.cruz@example.com",
      phone: "09170000001",
      password: patientPasswordHash,
      dateOfBirth: "1989-02-12",
      address: "45 Mabini Street",
      city: "Ormoc",
      zipCode: "6541",
      insurance: "Maxicare Dental",
      status: "active",
      emergencyContact: "Marco Cruz",
      emergencyPhone: "09170000011",
      medicalHistory: "Mild asthma.",
      treatmentPlan: "Root canal follow-up and crown evaluation.",
      clinicalNotes: "Prefers morning visits. Sensitive to cold on upper right molar.",
      allergies: "Penicillin",
      notes: "Primary family account.",
      isPrimary: true,
      relationship: "Self",
      dentalCharts: {
        teeth: {
          "17": { condition: "root-canal", note: "Follow-up needed." },
          "21": { condition: "sound" },
          "36": { condition: "filled" },
        },
      },
      balance: 2500,
      lastVisit: dateFromToday(-4),
      gender: "Female",
      civilStatus: "Married",
      age: "37",
      ethnicity: "Filipino",
      religion: "Catholic",
      nationality: "Filipino",
      currentStreet: "45 Mabini Street",
      currentBarangay: "Cogon",
      currentProvince: "Leyte",
      permanentStreet: "45 Mabini Street",
      permanentBarangay: "Cogon",
      permanentCity: "Ormoc",
      permanentProvince: "Leyte",
      permanentZipCode: "6541",
      emergencyFirstName: "Marco",
      emergencyLastName: "Cruz",
      emergencyRelationship: "Husband",
      education: "College",
      occupation: "Accountant",
      company: "Leyte Trading Co.",
      companyAddress: "Ormoc City",
      height: "158 cm",
      weight: "57 kg",
      createdAt: dateTimeFromToday(-60),
      updatedAt: now,
    },
    {
      id: `${SEED_PREFIX}patient_miguel`,
      name: "Miguel Cruz",
      firstName: "Miguel",
      lastName: "Cruz",
      email: "miguel.cruz@example.com",
      phone: "09170000002",
      password: patientPasswordHash,
      dateOfBirth: "2015-08-05",
      address: "45 Mabini Street",
      city: "Ormoc",
      zipCode: "6541",
      insurance: "Maxicare Dental",
      status: "active",
      emergencyContact: "Ana Cruz",
      emergencyPhone: "09170000001",
      medicalHistory: "No known medical conditions.",
      treatmentPlan: "Routine pediatric cleaning every 6 months.",
      clinicalNotes: "Needs calm explanations before procedures.",
      allergies: "None",
      notes: "Dependent under Ana Cruz.",
      parentId: `${SEED_PREFIX}patient_ana`,
      isPrimary: false,
      relationship: "Child",
      balance: 0,
      lastVisit: dateFromToday(-30),
      gender: "Male",
      civilStatus: "Single",
      age: "10",
      nationality: "Filipino",
      emergencyFirstName: "Ana",
      emergencyLastName: "Cruz",
      emergencyRelationship: "Mother",
      education: "Elementary",
      height: "138 cm",
      weight: "32 kg",
      createdAt: dateTimeFromToday(-59),
      updatedAt: now,
    },
    {
      id: `${SEED_PREFIX}patient_ben`,
      name: "Ben Santos",
      firstName: "Ben",
      lastName: "Santos",
      email: "ben.santos@example.com",
      phone: "09170000003",
      password: patientPasswordHash,
      dateOfBirth: "1978-11-25",
      address: "77 Rizal Avenue",
      city: "Tacloban",
      zipCode: "6500",
      insurance: "Intellicare",
      status: "active",
      emergencyContact: "Lara Santos",
      emergencyPhone: "09170000033",
      medicalHistory: "Hypertension, controlled with medication.",
      treatmentPlan: "Extraction review and denture planning.",
      clinicalNotes: "Check blood pressure before invasive procedures.",
      allergies: "Ibuprofen",
      notes: "Usually available after lunch.",
      isPrimary: true,
      relationship: "Self",
      balance: 1500,
      lastVisit: dateFromToday(-18),
      gender: "Male",
      civilStatus: "Married",
      age: "47",
      nationality: "Filipino",
      emergencyFirstName: "Lara",
      emergencyLastName: "Santos",
      emergencyRelationship: "Wife",
      occupation: "Engineer",
      company: "Santos Builders",
      height: "171 cm",
      weight: "76 kg",
      createdAt: dateTimeFromToday(-80),
      updatedAt: now,
    },
    {
      id: `${SEED_PREFIX}patient_clara`,
      name: "Clara Lim",
      firstName: "Clara",
      lastName: "Lim",
      email: "clara.lim@example.com",
      phone: "09170000004",
      password: patientPasswordHash,
      dateOfBirth: "1999-06-30",
      address: "9 Mango Lane",
      city: "Cebu City",
      zipCode: "6000",
      insurance: "None",
      status: "active",
      emergencyContact: "Grace Lim",
      emergencyPhone: "09170000044",
      medicalHistory: "No major medical history.",
      treatmentPlan: "Whitening package and maintenance cleaning.",
      clinicalNotes: "Asked about cosmetic options.",
      allergies: "Latex",
      notes: "Prefers online reminders.",
      isPrimary: true,
      relationship: "Self",
      balance: 0,
      lastVisit: dateFromToday(-2),
      gender: "Female",
      civilStatus: "Single",
      age: "26",
      nationality: "Filipino",
      emergencyFirstName: "Grace",
      emergencyLastName: "Lim",
      emergencyRelationship: "Mother",
      education: "College",
      occupation: "Graphic Designer",
      company: "Freelance",
      height: "164 cm",
      weight: "52 kg",
      createdAt: dateTimeFromToday(-25),
      updatedAt: now,
    },
    {
      id: `${SEED_PREFIX}patient_diego`,
      name: "Diego Ramos",
      firstName: "Diego",
      lastName: "Ramos",
      email: "diego.ramos@example.com",
      phone: "09170000005",
      password: patientPasswordHash,
      dateOfBirth: "1992-01-09",
      address: "18 San Pedro Road",
      city: "Tacloban",
      zipCode: "6500",
      insurance: "PhilCare",
      status: "inactive",
      emergencyContact: "Rhea Ramos",
      emergencyPhone: "09170000055",
      medicalHistory: "Diabetic, patient reported controlled sugar levels.",
      treatmentPlan: "Periodontal assessment before restorative work.",
      clinicalNotes: "Needs updated medical clearance.",
      allergies: "None",
      notes: "Inactive patient included for dashboard filtering.",
      isPrimary: true,
      relationship: "Self",
      balance: 500,
      lastVisit: dateFromToday(-120),
      gender: "Male",
      civilStatus: "Single",
      age: "34",
      nationality: "Filipino",
      emergencyFirstName: "Rhea",
      emergencyLastName: "Ramos",
      emergencyRelationship: "Sister",
      occupation: "Sales Associate",
      height: "169 cm",
      weight: "70 kg",
      createdAt: dateTimeFromToday(-150),
      updatedAt: now,
    },
  ];

  const normalizeSeedDoctorName = (name: string) =>
    String(name || "").replace(/^Dr\.?\s+/i, "").toLowerCase().trim();
  const seedDoctorIdsByName = new Map(
    staff.map((member) => [normalizeSeedDoctorName(member.name), member.id])
  );

  let appointments = [
    makeAppointment({
      id: `${SEED_PREFIX}appt_test_completed`,
      patientId: `${SEED_PREFIX}patient_test`,
      patientName: "Test Patient",
      offsetDays: -10,
      time: "09:00",
      typeName: "Routine Cleaning",
      doctor: "Dr. Test Doctor",
      status: "completed",
      paymentStatus: "paid",
      paymentMethod: "GCash",
      notes: "Completed seed appointment used for history and payment views.",
    }),
    makeAppointment({
      id: `${SEED_PREFIX}appt_test_future`,
      patientId: `${SEED_PREFIX}patient_test`,
      patientName: "Test Patient",
      offsetDays: 5,
      time: "10:30",
      typeName: "Whitening",
      doctor: "Dr. Maria Villahermosa",
      status: "scheduled",
      paymentStatus: "unpaid",
      paymentMethod: "Pay at Clinic",
      notes: "Future patient dashboard appointment.",
      duration: 90,
    }),
    makeAppointment({
      id: `${SEED_PREFIX}appt_ana_root`,
      patientId: `${SEED_PREFIX}patient_ana`,
      patientName: "Ana Cruz",
      offsetDays: 2,
      time: "08:30",
      typeName: "Root Canal",
      doctor: "Dr. Maria Villahermosa",
      status: "reserved",
      paymentStatus: "half-paid",
      paymentMethod: "Card",
      notes: "Root canal follow-up with partial payment.",
      duration: 120,
    }),
    makeAppointment({
      id: `${SEED_PREFIX}appt_miguel_cleaning`,
      patientId: `${SEED_PREFIX}patient_miguel`,
      patientName: "Miguel Cruz",
      offsetDays: 12,
      time: "15:00",
      typeName: "Routine Cleaning",
      doctor: "Dr. Nina Santos",
      status: "scheduled",
      paymentStatus: "unpaid",
      paymentMethod: "Pay at Clinic",
      notes: "Pediatric cleaning visit.",
    }),
    makeAppointment({
      id: `${SEED_PREFIX}appt_ben_extraction`,
      patientId: `${SEED_PREFIX}patient_ben`,
      patientName: "Ben Santos",
      offsetDays: -1,
      time: "13:00",
      typeName: "Extraction",
      doctor: "Dr. Paolo Reyes",
      status: "tbd",
      paymentStatus: "unpaid",
      paymentMethod: "Pay at Clinic",
      notes: "Past appointment waiting for clinic status update.",
      duration: 90,
    }),
    makeAppointment({
      id: `${SEED_PREFIX}appt_clara_whitening`,
      patientId: `${SEED_PREFIX}patient_clara`,
      patientName: "Clara Lim",
      offsetDays: -2,
      time: "11:00",
      typeName: "Whitening",
      doctor: "Dr. Test Doctor",
      status: "completed",
      paymentStatus: "paid",
      paymentMethod: "Maya",
      notes: "Cosmetic whitening completed.",
      duration: 90,
    }),
    makeAppointment({
      id: `${SEED_PREFIX}appt_diego_checkup`,
      patientId: `${SEED_PREFIX}patient_diego`,
      patientName: "Diego Ramos",
      offsetDays: 9,
      time: "16:00",
      typeName: "Checkup",
      doctor: "Dr. Paolo Reyes",
      status: "cancelled",
      paymentStatus: "unpaid",
      paymentMethod: "Pay at Clinic",
      notes: "Cancelled because patient needs medical clearance.",
    }),
    makeAppointment({
      id: `${SEED_PREFIX}appt_cart`,
      patientId: `${SEED_PREFIX}patient_test`,
      patientName: "Test Patient",
      offsetDays: 18,
      time: "14:30",
      typeName: "Other",
      customType: "Cosmetic Consultation",
      doctor: "Dr. Maria Villahermosa",
      status: "add-to-cart",
      paymentStatus: "unpaid",
      paymentMethod: "Pay at Clinic",
      notes: "Cart item for testing patient checkout flow.",
      duration: 30,
    }),
    // Additional test appointment specifically with the Test Doctor for quick doctor-side testing
    makeAppointment({
      id: `${SEED_PREFIX}appt_test_with_doctor`,
      patientId: `${SEED_PREFIX}patient_test`,
      patientName: "Test Patient",
      offsetDays: 1,
      time: "11:30",
      typeName: "Checkup",
      doctor: "Dr. Test Doctor",
      status: "scheduled",
      paymentStatus: "unpaid",
      paymentMethod: "Pay at Clinic",
      notes: "Quick checkup assigned to Test Doctor for functional testing.",
      duration: 30,
    }),
    // Test patient: multiple appointments with different doctors
    makeAppointment({
      id: `${SEED_PREFIX}appt_test_maria_checkup`,
      patientId: `${SEED_PREFIX}patient_test`,
      patientName: "Test Patient",
      offsetDays: 3,
      time: "09:30",
      typeName: "Checkup",
      doctor: "Dr. Maria Villahermosa",
      status: "scheduled",
      paymentStatus: "unpaid",
      paymentMethod: "Pay at Clinic",
      notes: "Follow-up checkup with Dr. Maria.",
      duration: 30,
    }),
    makeAppointment({
      id: `${SEED_PREFIX}appt_test_paolo_extraction`,
      patientId: `${SEED_PREFIX}patient_test`,
      patientName: "Test Patient",
      offsetDays: 7,
      time: "14:00",
      typeName: "Extraction",
      doctor: "Dr. Paolo Reyes",
      status: "reserved",
      paymentStatus: "half-paid",
      paymentMethod: "Card",
      notes: "Extraction consult scheduled with partial payment.",
      duration: 60,
    }),
    makeAppointment({
      id: `${SEED_PREFIX}appt_test_nina_cleaning`,
      patientId: `${SEED_PREFIX}patient_test`,
      patientName: "Test Patient",
      offsetDays: -5,
      time: "11:00",
      typeName: "Routine Cleaning",
      doctor: "Dr. Nina Santos",
      status: "completed",
      paymentStatus: "paid",
      paymentMethod: "Cash",
      notes: "Recent cleaning with Dr. Nina.",
      duration: 30,
    }),
    makeAppointment({
      id: `${SEED_PREFIX}appt_test_followup_other`,
      patientId: `${SEED_PREFIX}patient_test`,
      patientName: "Test Patient",
      offsetDays: 21,
      time: "10:00",
      typeName: "Other",
      customType: "Follow-up Visit",
      doctor: "Dr. Maria Villahermosa",
      status: "scheduled",
      paymentStatus: "unpaid",
      paymentMethod: "Pay at Clinic",
      notes: "Follow-up (other) with Dr. Maria.",
      duration: 30,
    }),

    // Dr. Test Doctor: booked calendar with many patients (most bookings involve the Test Patient)
    makeAppointment({
      id: `${SEED_PREFIX}appt_td_test_recent`,
      patientId: `${SEED_PREFIX}patient_test`,
      patientName: "Test Patient",
      offsetDays: -30,
      time: "09:00",
      typeName: "Filling",
      doctor: "Dr. Test Doctor",
      status: "completed",
      paymentStatus: "paid",
      paymentMethod: "Cash",
      notes: "Historic filling performed by Test Doctor.",
      duration: 60,
    }),
    makeAppointment({
      id: `${SEED_PREFIX}appt_td_test_partial`,
      patientId: `${SEED_PREFIX}patient_test`,
      patientName: "Test Patient",
      offsetDays: -7,
      time: "14:00",
      typeName: "Filling",
      doctor: "Dr. Test Doctor",
      status: "completed",
      paymentStatus: "half-paid",
      paymentMethod: "Card",
      notes: "Partial payment recorded for restorative work.",
      duration: 60,
    }),
    makeAppointment({
      id: `${SEED_PREFIX}appt_td_test_future2`,
      patientId: `${SEED_PREFIX}patient_test`,
      patientName: "Test Patient",
      offsetDays: 4,
      time: "12:30",
      typeName: "Checkup",
      doctor: "Dr. Test Doctor",
      status: "scheduled",
      paymentStatus: "unpaid",
      paymentMethod: "Pay at Clinic",
      notes: "Short checkup slot on Test Doctor's calendar.",
      duration: 30,
    }),
    makeAppointment({
      id: `${SEED_PREFIX}appt_td_clara_follow`,
      patientId: `${SEED_PREFIX}patient_clara`,
      patientName: "Clara Lim",
      offsetDays: 10,
      time: "09:30",
      typeName: "Whitening",
      doctor: "Dr. Test Doctor",
      status: "scheduled",
      paymentStatus: "unpaid",
      paymentMethod: "Pay at Clinic",
      notes: "Clara follow-up with Test Doctor.",
      duration: 60,
    }),
    makeAppointment({
      id: `${SEED_PREFIX}appt_td_ben_checkup`,
      patientId: `${SEED_PREFIX}patient_ben`,
      patientName: "Ben Santos",
      offsetDays: 6,
      time: "15:00",
      typeName: "Checkup",
      doctor: "Dr. Test Doctor",
      status: "scheduled",
      paymentStatus: "unpaid",
      paymentMethod: "Pay at Clinic",
      notes: "Ben's routine checkup with Test Doctor.",
      duration: 30,
    }),
    makeAppointment({
      id: `${SEED_PREFIX}appt_td_ana_emergency`,
      patientId: `${SEED_PREFIX}patient_ana`,
      patientName: "Ana Cruz",
      offsetDays: -2,
      time: "09:00",
      typeName: "Root Canal",
      doctor: "Dr. Test Doctor",
      status: "completed",
      paymentStatus: "paid",
      paymentMethod: "Card",
      notes: "Emergency/root canal handled by Test Doctor.",
      duration: 120,
    }),
  ];
  appointments = appointments.map((appointment) => ({
    ...appointment,
    doctorId: seedDoctorIdsByName.get(normalizeSeedDoctorName(appointment.doctor)) || null,
  }));

  // Sprinkle: for realism, mark a few past appointments as `tbd` or with `overdue` payments.
  // Deterministic selection so seed is repeatable.
  const todayStr = dateFromToday(0);
  const pastAppointments = appointments.filter((a) => a.date < todayStr);
  // Pick up to two past appointments that are not completed/cancelled/tbd and mark them `tbd`.
  let tbdSet = 0;
  for (const appt of pastAppointments) {
    if (tbdSet >= 2) break;
    if (appt.status !== "tbd" && appt.status !== "cancelled" && appt.status !== "completed") {
      appt.status = "tbd";
      tbdSet++;
    }
  }

  // Pick up to two past appointments with unpaid or half-paid status and mark them overdue.
  let overdueSet = 0;
  for (const appt of pastAppointments) {
    if (overdueSet >= 2) break;
    if (appt.paymentStatus === "unpaid" || appt.paymentStatus === "half-paid") {
      if (appt.paymentStatus === "unpaid") {
          appt.totalPaid = 0;
          appt.balance = appt.price;
      } else if (appt.paymentStatus === "half-paid") {
        appt.balance = Math.max(appt.price - (appt.totalPaid || 0), 0);
      }
      appt.paymentStatus = "overdue";
      overdueSet++;
    }
  }

  // Ensure any pre-existing payments/logs for these appointment IDs are removed
  // This prevents leftover transactions from previous seed runs producing duplicates.
  const seededAppointmentIds = appointments.map((a) => a.id);
  await prisma.payment.deleteMany({ where: { appointmentId: { in: seededAppointmentIds } } });
  await prisma.paymentLog.deleteMany({ where: { appointmentId: { in: seededAppointmentIds } } });
  await prisma.appointmentLog.deleteMany({ where: { appointmentId: { in: seededAppointmentIds } } });

  // Create payments (one aggregated payment per appointment where applicable).
  // Payment timestamps stay close to the appointment creation time so finance
  // views can match them to the folded creation history event.
  const payments = appointments
    .filter((appointment) => appointment.totalPaid > 0)
    .map((appointment, index) => {
      const paymentChangedAt = new Date(appointment.createdAt.getTime() + 1000);
      const isFull = appointment.totalPaid >= appointment.price;
      return {
        id: `${SEED_PREFIX}payment_${index + 1}`,
        appointmentId: appointment.id,
        patientId: appointment.patientId,
        amount: appointment.totalPaid,
        method: appointment.paymentMethod || "Cash",
        date: appointment.date,
        appointmentSnapshot: appointmentSnapshot(appointment),
        transactionId: `SEED-PAY-${String(index + 1).padStart(4, "0")}`,
        notes: isFull ? "Seed full payment." : "Seed partial payment.",
        status: isFull ? "paid" : "half-paid",
        createdAt: paymentChangedAt,
        updatedAt: paymentChangedAt,
      };
    });

  const paymentByAppointmentId = new Map(payments.map((payment) => [payment.appointmentId, payment]));

  // Appointment logs: create a single creation log per appointment.
  // Seeded initial payments are folded into this creation log so history shows
  // one event for "appointment created with payment applied".
  const appointmentLogs = appointments.map((appointment, index) => {
    const payment = paymentByAppointmentId.get(appointment.id);
    const seedPaymentAmount = payment ? Number(payment.amount || 0) : 0;
    const createdSnapshot = appointmentSnapshot(appointment);

    return {
      id: `${SEED_PREFIX}appt_log_${index + 1}_created`,
      appointmentId: appointment.id,
      previousState: {
        status: "none",
        paymentStatus: "none",
        price: 0,
        balance: 0,
        totalPaid: 0,
      },
      newState: createdSnapshot,
      changedBy: "admin",
      changedByName: "Admin",
      changedAt: appointment.createdAt,
      changeType: "created",
      amount: seedPaymentAmount,
      notes: seedPaymentAmount > 0
        ? "Seed appointment creation with payment applied."
        : "Seed appointment creation log.",
    };
  });

  // Seed payment history rows are intentionally omitted so initial seeded
  // payments do not appear as a second history event.

  const financeRecords = [
    ...payments.map((payment, index) => ({
      id: `${SEED_PREFIX}finance_payment_${index + 1}`,
      patientId: payment.patientId,
      type: "payment",
      amount: payment.amount,
      date: payment.date,
      appointmentSnapshot: payment.appointmentSnapshot,
      description: `Payment ${payment.transactionId} for ${payment.appointmentId}`,
      isSeeding: true,
      createdAt: now,
      updatedAt: now,
    })),
    {
      id: `${SEED_PREFIX}finance_monthly_supplies`,
      patientId: null,
      type: "expense",
      amount: 8750,
      date: dateFromToday(-8),
      appointmentSnapshot: null,
      description: "Dental supplies replenishment",
      isSeeding: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: `${SEED_PREFIX}finance_lab_fee`,
      patientId: `${SEED_PREFIX}patient_ana`,
      type: "expense",
      amount: 3200,
      date: dateFromToday(-3),
      appointmentSnapshot: appointmentSnapshot(appointments[2]),
      description: "External lab fee for Ana Cruz root canal case",
      isSeeding: true,
      createdAt: now,
      updatedAt: now,
    },
  ];

  const detailedExpenses = [
    {
      id: `${SEED_PREFIX}expense_gloves`,
      date: dateFromToday(-12),
      category: "Supplies",
      description: "Nitrile gloves and masks",
      price: 4200,
      amount: 4200,
      totalPaid: 4200,
      balance: 0,
      vendor: "Leyte Dental Depot",
      paymentMethod: "Bank Transfer",
      paymentDate: dateFromToday(-12),
      status: "paid",
      recurring: false,
      createdAt: now,
    },
    {
      id: `${SEED_PREFIX}expense_rent`,
      date: dateFromToday(-20),
      category: "Rent",
      description: "Clinic rent",
      price: 35000,
      amount: 35000,
      totalPaid: 35000,
      balance: 0,
      vendor: "Villahermosa Commercial Center",
      paymentMethod: "Bank Transfer",
      paymentDate: dateFromToday(-20),
      status: "paid",
      recurring: true,
      createdAt: now,
    },
    {
      id: `${SEED_PREFIX}expense_lab`,
      date: dateFromToday(-3),
      category: "Laboratory",
      description: "Crown prep lab fee",
      price: 3200,
      amount: 3200,
      totalPaid: 3200,
      balance: 0,
      vendor: "Ormoc Dental Lab",
      paymentMethod: "Cash",
      paymentDate: dateFromToday(-3),
      status: "paid",
      recurring: false,
      createdAt: now,
    },
  ];

  const expenseLogs = detailedExpenses.map((expense, index) => ({
    id: `${SEED_PREFIX}expense_log_${index + 1}_created`,
    expenseId: expense.id,
    previousState: {
      status: "none",
      amount: 0,
      paymentStatus: "none",
    },
    newState: expenseSnapshot(expense),
    ...financeSeedActor,
    changedAt: expense.createdAt,
    changeType: "created",
    amount: expense.amount,
    notes: "Seed expense creation log.",
  }));

  const inventory = [
    {
      id: `${SEED_PREFIX}inventory_gloves`,
      item: "Nitrile Gloves",
      quantity: 18,
      unit: "boxes",
      costPerUnit: 350,
      totalValue: 6300,
      supplier: "Leyte Dental Depot",
      lastOrdered: dateFromToday(-12),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: `${SEED_PREFIX}inventory_anesthetic`,
      item: "Local Anesthetic Cartridges",
      quantity: 72,
      unit: "cartridges",
      costPerUnit: 55,
      totalValue: 3960,
      supplier: "DentalCare PH",
      lastOrdered: dateFromToday(-18),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: `${SEED_PREFIX}inventory_composite`,
      item: "Composite Resin A2",
      quantity: 9,
      unit: "syringes",
      costPerUnit: 1250,
      totalValue: 11250,
      supplier: "Smile Materials",
      lastOrdered: dateFromToday(-30),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: `${SEED_PREFIX}inventory_fluoride`,
      item: "Fluoride Varnish",
      quantity: 4,
      unit: "packs",
      costPerUnit: 980,
      totalValue: 3920,
      supplier: "DentalCare PH",
      lastOrdered: dateFromToday(-45),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: `${SEED_PREFIX}inventory_xray`,
      item: "X-Ray Sensor Sleeves",
      quantity: 2,
      unit: "boxes",
      costPerUnit: 780,
      totalValue: 1560,
      supplier: "Leyte Dental Depot",
      lastOrdered: dateFromToday(-65),
      createdAt: now,
      updatedAt: now,
    },
  ];

  const inventoryLogs = inventory.map((item, index) => ({
    id: `${SEED_PREFIX}inventory_log_${index + 1}_created`,
    inventoryItemId: item.id,
    previousState: {
      quantity: 0,
      totalValue: 0,
    },
    newState: inventorySnapshot(item),
    ...financeSeedActor,
    changedAt: item.createdAt,
    changeType: "created",
    quantityChange: item.quantity,
    notes: "Seed inventory creation log.",
  }));

  const staffAttendance = staff.flatMap((member) => [
    {
      id: `${SEED_PREFIX}attendance_${member.id}_current`,
      staffId: member.id,
      staffName: member.name,
      date: monthFromNow(0),
      status: "present",
      hoursWorked: member.role === "Doctor" ? 132 : 160,
      daysPresent: member.role === "Doctor" ? 18 : 22,
      daysAbsent: member.role === "Doctor" ? 1 : 0,
      overtimeHours: member.role === "Receptionist" ? 6 : 2,
    },
    {
      id: `${SEED_PREFIX}attendance_${member.id}_previous`,
      staffId: member.id,
      staffName: member.name,
      date: monthFromNow(-1),
      status: "present",
      hoursWorked: member.role === "Doctor" ? 126 : 152,
      daysPresent: member.role === "Doctor" ? 17 : 21,
      daysAbsent: 1,
      overtimeHours: member.role === "Dental Assistant" ? 8 : 1,
    },
  ]);

  const staffFinancialRecords = [
    {
      id: `${SEED_PREFIX}staff_finance_maria_bonus`,
      staffId: `${SEED_PREFIX}staff_maria`,
      staffName: "Dr. Maria Villahermosa",
      type: "bonus",
      amount: 8000,
      date: dateFromToday(-6),
      status: "approved",
      notes: "Performance bonus for high patient satisfaction scores.",
      repaymentSchedule: null,
    },
    {
      id: `${SEED_PREFIX}staff_finance_liza_advance`,
      staffId: `${SEED_PREFIX}staff_liza`,
      staffName: "Liza Mercado",
      type: "advance",
      amount: 5000,
      date: dateFromToday(-14),
      status: "deducting",
      notes: "Salary advance payable over two payroll cycles.",
      repaymentSchedule: "2500 x 2 payrolls",
    },
    {
      id: `${SEED_PREFIX}staff_finance_paolo_commission`,
      staffId: `${SEED_PREFIX}staff_paolo`,
      staffName: "Dr. Paolo Reyes",
      type: "commission",
      amount: 6500,
      date: dateFromToday(-2),
      status: "pending",
      notes: "Orthodontic case commission.",
      repaymentSchedule: null,
    },
  ];

  const payrollLogs = staffFinancialRecords
    .filter(shouldCreatePayrollLog)
    .map((record, index) => ({
      id: `${SEED_PREFIX}payroll_log_${index + 1}_created`,
      staffId: record.staffId,
      payrollMonth: record.date.slice(0, 7),
      payrollRecordId: record.id,
      previousState: {
        status: "none",
        amount: 0,
      },
      newState: payrollRecordSnapshot(record),
      ...financeSeedActor,
      changedAt: now,
      changeType: "created",
      amount: record.amount,
      notes: "Seed payroll record creation log.",
    }));

  const notifications = [
    {
      id: `${SEED_PREFIX}notification_admin_root`,
      userId: "admin",
      title: "Root canal follow-up reserved",
      message: "Ana Cruz has a reserved appointment with partial payment.",
      type: "appointment",
      createdAt: dateTimeFromToday(-1),
      updatedAt: now,
      isRead: false,
      link: "/admin/calendar",
      isLog: false,
      metadata: {
        appointmentId: `${SEED_PREFIX}appt_ana_root`,
        patientId: `${SEED_PREFIX}patient_ana`,
      },
    },
    {
      id: `${SEED_PREFIX}notification_admin_inventory`,
      userId: "admin",
      title: "Low inventory",
      message: "X-Ray Sensor Sleeves are down to 2 boxes.",
      type: "inventory",
      createdAt: dateTimeFromToday(-2),
      updatedAt: now,
      isRead: false,
      link: "/admin/settings",
      isLog: false,
      metadata: { itemId: `${SEED_PREFIX}inventory_xray` },
    },
    {
      id: `${SEED_PREFIX}notification_test_patient`,
      userId: `${SEED_PREFIX}patient_test`,
      title: "Upcoming whitening appointment",
      message: "Your whitening appointment is scheduled soon.",
      type: "appointment",
      createdAt: now,
      updatedAt: now,
      isRead: false,
      link: "/patient/appointments",
      isLog: false,
      metadata: { appointmentId: `${SEED_PREFIX}appt_test_future` },
    },
    {
      id: `${SEED_PREFIX}notification_doctor`,
      userId: `${SEED_PREFIX}staff_test_doctor`,
      title: "Completed whitening case",
      message: "Clara Lim's whitening appointment has been marked completed.",
      type: "appointment",
      createdAt: dateTimeFromToday(-2),
      updatedAt: now,
      isRead: true,
      link: "/doctor/calendar",
      isLog: true,
      metadata: { appointmentId: `${SEED_PREFIX}appt_clara_whitening` },
    },
  ];

  const questionnaires = [
    {
      patientId: `${SEED_PREFIX}patient_test`,
      data: {
        chiefComplaint: "Routine checkup and whitening consult.",
        lastDentalVisit: dateFromToday(-10),
        medicalConditions: ["None"],
        medications: [],
        allergies: ["None"],
        consentAccepted: true,
      },
      updatedAt: now,
    },
    {
      patientId: `${SEED_PREFIX}patient_ana`,
      data: {
        chiefComplaint: "Sensitivity on upper right molar.",
        lastDentalVisit: dateFromToday(-4),
        medicalConditions: ["Mild asthma"],
        medications: ["Salbutamol as needed"],
        allergies: ["Penicillin"],
        consentAccepted: true,
      },
      updatedAt: now,
    },
  ];

  return {
    paymentMethods,
    staff,
    patients,
    appointments,
    appointmentLogs,
    payments,
    financeRecords,
    detailedExpenses,
    expenseLogs,
    inventory,
    inventoryLogs,
    staffAttendance,
    staffFinancialRecords,
    payrollLogs,
    notifications,
    questionnaires,
  };
}

type SeedData = Awaited<ReturnType<typeof buildSeedData>>;

const unique = (values: Array<string | null | undefined>): string[] => [
  ...new Set(values.filter((value): value is string => Boolean(value))),
];

const recordIds = (records: Array<{ id: string }>): string[] => records.map((record) => record.id);

const appointmentFinanceRecords = (data: SeedData) =>
  data.financeRecords.filter((record) => record.type === "payment");

const standaloneFinanceRecords = (data: SeedData) =>
  data.financeRecords.filter((record) => record.type !== "payment");

const appointmentNotifications = (data: SeedData) =>
  data.notifications.filter((notification) => notification.type === "appointment");

const inventoryNotifications = (data: SeedData) =>
  data.notifications.filter((notification) => notification.type === "inventory");

const deleteByIds = async (model: any, ids: string[]) => {
  if (ids.length === 0) return;
  await model.deleteMany({ where: { id: { in: ids } } });
};

const existingIds = async (model: any, ids: string[]): Promise<Set<string>> => {
  if (ids.length === 0) return new Set();
  const rows = await model.findMany({
    where: { id: { in: ids } },
    select: { id: true },
  });
  return new Set(rows.map((row: { id: string }) => row.id));
};

const assertSeedRowsExist = async (label: string, model: any, ids: string[]) => {
  const requiredIds = unique(ids);
  const foundIds = await existingIds(model, requiredIds);
  const missingIds = requiredIds.filter((id) => !foundIds.has(id));

  if (missingIds.length > 0) {
    throw new Error(
      `Cannot seed this segment because seeded ${label} are missing: ${missingIds.join(", ")}. ` +
        `Run the required seed command first, or run npm run seed to restore everything.`
    );
  }
};

const writeStatusConfiguration = async () => {
  console.log("Writing status configuration...");
  await prisma.statusConfig.upsert({
    where: { key: "appointment" },
    update: { value: APPOINTMENT_STATUSES as any },
    create: { key: "appointment", value: APPOINTMENT_STATUSES as any },
  });

  await prisma.statusConfig.upsert({
    where: { key: "payment" },
    update: { value: PAYMENT_STATUSES as any },
    create: { key: "payment", value: PAYMENT_STATUSES as any },
  });
};

const deleteAppointmentSeed = async (data: SeedData) => {
  const appointmentIds = recordIds(data.appointments);
  const appointmentNotificationIds = recordIds(appointmentNotifications(data));

  await prisma.paymentLog.deleteMany({
    where: {
      OR: [
        { id: { startsWith: SEED_PREFIX } },
        { appointmentId: { startsWith: `${SEED_PREFIX}appt_` } },
        { appointmentId: { in: appointmentIds } },
      ],
    },
  });
  await prisma.appointmentLog.deleteMany({
    where: {
      OR: [
        { id: { startsWith: SEED_PREFIX } },
        { appointmentId: { startsWith: `${SEED_PREFIX}appt_` } },
        { appointmentId: { in: appointmentIds } },
      ],
    },
  });
  await prisma.payment.deleteMany({
    where: {
      OR: [
        { id: { startsWith: `${SEED_PREFIX}payment_` } },
        { appointmentId: { startsWith: `${SEED_PREFIX}appt_` } },
        { appointmentId: { in: appointmentIds } },
        { patientId: { startsWith: `${SEED_PREFIX}patient_` } },
      ],
    },
  });
  await prisma.financeRecord.deleteMany({
    where: {
      OR: [
        { id: { startsWith: `${SEED_PREFIX}finance_payment_` } },
        { id: { in: recordIds(appointmentFinanceRecords(data)) } },
      ],
    },
  });
  await deleteByIds(prisma.notification, appointmentNotificationIds);
  await prisma.appointment.deleteMany({
    where: {
      OR: [
        { id: { startsWith: `${SEED_PREFIX}appt_` } },
        { patientId: { startsWith: `${SEED_PREFIX}patient_` } },
        { doctorId: { startsWith: `${SEED_PREFIX}staff_` } },
      ],
    },
  });
};

const deletePatientSeedRows = async () => {
  await prisma.questionnaire.deleteMany({
    where: { patientId: { startsWith: `${SEED_PREFIX}patient_` } },
  });
  await prisma.patient.deleteMany({ where: { id: { startsWith: `${SEED_PREFIX}patient_` } } });
};

const deletePatientSeed = async (data: SeedData) => {
  await deleteAppointmentSeed(data);
  await prisma.financeRecord.deleteMany({
    where: { patientId: { startsWith: `${SEED_PREFIX}patient_` } },
  });
  await prisma.notification.deleteMany({
    where: { userId: { startsWith: `${SEED_PREFIX}patient_` } },
  });
  await deletePatientSeedRows();
};

const deleteDoctorSeedRows = async () => {
  await prisma.payrollLog.deleteMany({
    where: {
      OR: [
        { id: { startsWith: `${SEED_PREFIX}payroll_log_` } },
        { staffId: { startsWith: `${SEED_PREFIX}staff_` } },
        { payrollRecordId: { startsWith: `${SEED_PREFIX}staff_finance_` } },
      ],
    },
  });
  await prisma.staffFinancialRecord.deleteMany({
    where: { id: { startsWith: `${SEED_PREFIX}staff_finance_` } },
  });
  await prisma.staffAttendance.deleteMany({
    where: { id: { startsWith: `${SEED_PREFIX}attendance_` } },
  });
  await prisma.staff.deleteMany({ where: { id: { startsWith: `${SEED_PREFIX}staff_` } } });
};

const deleteDoctorSeed = async (data: SeedData) => {
  await deleteAppointmentSeed(data);
  await prisma.notification.deleteMany({
    where: { userId: { startsWith: `${SEED_PREFIX}staff_` } },
  });
  await deleteDoctorSeedRows();
};

const deleteInventorySeed = async (data: SeedData) => {
  await deleteByIds(prisma.notification, recordIds(inventoryNotifications(data)));
  await prisma.inventoryLog.deleteMany({
    where: {
      OR: [
        { id: { startsWith: `${SEED_PREFIX}inventory_log_` } },
        { inventoryItemId: { startsWith: `${SEED_PREFIX}inventory_` } },
      ],
    },
  });
  await prisma.inventoryItem.deleteMany({
    where: { id: { startsWith: `${SEED_PREFIX}inventory_` } },
  });
};

const deleteStandaloneFinanceSeed = async (data: SeedData) => {
  await deleteByIds(prisma.financeRecord, recordIds(standaloneFinanceRecords(data)));
  await prisma.expenseLog.deleteMany({
    where: {
      OR: [
        { id: { startsWith: `${SEED_PREFIX}expense_log_` } },
        { expenseId: { startsWith: `${SEED_PREFIX}expense_` } },
      ],
    },
  });
  await prisma.expensePaymentLog.deleteMany({ where: { expenseId: { startsWith: `${SEED_PREFIX}expense_` } } });
  await prisma.expensePayment.deleteMany({ where: { expenseId: { startsWith: `${SEED_PREFIX}expense_` } } });
  await prisma.detailedExpense.deleteMany({
    where: { id: { startsWith: `${SEED_PREFIX}expense_` } },
  });
};

const deletePaymentMethodSeed = async () => {
  await prisma.paymentMethod.deleteMany({
    where: { id: { startsWith: `${SEED_PREFIX}payment_` } },
  });
};

const assertAppointmentDependencies = async (data: SeedData) => {
  await assertSeedRowsExist(
    "patients",
    prisma.patient,
    unique(data.appointments.map((appointment) => appointment.patientId))
  );
  await assertSeedRowsExist(
    "doctors",
    prisma.staff,
    unique(data.appointments.map((appointment) => appointment.doctorId))
  );
};

const assertFinanceDependencies = async (data: SeedData) => {
  await assertSeedRowsExist(
    "patients",
    prisma.patient,
    unique(standaloneFinanceRecords(data).map((record) => record.patientId))
  );
  await assertSeedRowsExist("appointments", prisma.appointment, recordIds(data.appointments));
};

const createPaymentMethodSeed = async (data: SeedData) => {
  console.log("Creating payment methods...");
  await createRecords(prisma.paymentMethod, data.paymentMethods);
};

const createDoctorSeed = async (data: SeedData) => {
  console.log("Creating doctors and clinic staff...");
  await createRecords(prisma.staff, data.staff);
  await createRecords(prisma.staffAttendance, data.staffAttendance);
  await createRecords(prisma.staffFinancialRecord, data.staffFinancialRecords);
  await createRecords(prisma.payrollLog, data.payrollLogs);
};

const createPatientSeed = async (data: SeedData) => {
  console.log("Creating patients and questionnaires...");
  await createRecords(prisma.patient, data.patients);
  await createRecords(prisma.questionnaire, data.questionnaires);
};

const createAppointmentSeed = async (data: SeedData) => {
  console.log("Creating appointments, logs, payments, finance records, and notifications...");
  await createRecords(prisma.appointment, data.appointments);
  await createRecords(prisma.appointmentLog, data.appointmentLogs);
  await createRecords(prisma.payment, data.payments);
  await createRecords(prisma.financeRecord, appointmentFinanceRecords(data));
  await createRecords(prisma.notification, appointmentNotifications(data));
};

const createInventorySeed = async (data: SeedData) => {
  console.log("Creating inventory, inventory logs, and inventory notifications...");
  await createRecords(prisma.inventoryItem, data.inventory);
  await createRecords(prisma.inventoryLog, data.inventoryLogs);
  await createRecords(prisma.notification, inventoryNotifications(data));
};

const createStandaloneFinanceSeed = async (data: SeedData) => {
  console.log("Creating standalone finance records, expenses, and expense logs...");
  await createRecords(prisma.financeRecord, standaloneFinanceRecords(data));
  await createRecords(prisma.detailedExpense, data.detailedExpenses);
  await createRecords(prisma.expensePayment, data.detailedExpenses.map((expense: any, index: number) => ({
    id: `${SEED_PREFIX}expense_payment_${index + 1}`,
    expenseId: expense.id,
    amount: expense.totalPaid ?? expense.amount,
    method: expense.paymentMethod || "cash",
    paymentDate: expense.paymentDate || expense.date,
    transactionId: `${SEED_PREFIX.toUpperCase()}EXP-${index + 1}`,
    notes: "Seed expense payment.",
    idempotencyKey: `${SEED_PREFIX}expense-payment-${index + 1}`,
    recordedBy: financeSeedActor.changedBy,
    recordedByName: financeSeedActor.changedByName,
    recordedByRole: financeSeedActor.changedByRole,
    expenseSnapshot: expenseSnapshot(expense),
    createdAt: expense.createdAt,
    updatedAt: expense.createdAt,
  })));
  await createRecords(prisma.expenseLog, data.expenseLogs);
};

const seedPaymentMethods = async (data: SeedData) => {
  await deletePaymentMethodSeed();
  await createPaymentMethodSeed(data);
};

const seedDoctors = async (data: SeedData) => {
  await deleteDoctorSeedRows();
  await createDoctorSeed(data);
};

const seedPatients = async (data: SeedData) => {
  await deletePatientSeedRows();
  await createPatientSeed(data);
};

const seedAppointments = async (data: SeedData) => {
  await assertAppointmentDependencies(data);
  await writeStatusConfiguration();
  await seedPaymentMethods(data);
  await deleteAppointmentSeed(data);
  await createAppointmentSeed(data);
};

const seedInventory = async (data: SeedData) => {
  await deleteInventorySeed(data);
  await createInventorySeed(data);
};

const seedFinance = async (data: SeedData) => {
  await assertFinanceDependencies(data);
  await deleteStandaloneFinanceSeed(data);
  await createStandaloneFinanceSeed(data);
};

const printSeedSummary = (data: SeedData) => {
  console.log("");
  console.log("Seed complete.");
  console.log(`Patients: ${data.patients.length}`);
  console.log(`Staff: ${data.staff.length}`);
  console.log(`Appointments: ${data.appointments.length}`);
  console.log(`Payments: ${data.payments.length}`);
  console.log("");
  console.log("Useful demo logins:");
  console.log("Admin: admin / password");
  console.log("Test Doctor shortcut: doctor / password -> maps to seed_staff_test_doctor");
  console.log("Doctor email login: maria.villahermosa@example.com / doctor123");
  console.log("Receptionist login: carlo.mendoza@example.com / password");
  console.log("Test Patient login: test@patient.com / villahermosa123");
};

const seedAll = async (data: SeedData) => {
  console.log("Resetting existing seeded rows...");
  await resetSeedData();
  await writeStatusConfiguration();
  await createPaymentMethodSeed(data);
  await createDoctorSeed(data);
  await createPatientSeed(data);
  await createAppointmentSeed(data);
  await createInventorySeed(data);
  await createStandaloneFinanceSeed(data);
  printSeedSummary(data);
};

const seedCommandDescriptions = [
  ["npm run seed", "Seeds everything in dependency order."],
  ["npm run seed:patients", "Restores seeded patients and questionnaires."],
  ["npm run seed:doctors", "Restores seeded doctors, staff, attendance, staff finance rows, and payroll logs."],
  ["npm run seed:staff", "Alias for seed:doctors."],
  ["npm run seed:appointments", "Restores appointments plus logs, payments, payment finance rows, and notifications. Requires seeded patients and doctors."],
  ["npm run seed:inventory", "Restores seeded inventory items, inventory logs, and inventory notifications."],
  ["npm run seed:finance", "Restores standalone finance records, detailed expenses, and expense logs. Requires seeded patients and appointments."],
  ["npm run seed:payment-methods", "Restores seeded payment methods."],
] as const;

const deleteCommandDescriptions = [
  ["npm run delete:all", "Deletes all rows managed by the seeder."],
  ["npm run delete:patients", "Deletes seeded patients and dependent seeded appointments."],
  ["npm run delete:doctors", "Deletes seeded doctors/staff, payroll logs, and dependent seeded appointments."],
  ["npm run delete:staff", "Alias for delete:doctors."],
  ["npm run delete:appointments", "Deletes seeded appointments plus logs, payments, payment finance rows, and notifications."],
  ["npm run delete:inventory", "Deletes seeded inventory items, inventory logs, and inventory notifications."],
  ["npm run delete:finance", "Deletes standalone seeded finance records, detailed expenses, and expense logs."],
  ["npm run delete:payment-methods", "Deletes seeded payment methods."],
] as const;

const printCommandList = () => {
  console.log("Available seeder commands:");
  console.log("");
  console.log("Seed commands:");
  for (const [command, description] of seedCommandDescriptions) {
    console.log(`  ${command.padEnd(31)} ${description}`);
  }
  console.log("");
  console.log("Delete commands:");
  for (const [command, description] of deleteCommandDescriptions) {
    console.log(`  ${command.padEnd(31)} ${description}`);
  }
};

const printUsage = () => {
  console.log("Usage: ts-node src/seeder.ts [command]");
  console.log("");
  printCommandList();
};

async function main() {
  const command = process.argv[2] || "seed:all";
  if (command === "seed:list" || command === "list" || command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set. Add it to villahermosadentalclinic-server/.env first.");
  }

  await assertRequiredSeedSchema();
  const data = await buildSeedData();

  switch (command) {
    case "seed:all":
      await seedAll(data);
      break;
    case "seed:payment-methods":
      await seedPaymentMethods(data);
      break;
    case "seed:doctors":
    case "seed:staff":
      await seedDoctors(data);
      break;
    case "seed:patients":
      await seedPatients(data);
      break;
    case "seed:appointments":
      await seedAppointments(data);
      break;
    case "seed:inventory":
      await seedInventory(data);
      break;
    case "seed:finance":
      await seedFinance(data);
      break;
    case "delete:all":
      console.log("Deleting all seeded rows...");
      await resetSeedData();
      break;
    case "delete:payment-methods":
      await deletePaymentMethodSeed();
      break;
    case "delete:doctors":
    case "delete:staff":
      await deleteDoctorSeed(data);
      break;
    case "delete:patients":
      await deletePatientSeed(data);
      break;
    case "delete:appointments":
      await deleteAppointmentSeed(data);
      break;
    case "delete:inventory":
      await deleteInventorySeed(data);
      break;
    case "delete:finance":
      await deleteStandaloneFinanceSeed(data);
      break;
    default:
      printUsage();
      throw new Error(`Unknown seed command: ${command}`);
  }
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
