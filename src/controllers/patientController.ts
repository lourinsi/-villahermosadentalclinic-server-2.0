import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { Patient, ApiResponse } from "../types/patient";
import { createNotification, notifyAdmin } from "../utils/notifications";
import { isPatientCartStatus, normalizeStatus } from "../constants/appointmentStatuses";
import { prisma } from "../lib/prisma";
import { getPatientDisplayName } from "../utils/patientIdentity";

const patientUpdateFields = [
  "name",
  "firstName",
  "lastName",
  "email",
  "phone",
  "alternateEmail",
  "alternatePhone",
  "dateOfBirth",
  "address",
  "city",
  "zipCode",
  "insurance",
  "status",
  "emergencyContact",
  "emergencyPhone",
  "medicalHistory",
  "treatmentPlan",
  "clinicalNotes",
  "allergies",
  "notes",
  "profilePicture",
  "parentId",
  "isPrimary",
  "relationship",
  "username",
  "dentalCharts",
  "balance",
  "lastVisit",
  "gender",
  "civilStatus",
  "age",
  "ethnicity",
  "religion",
  "nationality",
  "currentStreet",
  "currentBarangay",
  "currentProvince",
  "permanentStreet",
  "permanentBarangay",
  "permanentCity",
  "permanentProvince",
  "permanentZipCode",
  "landline",
  "emergencyFirstName",
  "emergencyLastName",
  "emergencyRelationship",
  "education",
  "occupation",
  "company",
  "companyAddress",
  "height",
  "weight",
] as const;

const stripPassword = <T extends Record<string, any>>(patient: T): Omit<T, "password"> => {
  const { password, ...patientForResponse } = patient;
  return patientForResponse;
};

const toFiniteNumber = (value: unknown): number => {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
};

const toPositiveBalance = (value: unknown): number => Math.max(0, toFiniteNumber(value));

const latestDate = (...dates: Array<string | null | undefined>) =>
  dates
    .map((date) => String(date || "").split(" ")[0])
    .filter(Boolean)
    .sort((a, b) => b.localeCompare(a))[0] || null;

const isBillableAppointment = (appointment: { status?: string | null; deleted?: boolean | null }) => {
  if (appointment.deleted) return false;

  const status = normalizeStatus(appointment.status);
  return status !== "cancelled" && status !== "deleted" && !isPatientCartStatus(status);
};

const getAppointmentOutstandingBalance = (
  appointment: {
    id?: string | null;
    price?: number | null;
    discount?: number | null;
    balance?: number | null;
    status?: string | null;
    deleted?: boolean | null;
  },
  paymentSums: Record<string, number>
) => {
  if (!isBillableAppointment(appointment)) return 0;

  const price = toFiniteNumber(appointment.price);
  const discount = toFiniteNumber(appointment.discount);
  const totalDue = Math.max(0, price - discount);
  const paid = appointment.id ? paymentSums[appointment.id] || 0 : 0;
  const EPS = 0.01;

  if (paid + EPS >= totalDue) return 0;
  if (appointment.balance !== undefined && appointment.balance !== null) {
    return toPositiveBalance(appointment.balance);
  }

  return Math.max(0, totalDue - paid);
};

const getComputedPatientStatus = (hasOverdue: boolean, effectiveLastVisit?: string | null) => {
  if (hasOverdue) return "overdue";

  if (effectiveLastVisit) {
    const lastVisitDate = new Date(`${String(effectiveLastVisit).split(" ")[0]}T00:00:00`);
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    if (lastVisitDate < oneYearAgo) return "inactive";
  }

  return "active";
};

const CONSENT_ACKNOWLEDGEMENT_IDS = [
  "treatment",
  "medications",
  "treatmentPlanChanges",
  "noGuarantee",
  "authorization",
  "financialResponsibility",
] as const;

const hasText = (value: unknown) => String(value || "").trim().length > 0;

const isConsentComplete = (questionnaireData: any) => {
  const acknowledgements = questionnaireData?.consentAcknowledgements;
  const allAcknowledged =
    acknowledgements &&
    typeof acknowledgements === "object" &&
    CONSENT_ACKNOWLEDGEMENT_IDS.every((id) => acknowledgements[id] === true);

  return (
    questionnaireData?.consentAccepted === true &&
    allAcknowledged &&
    hasText(questionnaireData?.consentPatientSignatureName) &&
    hasText(questionnaireData?.consentSignedDate) &&
    hasText(questionnaireData?.consentPatientSignatureImage) &&
    hasText(questionnaireData?.consentDentistSignatureName)
  );
};

