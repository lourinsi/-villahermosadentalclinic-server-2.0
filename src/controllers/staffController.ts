import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import {
  Staff,
  StaffFinancialRecord,
  Attendance as BaseAttendance,
  ApiResponse,
} from "../types/staff";
import { createNotification, notifyAdmin } from "../utils/notifications";
import { prisma } from "../lib/prisma";
import { createFinanceHistoryLog, getFinanceHistoryActor } from "../utils/financeHistoryLogs";

interface Attendance extends BaseAttendance {
  id: string;
  date: string;
  status: string;
}

const DEFAULT_STAFF_PASSWORD = "password";

const staffUpdateFields = [
  "name",
  "role",
  "department",
  "email",
  "phone",
  "hireDate",
  "baseSalary",
  "status",
  "employmentType",
  "specialization",
  "licenseNumber",
  "password",
  "profilePicture",
  "bio",
] as const;

const isDoctorStaff = (staff: Record<string, any>) => {
  const role = String(staff.role || "").toLowerCase();
  const specialization = String(staff.specialization || "").toLowerCase();
  return (
    role.includes("doctor") ||
    role.includes("dentist") ||
    specialization.includes("doctor") ||
    specialization.includes("dentist")
  );
};

const toStaff = (staff: unknown): Staff => staff as Staff;
const toStaffFinancialRecord = (record: unknown): StaffFinancialRecord =>
  record as StaffFinancialRecord;
const toAttendance = (record: unknown): Attendance => record as Attendance;
type IdParams = { id: string };