const getProfileCompletionSummary = (questionnaireData: any) => {
  const consentComplete = isConsentComplete(questionnaireData);

  return {
    profileCompletion: consentComplete ? "complete" : "incomplete",
    profileCompletionMissing: consentComplete ? [] : ["consent form"],
  };
};

const withPatientProfileCompletion = async (patients: any[]) => {
  const patientIds = patients.map((patient) => patient.id).filter(Boolean) as string[];
  if (patientIds.length === 0) return patients;

  const questionnaires = await prisma.questionnaire.findMany({
    where: { patientId: { in: patientIds } },
    select: { patientId: true, data: true },
  });
  const questionnaireMap = new Map(questionnaires.map((questionnaire) => [questionnaire.patientId, questionnaire.data]));

  return patients.map((patient) => ({
    ...patient,
    ...getProfileCompletionSummary(questionnaireMap.get(patient.id)),
  }));
};

const appointmentDateOnly = (value?: string | null) => String(value || "").split(" ")[0];

const isPastAppointmentDate = (value?: string | null, todayStr = new Date().toISOString().split("T")[0]) => {
  const date = appointmentDateOnly(value);
  return Boolean(date && date < todayStr);
};

const compareAppointmentSchedule = (a: any, b: any) => {
  const aDate = appointmentDateOnly(a.date);
  const bDate = appointmentDateOnly(b.date);
  if (aDate !== bDate) return aDate.localeCompare(bDate);
  return String(a.time || "").localeCompare(String(b.time || ""));
};

const withPatientAppointmentSummaries = async (patients: any[], doctor?: string) => {
  const patientIds = patients.map((patient) => patient.id).filter(Boolean) as string[];
  if (patientIds.length === 0) return patients;

  const appointmentWhere: any = {
    deleted: false,
    patientId: { in: patientIds },
  };
  if (doctor) appointmentWhere.doctor = doctor;

  const appts = await prisma.appointment.findMany({
    where: appointmentWhere,
    select: {
      id: true,
      patientId: true,
      price: true,
      discount: true,
      status: true,
      date: true,
      time: true,
      paymentStatus: true,
      balance: true,
      totalPaid: true,
    },
  });

  const apptIds = appts.map((appointment) => appointment.id).filter(Boolean) as string[];
  const payments = apptIds.length
    ? await prisma.payment.findMany({
        where: { deleted: false, appointmentId: { in: apptIds } },
        select: { appointmentId: true, amount: true },
      })
    : [];

  const paymentSums: Record<string, number> = {};
  for (const payment of payments) {
    const appointmentId = payment.appointmentId as string;
    paymentSums[appointmentId] = (paymentSums[appointmentId] || 0) + Number(payment.amount || 0);
  }

  const todayStr = new Date().toISOString().split("T")[0];
  const apptMap: Record<
    string,
    {
      totalBalance: number;
      hasOverdue: boolean;
      overdueAppointmentCount: number;
      lastCompletedDate?: string | null;
      nextAppointment?: any;
    }
  > = {};

  for (const appointment of appts) {
    const patientId = appointment.patientId as string;
    if (!apptMap[patientId]) {
      apptMap[patientId] = {
        totalBalance: 0,
        hasOverdue: false,
        overdueAppointmentCount: 0,
        lastCompletedDate: null,
        nextAppointment: null,
      };
    }

    const entry = apptMap[patientId];
    const aptStatus = normalizeStatus(appointment.status);
    const appointmentDate = appointmentDateOnly(appointment.date);
    const billable = isBillableAppointment(appointment);

    const outstandingBalance = getAppointmentOutstandingBalance(appointment, paymentSums);
    entry.totalBalance += outstandingBalance;

    if (
      billable &&
      (
        String(appointment.paymentStatus || "").toLowerCase() === "overdue" ||
        (outstandingBalance > 0 && isPastAppointmentDate(appointment.date, todayStr))
      )
    ) {
      entry.hasOverdue = true;
      entry.overdueAppointmentCount += 1;
    }

    if (aptStatus === "completed" && appointmentDate) {
      if (!entry.lastCompletedDate || appointmentDate > entry.lastCompletedDate) {
        entry.lastCompletedDate = appointmentDate;
      }
    }

    if (
      appointmentDate >= todayStr &&
      aptStatus !== "completed" &&
      aptStatus !== "cancelled" &&
      aptStatus !== "deleted" &&
      !isPatientCartStatus(aptStatus)
    ) {
      if (!entry.nextAppointment || compareAppointmentSchedule(appointment, entry.nextAppointment) < 0) {
        entry.nextAppointment = appointment;
      }
    }
  }

  return patients.map((patient) => {
    const agg = apptMap[patient.id] || {
      totalBalance: 0,
      hasOverdue: false,
      overdueAppointmentCount: 0,
      lastCompletedDate: null,
      nextAppointment: null,
    };
    const effectiveLastVisit = latestDate(patient.lastVisit, agg.lastCompletedDate);
    const computedBalance = agg.totalBalance > 0 ? agg.totalBalance : toPositiveBalance(patient.balance);
    const newStatus = getComputedPatientStatus(agg.hasOverdue, effectiveLastVisit);

    return {
      ...patient,
      balance: computedBalance,
      status: newStatus,
      lastVisit: effectiveLastVisit,
      nextAppointment: agg.nextAppointment?.date ? appointmentDateOnly(agg.nextAppointment.date) : null,
      overdueAppointmentCount: agg.overdueAppointmentCount,
    } as any;
  });
};

const buildPatientUpdateData = (input: Record<string, any>) => {
  const data: Record<string, any> = {};

  for (const field of patientUpdateFields) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      data[field] = input[field];
    }
  }

  data.updatedAt = new Date();
  return data;
};

const buildPatientCreateData = (
  patientData: Partial<Patient>,
  id: string,
  passwordHash?: string
) => {
  const firstName = patientData.firstName || "";
  const lastName = patientData.lastName || "";
  const isPrimary =
    patientData.isPrimary !== undefined ? patientData.isPrimary : patientData.parentId ? false : true;

  return {
    id,
    name: patientData.name || `${firstName} ${lastName}`.trim() || patientData.email || patientData.phone || id,
    firstName,
    lastName,
    email: patientData.email || "",
    phone: patientData.phone || "",
    alternateEmail: patientData.alternateEmail || "",
    alternatePhone: patientData.alternatePhone || "",
    password: passwordHash,
    dateOfBirth: patientData.dateOfBirth || "",
    address: patientData.address || "",
    city: patientData.city || "",
    zipCode: patientData.zipCode || "",
    insurance: patientData.insurance || "",
    status: patientData.status || "active",
    emergencyContact: patientData.emergencyContact || "",
    emergencyPhone: patientData.emergencyPhone || "",
    medicalHistory: patientData.medicalHistory || "",
    treatmentPlan: patientData.treatmentPlan || "",
    clinicalNotes: patientData.clinicalNotes || "",
    allergies: patientData.allergies || "",
    notes: patientData.notes || "",
    profilePicture: patientData.profilePicture || null,
    parentId: isPrimary ? null : patientData.parentId || null,
    isPrimary,
    relationship: patientData.relationship || null,
    username: patientData.username || null,
    dentalCharts: patientData.dentalCharts || [],
    balance: (patientData as any).balance ?? null,
    lastVisit: patientData.lastVisit || null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deleted: false,
  };
};