const currentMonthKey = () => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${now.getFullYear()}-${month}`;
};

const toFiniteNumber = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const buildStaffUpdateData = (input: Record<string, any>) => {
  const data: Record<string, any> = {};
  for (const field of staffUpdateFields) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      data[field] = input[field];
    }
  }
  data.updatedAt = new Date();
  return data;
};

const hashStaffPassword = (password: unknown) =>
  bcrypt.hash(String(password || DEFAULT_STAFF_PASSWORD), 10);

const payrollFinancialRecordTypes = new Set([
  "salary",
  "payroll",
  "monthlysalary",
  "monthly_salary",
  "bonus",
  "commission",
  "overtime",
  "allowance",
  "deduction",
  "salaryadjustment",
  "salary_adjustment",
  "salaryreduction",
  "salary_reduction",
  "payrolladjustment",
  "payroll_adjustment",
]);

const payrollRecordContext = (record: { date?: string | null }) => {
  const date = String(record.date || "");
  return /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 7) : "";
};

const shouldLogPayrollFinancialRecord = (record: { type?: string | null }) =>
  payrollFinancialRecordTypes.has(String(record.type || "").toLowerCase().replace(/[^a-z0-9_]/g, ""));

export const createStaff = async (
  req: Request,
  res: Response<ApiResponse<Staff>>
) => {
  try {
    const staffData: Staff = req.body;

    if (!staffData.name || !staffData.role || !staffData.email) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: name, role, email",
      });
    }

    const newStaff = await prisma.staff.create({
      data: {
        id: `staff_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        name: staffData.name,
        role: staffData.role,
        department: staffData.department || "",
        email: staffData.email || "",
        phone: staffData.phone || "",
        hireDate: staffData.hireDate || "",
        baseSalary: staffData.baseSalary || 0,
        status: staffData.status || "active",
        employmentType: staffData.employmentType || "",
        specialization: staffData.specialization || "",
        licenseNumber: staffData.licenseNumber || "",
        password: await hashStaffPassword(staffData.password),
        profilePicture: staffData.profilePicture || null,
        bio: staffData.bio || null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deleted: false,
      },
    });

    notifyAdmin(
      "New Staff Member Added",
      `${newStaff.name} has been added to the team as ${newStaff.role}.`,
      "system"
    );

    res.status(201).json({
      success: true,
      message: "Staff member added successfully",
      data: toStaff(newStaff),
    });
  } catch (error) {
    console.error("[STAFF CREATE] ERROR:", error);
    res.status(500).json({
      success: false,
      message: "Error adding staff member",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const getAllStaff = async (
  req: Request,
  res: Response<ApiResponse<Staff[]>>
) => {
  try {
    const { page = "1", limit = "20", role } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, parseInt(limit, 10) || 20);

    let activeStaff = (await prisma.staff.findMany({
      where: { deleted: false },
      orderBy: { createdAt: "desc" },
    })) as any[];

    if (role) {
      const rolesToFilter = role.split(",").map((r) => r.trim().toLowerCase());
      activeStaff = activeStaff.filter((staff) =>
        rolesToFilter.includes(String(staff.role || "").toLowerCase())
      );
    }

    const total = activeStaff.length;
    const totalPages = Math.max(1, Math.ceil(total / limitNum));
    const start = (pageNum - 1) * limitNum;
    const items = activeStaff.slice(start, start + limitNum);

    res.json({
      success: true,
      message: "Staff members retrieved successfully",
      data: items as unknown as Staff[],
      meta: { total, page: pageNum, limit: limitNum, totalPages },
    });
  } catch (error) {
    console.error("[STAFF GET_ALL] Error fetching staff members:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching staff members",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const getPublicDoctors = async (
  req: Request,
  res: Response<ApiResponse<Partial<Staff>[]>>
) => {
  try {
    const staffMembers = await prisma.staff.findMany({ where: { deleted: false } });
    const doctors = staffMembers.filter(isDoctorStaff).map((staff) => ({
      id: staff.id,
      name: staff.name,
      role: staff.role,
      specialization: staff.specialization || "",
      profilePicture: staff.profilePicture || "",
      bio: staff.bio || "",
    }));

    res.json({
      success: true,
      message: "Doctors retrieved successfully",
      data: doctors,
    });
  } catch (error) {
    console.error("[STAFF PUBLIC_DOCTORS] Error fetching doctors:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching doctors",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const getStaffById = async (
  req: Request<IdParams>,
  res: Response<ApiResponse<Staff | null>>
) => {
  try {
    const staff = await prisma.staff.findUnique({ where: { id: req.params.id } });

    if (!staff || staff.deleted) {
      return res.status(404).json({
        success: false,
        message: "Staff member not found",
      });
    }

    res.json({
      success: true,
      message: "Staff member retrieved successfully",
      data: toStaff(staff),
    });
  } catch (error) {
    console.error("[STAFF GET_BY_ID] Error fetching staff member:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching staff member",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const updateStaff = async (
  req: Request<IdParams>,
  res: Response<ApiResponse<Staff | null>>
) => {
  try {
    const staff = await prisma.staff.findUnique({ where: { id: req.params.id } });
    if (!staff || staff.deleted) {
      return res.status(404).json({
        success: false,
        message: "Staff member not found",
      });
    }

    const updateData = buildStaffUpdateData(req.body);
    if (Object.prototype.hasOwnProperty.call(updateData, "password")) {
      updateData.password = await hashStaffPassword(updateData.password);
    }

    const updatedStaff = await prisma.staff.update({
      where: { id: req.params.id },
      data: updateData as any,
    });
    const nameChanged =
      Object.prototype.hasOwnProperty.call(req.body, "name") &&
      String(req.body.name || "").trim() &&
      String(req.body.name || "").trim() !== String(staff.name || "").trim();

    if (nameChanged) {
      const nextName = String(updatedStaff.name || "").trim();
      await Promise.all([
        (prisma.appointment as any).updateMany({
          where: {
            OR: [
              { doctorId: staff.id },
              { doctor: staff.name },
            ],
          },
          data: { doctorId: staff.id, doctor: nextName, updatedAt: new Date() },
        }),
        prisma.staffFinancialRecord.updateMany({
          where: { staffId: staff.id },
          data: { staffName: nextName },
        }),
        prisma.staffAttendance.updateMany({
          where: { staffId: staff.id },
          data: { staffName: nextName },
        }),
      ]);
    }

    res.json({
      success: true,
      message: "Staff member updated successfully",
      data: toStaff(updatedStaff),
    });
  } catch (error) {
    console.error("[STAFF UPDATE] Error updating staff member:", error);
    res.status(500).json({
      success: false,
      message: "Error updating staff member",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const deleteStaff = async (
  req: Request<IdParams>,
  res: Response<ApiResponse<null>>
) => {
  try {
    const staff = await prisma.staff.findUnique({ where: { id: req.params.id } });
    if (!staff || staff.deleted) {
      return res.status(404).json({
        success: false,
        message: "Staff member not found",
      });
    }

    await prisma.staff.update({
      where: { id: req.params.id },
      data: { deleted: true, deletedAt: new Date(), updatedAt: new Date() },
    });

    res.json({
      success: true,
      message: "Staff member soft-deleted successfully",
    });
  } catch (error) {
    console.error("[STAFF DELETE] Error deleting staff member:", error);
    res.status(500).json({
      success: false,
      message: "Error deleting staff member",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const createStaffFinancialRecord = async (
  req: Request,
  res: Response<ApiResponse<StaffFinancialRecord>>
) => {
  try {
    const recordData: StaffFinancialRecord = req.body;

    if (!recordData.staffId || !recordData.type || !recordData.amount || !recordData.date) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: staffId, type, amount, date",
      });
    }

    const staffMember = await prisma.staff.findUnique({ where: { id: recordData.staffId } });
    if (!staffMember || staffMember.deleted) {
      return res.status(404).json({
        success: false,
        message: "Staff member not found",
      });
    }

    const actor = getFinanceHistoryActor(req);
    const newRecord = await prisma.$transaction(async (tx) => {
      const createdRecord = await tx.staffFinancialRecord.create({
        data: {
          id: `staff_fin_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
          staffId: staffMember.id,
          staffName: staffMember.name,
          type: recordData.type,
          amount: recordData.amount,
          date: recordData.date,
          status: "pending",
          notes: recordData.notes || "",
          repaymentSchedule: recordData.repaymentSchedule || "",
        },
      });

      if (shouldLogPayrollFinancialRecord(createdRecord)) {
        await createFinanceHistoryLog(tx, {
          entityType: "payroll",
          entityId: createdRecord.staffId,
          context: payrollRecordContext(createdRecord),
          action: "financial_record_create",
          previousState: {},
          newState: createdRecord,
          amount: toFiniteNumber(createdRecord.amount),
          payrollRecordId: createdRecord.id,
          summary: `${createdRecord.staffName} ${createdRecord.type} record created`,
          ...actor,
        });
      }

      return createdRecord;
    });

    createNotification(
      newRecord.staffId,
      "New Financial Record",
      `A new ${newRecord.type} record for PHP ${newRecord.amount.toLocaleString()} has been created.`,
      "payment"
    );

    res.status(201).json({
      success: true,
      message: "Staff financial record added successfully",
      data: toStaffFinancialRecord(newRecord),
    });
  } catch (error) {
    console.error("[STAFF CREATE_FINANCIAL_RECORD] ERROR:", error);
    res.status(500).json({
      success: false,
      message: "Error adding staff financial record",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const getStaffFinancialRecords = async (
  req: Request,
  res: Response<ApiResponse<StaffFinancialRecord[]>>
) => {
  try {
    const staffFinancialRecords = await prisma.staffFinancialRecord.findMany({
      orderBy: { date: "desc" },
    });

    res.json({
      success: true,
      message: "Staff financial records retrieved successfully",
      data: staffFinancialRecords as unknown as StaffFinancialRecord[],
    });
  } catch (error) {
    console.error("[STAFF FINANCIAL_RECORDS] Error fetching staff financial records:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching staff financial records",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const updateStaffFinancialRecord = async (
  req: Request<IdParams>,
  res: Response<ApiResponse<StaffFinancialRecord>>
) => {
  try {
    const { id } = req.params;
    const updates: Partial<StaffFinancialRecord> = req.body;

    const currentRecord = await prisma.staffFinancialRecord.findUnique({ where: { id } });
    if (!currentRecord) {
      return res.status(404).json({
        success: false,
        message: "Staff financial record not found",
      });
    }

    let staffInfoUpdate: Partial<StaffFinancialRecord> = {};
    if (updates.staffId && updates.staffId !== currentRecord.staffId) {
      const staffMember = await prisma.staff.findUnique({ where: { id: updates.staffId } });
      if (!staffMember || staffMember.deleted) {
        return res.status(404).json({
          success: false,
          message: "Staff member not found",
        });
      }
      staffInfoUpdate = { staffId: staffMember.id, staffName: staffMember.name };
    }

    const actor = getFinanceHistoryActor(req);
    const updatedRecord = await prisma.$transaction(async (tx) => {
      const savedRecord = await tx.staffFinancialRecord.update({
        where: { id },
        data: {
          ...updates,
          ...staffInfoUpdate,
          id: undefined,
        } as any,
      });

      if (shouldLogPayrollFinancialRecord(currentRecord) || shouldLogPayrollFinancialRecord(savedRecord)) {
        await createFinanceHistoryLog(tx, {
          entityType: "payroll",
          entityId: savedRecord.staffId,
          context: payrollRecordContext(savedRecord),
          action: "financial_record_update",
          previousState: currentRecord,
          newState: savedRecord,
          amount: toFiniteNumber(savedRecord.amount),
          payrollRecordId: savedRecord.id,
          summary: `${savedRecord.staffName} ${savedRecord.type} record updated`,
          ...actor,
        });
      }

      return savedRecord;
    });

    res.json({
      success: true,
      message: "Staff financial record updated successfully",
      data: toStaffFinancialRecord(updatedRecord),
    });
  } catch (error) {
    console.error("[STAFF UPDATE_FINANCIAL_RECORD] ERROR:", error);
    res.status(500).json({
      success: false,
      message: "Error updating staff financial record",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const approveStaffFinancialRecord = async (
  req: Request<IdParams>,
  res: Response<ApiResponse<StaffFinancialRecord>>
) => {
  try {
    const currentRecord = await prisma.staffFinancialRecord.findUnique({
      where: { id: req.params.id },
    });

    if (!currentRecord) {
      return res.status(404).json({
        success: false,
        message: "Staff financial record not found",
      });
    }

    if (currentRecord.status === "paid") {
      return res.status(400).json({
        success: false,
        message: "Paid records cannot be re-approved",
      });
    }

    const actor = getFinanceHistoryActor(req);
    const updatedRecord = await prisma.$transaction(async (tx) => {
      const savedRecord = await tx.staffFinancialRecord.update({
        where: { id: req.params.id },
        data: { status: "approved" },
      });

      if (shouldLogPayrollFinancialRecord(savedRecord)) {
        await createFinanceHistoryLog(tx, {
          entityType: "payroll",
          entityId: savedRecord.staffId,
          context: payrollRecordContext(savedRecord),
          action: "financial_record_approve",
          previousState: currentRecord,
          newState: savedRecord,
          amount: toFiniteNumber(savedRecord.amount),
          payrollRecordId: savedRecord.id,
          summary: `${savedRecord.staffName} ${savedRecord.type} record approved`,
          ...actor,
        });
      }

      return savedRecord;
    });

    createNotification(
      updatedRecord.staffId,
      "Financial Record Approved",
      `Your ${updatedRecord.type} record for PHP ${updatedRecord.amount.toLocaleString()} has been approved.`,
      "payment"
    );

    res.json({
      success: true,
      message: "Staff financial record approved successfully",
      data: toStaffFinancialRecord(updatedRecord),
    });
  } catch (error) {
    console.error("[STAFF APPROVE_FINANCIAL_RECORD] ERROR:", error);
    res.status(500).json({
      success: false,
      message: "Error approving staff financial record",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const deleteStaffFinancialRecord = async (
  req: Request<IdParams>,
  res: Response<ApiResponse<null>>
) => {
  try {
    const currentRecord = await prisma.staffFinancialRecord.findUnique({
      where: { id: req.params.id },
    });
    if (!currentRecord) {
      return res.status(404).json({
        success: false,
        message: "Staff financial record not found",
      });
    }

    const actor = getFinanceHistoryActor(req);
    await prisma.$transaction(async (tx) => {
      await tx.staffFinancialRecord.delete({ where: { id: req.params.id } });

      if (shouldLogPayrollFinancialRecord(currentRecord)) {
        await createFinanceHistoryLog(tx, {
          entityType: "payroll",
          entityId: currentRecord.staffId,
          context: payrollRecordContext(currentRecord),
          action: "financial_record_delete",
          previousState: currentRecord,
          newState: {},
          amount: toFiniteNumber(currentRecord.amount),
          payrollRecordId: currentRecord.id,
          summary: `${currentRecord.staffName} ${currentRecord.type} record deleted`,
          ...actor,
        });
      }
    });

    res.json({
      success: true,
      message: "Staff financial record deleted successfully",
    });
  } catch (error) {
    console.error("[STAFF DELETE_FINANCIAL_RECORD] ERROR:", error);
    res.status(500).json({
      success: false,
      message: "Error deleting staff financial record",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const getAttendance = (
  req: Request,
  res: Response<ApiResponse<Attendance[]>>
) => {
  const month = typeof req.query.month === "string" ? req.query.month : undefined;
  prisma.staffAttendance.findMany({
    where: month ? { date: month } : undefined,
    orderBy: { staffName: "asc" },
  }).then((attendanceRecords) => {
    res.json({
      success: true,
      message: "Attendance records retrieved successfully",
      data: attendanceRecords as unknown as Attendance[],
    });
  }).catch((error) => {
    console.error("[STAFF ATTENDANCE] Error fetching attendance records:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching attendance records",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  });
};

export const upsertAttendance = async (
  req: Request,
  res: Response<ApiResponse<Attendance>>
) => {
  try {
    const attendanceData: Attendance = req.body;
    const staffId = String(req.params.staffId || attendanceData.staffId || "").trim();
    const date = String(attendanceData.date || currentMonthKey()).trim();

    if (!staffId || !date) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: staffId, date",
      });
    }

    const staffMember = await prisma.staff.findUnique({ where: { id: staffId } });
    if (!staffMember || staffMember.deleted) {
      return res.status(404).json({
        success: false,
        message: "Staff member not found",
      });
    }

    const existingAttendance = await prisma.staffAttendance.findFirst({
      where: { staffId, date },
    });

    const attendancePayload = {
      staffId,
      staffName: attendanceData.staffName || staffMember.name,
      date,
      status: attendanceData.status || "tracked",
      hoursWorked: toFiniteNumber(attendanceData.hoursWorked),
      daysPresent: Math.max(0, Math.trunc(toFiniteNumber(attendanceData.daysPresent))),
      daysAbsent: Math.max(0, Math.trunc(toFiniteNumber(attendanceData.daysAbsent))),
      overtimeHours: toFiniteNumber(attendanceData.overtimeHours),
    };

    const savedAttendance = existingAttendance
      ? await prisma.staffAttendance.update({
          where: { id: existingAttendance.id },
          data: attendancePayload,
        })
      : await prisma.staffAttendance.create({
          data: {
            id: `att_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
            ...attendancePayload,
          },
        });

    res.status(existingAttendance ? 200 : 201).json({
      success: true,
      message: existingAttendance ? "Attendance updated successfully" : "Attendance created successfully",
      data: toAttendance(savedAttendance),
    });
  } catch (error) {
    console.error("[STAFF UPSERT_ATTENDANCE] ERROR:", error);
    res.status(500).json({
      success: false,
      message: "Error saving attendance",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