export const addPatient = async (req: Request, res: Response<ApiResponse<Patient>>) => {
  try {
    const user = (req as any).user;
    if (user?.role === "patient") {
      return res.status(403).json({
        success: false,
        message: "Patients are not allowed to add other patients",
      });
    }

    const patientData: Patient = req.body;

    if (!patientData.firstName) {
      return res.status(400).json({
        success: false,
        message: "Missing required field: firstName",
      });
    }

    const passwordHash = patientData.password
      ? patientData.password
      : await bcrypt.hash("villahermosa123", 10);
    const id = `patient_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    const newPatient = await prisma.patient.create({
      data: buildPatientCreateData(patientData, id, passwordHash) as any,
    });

    notifyAdmin(
      "New Patient Registration",
      `A new patient, ${newPatient.firstName || ""} ${newPatient.lastName || ""}, has registered.`,
      "system"
    );

    createNotification(
      id,
      "Welcome to Villahermosa Dental Clinic",
      "Thank you for registering with us. We look forward to serving you!",
      "system"
    );

    res.status(201).json({
      success: true,
      message: "Patient added successfully",
      data: stripPassword(newPatient) as unknown as Patient,
    });
  } catch (error) {
    console.error("[PATIENT CREATE] ERROR:", error);
    res.status(500).json({
      success: false,
      message: "Error adding patient",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const addPublicBookingPatient = async (
  req: Request,
  res: Response<ApiResponse<Patient>>
) => {
  try {
    const patientData: Patient = req.body;

    if (!patientData.firstName) {
      return res.status(400).json({ success: false, message: "Missing required field: firstName" });
    }
    if (!patientData.lastName) {
      return res.status(400).json({ success: false, message: "Missing required field: lastName" });
    }
    if (!patientData.phone) {
      return res.status(400).json({ success: false, message: "Missing required field: phone" });
    }

    const existingPatient = await prisma.patient.findFirst({
      where: {
        deleted: false,
        OR: [
          ...(patientData.email ? [{ email: patientData.email }] : []),
          ...(patientData.phone ? [{ phone: patientData.phone }] : []),
        ],
      },
    });

    if (existingPatient) {
      return res.status(200).json({
        success: true,
        message: "Patient already exists",
        data: stripPassword(existingPatient) as unknown as Patient,
      });
    }

    const passwordHash = await bcrypt.hash("villahermosa123", 10);
    const id = `patient_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const newPatient = await prisma.patient.create({
      data: buildPatientCreateData({ ...patientData, isPrimary: true }, id, passwordHash) as any,
    });

    notifyAdmin(
      "New Public Booking Patient",
      `A new patient, ${newPatient.firstName || ""} ${newPatient.lastName || ""}, was created from public booking.`,
      "system"
    );

    res.status(201).json({
      success: true,
      message: "Patient added successfully",
      data: stripPassword(newPatient) as unknown as Patient,
    });
  } catch (error) {
    console.error("[PUBLIC PATIENT CREATE] ERROR:", error);
    res.status(500).json({
      success: false,
      message: "Error adding patient",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const addDependent = async (req: Request, res: Response<ApiResponse<Patient>>) => {
  try {
    const {
      parentId,
      firstName,
      lastName,
      relationship,
      dateOfBirth,
      medicalHistory,
      allergies,
      alternateEmail,
      alternatePhone,
    } = req.body;

    if (!parentId || !firstName || !lastName) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: parentId, firstName, lastName",
      });
    }

    const parent = await prisma.patient.findUnique({ where: { id: parentId } });
    if (!parent || parent.deleted) {
      return res.status(404).json({ success: false, message: "Parent patient not found" });
    }

    const id = `patient_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const newPatient = await prisma.patient.create({
      data: {
        id,
        name: `${firstName} ${lastName}`.trim(),
        firstName,
        lastName,
        email: parent.email || "",
        phone: parent.phone || "",
        alternateEmail: alternateEmail || "",
        alternatePhone: alternatePhone || "",
        parentId,
        isPrimary: false,
        relationship: relationship || "Family Member",
        dateOfBirth: dateOfBirth || "",
        address: parent.address || "",
        city: parent.city || "",
        zipCode: parent.zipCode || "",
        insurance: parent.insurance || "",
        medicalHistory: medicalHistory || "",
        allergies: allergies || "",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
        deleted: false,
      },
    });

    createNotification(
      parentId,
      "Dependent Added",
      `${firstName} ${lastName} has been added as a dependent to your account.`,
      "system"
    );

    res.status(201).json({
      success: true,
      message: "Dependent patient added successfully",
      data: stripPassword(newPatient) as unknown as Patient,
    });
  } catch (error) {
    console.error("[ADD DEPENDENT] ERROR:", error);
    res.status(500).json({
      success: false,
      message: "Error adding dependent",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const getPatients = async (
  req: Request,
  res: Response<ApiResponse<Patient[]>>
) => {
  try {
    const { page = "1", limit = "10", search = "", status = "all", parentId = "", doctor = "" } =
      req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, parseInt(limit, 10) || 10);

    let active = (await prisma.patient.findMany({
      where: { deleted: false },
      orderBy: { createdAt: "desc" },
    })) as any[];

    if (doctor) {
      const appointments = await prisma.appointment.findMany({
        where: { deleted: false, doctor },
        select: { patientId: true },
      });
      const doctorPatientIds = new Set(appointments.map((appointment) => appointment.patientId));
      active = active.filter((patient) => doctorPatientIds.has(patient.id || ""));
    }

    if (parentId) {
      active = active.filter((patient) => patient.parentId === parentId);
    }

    if (search && search.trim().length > 0) {
      const q = search.trim().toLowerCase();
      active = active.filter((patient) => {
        const full = `${patient.firstName || ""} ${patient.lastName || ""}`.toLowerCase();
        return (
          full.includes(q) ||
          (patient.email || "").toLowerCase().includes(q) ||
          (patient.phone || "").toLowerCase().includes(q)
        );
      });
    }

    if (status && status !== "all") {
      active = await withPatientAppointmentSummaries(active, doctor);
      active = active.filter((patient) => patient.status === status);
    }

    const requester = (req as any).user || (req as any).authUser;
    if (requester?.role === "patient") {
      const userEmail = String(requester.email || "").toLowerCase();
      const userName = String(requester.username || "").toLowerCase();
      const userId = requester.id || requester.patientId ? String(requester.id || requester.patientId) : undefined;

      active = active.filter((patient) => {
        const patientEmail = String(patient.email || "").toLowerCase();
        const patientUsername = String(patient.username || patient.email || "").toLowerCase();
        const patientName = String(patient.name || "").toLowerCase();

        return (
          (userEmail && patientEmail === userEmail) ||
          (userName && (patientUsername === userName || patientName === userName)) ||
          (userId && String(patient.parentId || patient.id) === userId)
        );
      });
    }

    const completedActive = await withPatientProfileCompletion(active);
    const incompletePatientCount = completedActive.filter(
      (patient) => String(patient.profileCompletion || "").toLowerCase() === "incomplete"
    ).length;
    active = completedActive;

    const total = active.length;
    const totalPages = Math.max(1, Math.ceil(total / limitNum));
    const start = (pageNum - 1) * limitNum;
    const pageItems = active.slice(start, start + limitNum);
    const summarizedItems = status && status !== "all"
      ? pageItems
      : await withPatientAppointmentSummaries(pageItems, doctor);
    const items = summarizedItems.map((patient) => stripPassword(patient));

    res.json({
      success: true,
      message: "Patients retrieved successfully",
      data: items as unknown as Patient[],
      meta: { total, page: pageNum, limit: limitNum, totalPages, incompletePatientCount },
    });
  } catch (error) {
    console.error("Error fetching patients:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching patients",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const getPatientOptions = async (
  req: Request,
  res: Response<ApiResponse<Patient[]>>
) => {
  try {
    const {
      search = "",
      limit = "1000",
      doctor = "",
      selectedId = "",
    } = req.query as Record<string, string>;
    const limitNum = Math.max(1, Math.min(1000, parseInt(limit, 10) || 1000));
    const q = search.trim().toLowerCase();

    const where: any = { deleted: false };

    if (q) {
      where.OR = [
        { firstName: { contains: q, mode: "insensitive" } },
        { lastName: { contains: q, mode: "insensitive" } },
        { name: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
        { phone: { contains: q, mode: "insensitive" } },
      ];
    }

    if (doctor) {
      const appointments = await prisma.appointment.findMany({
        where: { deleted: false, doctor },
        select: { patientId: true },
      });
      const doctorPatientIds = Array.from(new Set(appointments.map((appointment) => appointment.patientId).filter(Boolean)));
      where.id = { in: doctorPatientIds };
    }

    const requester = (req as any).user || (req as any).authUser;
    if (requester?.role === "patient") {
      const userEmail = String(requester.email || "").toLowerCase();
      const userName = String(requester.username || "").toLowerCase();
      const userId = requester.id || requester.patientId ? String(requester.id || requester.patientId) : undefined;
      const patientClauses = [
        ...(userEmail ? [{ email: { equals: userEmail, mode: "insensitive" } }] : []),
        ...(userName ? [{ username: { equals: userName, mode: "insensitive" } }, { name: { equals: userName, mode: "insensitive" } }] : []),
        ...(userId ? [{ id: userId }, { parentId: userId }] : []),
      ];

      if (patientClauses.length > 0) {
        where.AND = [...(where.AND || []), { OR: patientClauses }];
      }
    }

    let patients = await prisma.patient.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limitNum,
      select: {
        id: true,
        name: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        profilePicture: true,
        dateOfBirth: true,
        parentId: true,
        isPrimary: true,
        relationship: true,
      },
    });

    if (selectedId && !patients.some((patient) => patient.id === selectedId)) {
      const selectedPatient = await prisma.patient.findFirst({
        where: { id: selectedId, deleted: false },
        select: {
          id: true,
          name: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          profilePicture: true,
          dateOfBirth: true,
          parentId: true,
          isPrimary: true,
          relationship: true,
        },
      });
      if (selectedPatient) patients = [selectedPatient, ...patients];
    }

    res.json({
      success: true,
      message: "Patient options retrieved successfully",
      data: patients as unknown as Patient[],
      meta: { total: patients.length, limit: limitNum },
    });
  } catch (error) {
    console.error("Error fetching patient options:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching patient options",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const getPatientById = async (
  req: Request,
  res: Response<ApiResponse<Patient | null>>
) => {
  try {
    const patient = await prisma.patient.findUnique({ where: { id: req.params.id as string } }) as any;

    if (!patient || patient.deleted) {
      return res.status(404).json({ success: false, message: "Patient not found" });
    }

    const [summarizedPatient] = await withPatientAppointmentSummaries([patient]);
    const [patientForResponse] = await withPatientProfileCompletion([summarizedPatient]);

    res.json({
      success: true,
      message: "Patient retrieved successfully",
      data: stripPassword(patientForResponse) as unknown as Patient,
    });
  } catch (error) {
    console.error("Error fetching patient:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching patient",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const updatePatient = async (
  req: Request,
  res: Response<ApiResponse<Patient | null>>
) => {
  try {
    const patient = await prisma.patient.findUnique({ where: { id: req.params.id as string } });
    if (!patient || patient.deleted) {
      return res.status(404).json({ success: false, message: "Patient not found" });
    }

    delete req.body.password;

    const updateData = buildPatientUpdateData(req.body);
    if (!req.body.name && (req.body.firstName !== undefined || req.body.lastName !== undefined)) {
      updateData.name = `${req.body.firstName ?? patient.firstName ?? ""} ${
        req.body.lastName ?? patient.lastName ?? ""
      }`.trim();
    }

    const updatedPatient = await prisma.patient.update({
      where: { id: req.params.id as string },
      data: updateData as any,
    });
    const currentPatientName = getPatientDisplayName(updatedPatient);

    await prisma.appointment.updateMany({
      where: { patientId: updatedPatient.id, deleted: false },
      data: { patientName: currentPatientName, updatedAt: new Date() },
    });

    res.json({
      success: true,
      message: "Patient updated successfully",
      data: stripPassword(updatedPatient) as unknown as Patient,
    });
  } catch (error) {
    console.error("[PATIENT UPDATE] ERROR:", error);
    res.status(500).json({
      success: false,
      message: "Error updating patient",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const getQuestionnaire = async (
  req: Request,
  res: Response<ApiResponse<any>>
) => {
  try {
    const patient = await prisma.patient.findUnique({ where: { id: req.params.patientId as string } });

    if (!patient || patient.deleted) {
      return res.status(200).json({
        success: true,
        data: null,
        message: "No questionnaire found",
      });
    }

    const questionnaireData = {
      patientId: patient.id,
      gender: patient.gender,
      civilStatus: patient.civilStatus,
      age: patient.age,
      ethnicity: patient.ethnicity,
      religion: patient.religion,
      nationality: patient.nationality,
      currentStreet: patient.currentStreet,
      currentBarangay: patient.currentBarangay,
      currentCity: patient.city,
      currentProvince: patient.currentProvince,
      currentZipCode: patient.zipCode,
      permanentStreet: patient.permanentStreet,
      permanentBarangay: patient.permanentBarangay,
      permanentCity: patient.permanentCity,
      permanentProvince: patient.permanentProvince,
      permanentZipCode: patient.permanentZipCode,
      landline: patient.landline,
      mobileContact: patient.phone,
      emailAddress: patient.email,
      emergencyFirstName: patient.emergencyFirstName,
      emergencyLastName: patient.emergencyLastName,
      emergencyRelationship: patient.emergencyRelationship,
      emergencyContact: patient.emergencyContact,
      emergencyPhone: patient.emergencyPhone,
      education: patient.education,
      occupation: patient.occupation,
      company: patient.company,
      companyAddress: patient.companyAddress,
      height: patient.height,
      weight: patient.weight,
    };

    res.status(200).json({
      success: true,
      data: questionnaireData,
      message: "Questionnaire retrieved successfully",
    });
  } catch (error) {
    console.error("[GET QUESTIONNAIRE] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch questionnaire",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const upsertQuestionnaire = async (
  req: Request,
  res: Response<ApiResponse<Patient | null>>
) => {
  try {
    const patient = await prisma.patient.findUnique({ where: { id: req.params.patientId as string } });
    if (!patient || patient.deleted) {
      return res.status(404).json({ success: false, message: "Patient not found" });
    }

    const questionnaireData = req.body;
    const updateData = {
      gender: questionnaireData.gender,
      civilStatus: questionnaireData.civilStatus,
      age: questionnaireData.age,
      ethnicity: questionnaireData.ethnicity,
      religion: questionnaireData.religion,
      nationality: questionnaireData.nationality,
      currentStreet: questionnaireData.currentStreet,
      currentBarangay: questionnaireData.currentBarangay,
      city: questionnaireData.currentCity,
      currentProvince: questionnaireData.currentProvince,
      zipCode: questionnaireData.currentZipCode,
      permanentStreet: questionnaireData.permanentStreet,
      permanentBarangay: questionnaireData.permanentBarangay,
      permanentCity: questionnaireData.permanentCity,
      permanentProvince: questionnaireData.permanentProvince,
      permanentZipCode: questionnaireData.permanentZipCode,
      landline: questionnaireData.landline,
      phone: questionnaireData.mobileContact,
      email: questionnaireData.emailAddress,
      emergencyFirstName: questionnaireData.emergencyFirstName,
      emergencyLastName: questionnaireData.emergencyLastName,
      emergencyRelationship: questionnaireData.emergencyRelationship,
      emergencyContact: questionnaireData.emergencyContact,
      emergencyPhone: questionnaireData.emergencyPhone,
      education: questionnaireData.education,
      occupation: questionnaireData.occupation,
      company: questionnaireData.company,
      companyAddress: questionnaireData.companyAddress,
      height: questionnaireData.height,
      weight: questionnaireData.weight,
      updatedAt: new Date(),
    };

    const updatedPatient = await prisma.patient.update({
      where: { id: req.params.patientId as string },
      data: updateData,
    });

    res.json({
      success: true,
      data: stripPassword(updatedPatient) as unknown as Patient,
      message: "Questionnaire saved successfully",
    });
  } catch (error) {
    console.error("[QUESTIONNAIRE UPDATE] ERROR:", error);
    res.status(500).json({
      success: false,
      message: "Failed to save questionnaire",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const deletePatient = async (
  req: Request,
  res: Response<ApiResponse<null>>
) => {
  try {
    const patient = await prisma.patient.findUnique({ where: { id: req.params.id as string } });
    if (!patient || patient.deleted) {
      return res.status(404).json({ success: false, message: "Patient not found" });
    }

    await prisma.patient.update({
      where: { id: req.params.id as string },
      data: { deleted: true, deletedAt: new Date(), updatedAt: new Date() },
    });

    res.json({ success: true, message: "Patient deleted (soft) successfully" });
  } catch (error) {
    console.error("[PATIENT DELETE] Error deleting patient:", error);
    res.status(500).json({
      success: false,
      message: "Error deleting patient",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const changePassword = async (
  req: Request,
  res: Response<ApiResponse<null>>
) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const patient = await prisma.patient.findUnique({ where: { id: req.params.id as string } });

    if (!patient || patient.deleted) {
      return res.status(404).json({ success: false, message: "Patient not found" });
    }

    if (!patient.password) {
      return res.status(400).json({
        success: false,
        message: "Patient does not have a password set.",
      });
    }

    const isMatch = await bcrypt.compare(currentPassword, patient.password);
    if (!isMatch) {
      return res.status(400).json({
        success: false,
        message: "Incorrect current password",
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, await bcrypt.genSalt(10));
    await prisma.patient.update({
      where: { id: req.params.id as string },
      data: { password: hashedPassword, updatedAt: new Date() },
    });

    res.json({ success: true, message: "Password changed successfully" });
  } catch (error) {
    console.error("[PATIENT PASSWORD] Error changing password:", error);
    res.status(500).json({
      success: false,
      message: "Error changing password",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
