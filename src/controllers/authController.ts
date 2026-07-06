import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import fs from "fs";
import path from "path";
import { prisma } from "../lib/prisma";

const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "password";
let ADMIN_PASSWORD_HASH: string;

const TEST_DOCTOR_USERNAME = "doctor";
const TEST_DOCTOR_PASSWORD = "password";
const TEST_DOCTOR_STAFF_ID = "seed_staff_test_doctor";
let TEST_DOCTOR_PASSWORD_HASH: string;

const DEFAULT_STAFF_PASSWORD = "password";
const DEFAULT_DOCTOR_PASSWORD = DEFAULT_STAFF_PASSWORD;
let DOCTOR_PASSWORD_HASH: string;

const DEFAULT_RECEPTIONIST_PASSWORD = DEFAULT_STAFF_PASSWORD;
let RECEPTIONIST_PASSWORD_HASH: string;

const DEFAULT_PATIENT_PASSWORD = "villahermosa123";
let PATIENT_PASSWORD_HASH: string;

const JWT_SECRET = process.env.JWT_SECRET || "your-super-secret-jwt-key-change-this-in-production";
const JWT_EXPIRY = "24h";
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const AUTH_COOKIE_SAME_SITE = IS_PRODUCTION ? "none" : "strict";
const DATA_DIR = path.resolve(process.cwd(), "data");
const AUTH_SETTINGS_FILE = path.join(DATA_DIR, "auth-settings.json");

const readAuthSettings = (): Record<string, string> => {
  try {
    if (!fs.existsSync(AUTH_SETTINGS_FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(AUTH_SETTINGS_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed as Record<string, string> : {};
  } catch (error) {
    console.warn("[AUTH] Failed to read auth settings:", error);
    return {};
  }
};

const writeAuthSettings = async (settings: Record<string, string>) => {
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
  await fs.promises.writeFile(AUTH_SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf8");
};

export const initializeAuth = async () => {
  try {
    const authSettings = readAuthSettings();
    ADMIN_PASSWORD_HASH = authSettings.adminPasswordHash || (await bcrypt.hash(ADMIN_PASSWORD, 10));
    TEST_DOCTOR_PASSWORD_HASH = await bcrypt.hash(TEST_DOCTOR_PASSWORD, 10);
    DOCTOR_PASSWORD_HASH = await bcrypt.hash(DEFAULT_DOCTOR_PASSWORD, 10);
    RECEPTIONIST_PASSWORD_HASH = await bcrypt.hash(DEFAULT_RECEPTIONIST_PASSWORD, 10);
    PATIENT_PASSWORD_HASH = await bcrypt.hash(DEFAULT_PATIENT_PASSWORD, 10);
    console.log("[AUTH] Password hashes initialized");
  } catch (error) {
    console.error("[AUTH] Failed to initialize password hash:", error);
    throw error;
  }
};

export const register = async (
  req: express.Request,
  res: express.Response
): Promise<void> => {
  try {
    const { name, email, phone, password } = req.body;

    if (!(email || phone)) {
      res.status(400).json({
        success: false,
        message: "Email or phone is required",
      });
      return;
    }

    const existingPatient = await prisma.patient.findFirst({
      where: {
        deleted: false,
        OR: [
          ...(email ? [{ email }] : []),
          ...(phone ? [{ phone }] : []),
        ],
      },
    });

    if (existingPatient) {
      res.status(409).json({
        success: false,
        message: "A patient with this email or phone number already exists",
      });
      return;
    }

    const passwordHash = password ? await bcrypt.hash(password, 10) : PATIENT_PASSWORD_HASH;
    const newPatientId = `PATIENT-${Date.now()}`;
    const newPatient = await prisma.patient.create({
      data: {
        id: newPatientId,
        name: name || email || phone,
        email: email || "",
        phone: phone || "",
        password: passwordHash,
        parentId: null,
        isPrimary: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        deleted: false,
      },
    });

    res.status(201).json({
      success: true,
      message: "Patient registered successfully",
      patient: {
        id: newPatient.id,
        name: newPatient.name,
        email: newPatient.email,
        phone: newPatient.phone,
      },
    });
  } catch (error) {
    console.error("[AUTH] Registration error:", error);
    res.status(500).json({
      success: false,
      message: "An error occurred during registration",
    });
  }
};

const setAuthCookie = (res: express.Response, token: string) => {
  res.cookie("authToken", token, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: AUTH_COOKIE_SAME_SITE,
    maxAge: 24 * 60 * 60 * 1000,
    path: "/",
  });
};

const signToken = (payload: Record<string, unknown>) =>
  jwt.sign(
    {
      ...payload,
      iat: Math.floor(Date.now() / 1000),
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );

const getStaffPortalRole = (staffRole?: string | null) => {
  const role = String(staffRole || "").toLowerCase();
  if (role === "doctor" || role.includes("dentist")) return "doctor";
  return "receptionist";
};

const isStaffRole = (role?: string | null) => {
  const normalizedRole = String(role || "").toLowerCase();
  return normalizedRole === "doctor" || normalizedRole === "receptionist";
};

const isUsingDefaultStaffPassword = async (passwordHash?: string | null) => {
  if (!passwordHash) return true;
  return bcrypt.compare(DEFAULT_STAFF_PASSWORD, passwordHash);
};

const getStaffUserPayload = async (staff: { id: string; name: string; password?: string | null }, portalRole: string) => ({
  username: staff.name,
  name: staff.name,
  role: portalRole,
  staffId: staff.id,
  mustChangePassword: await isUsingDefaultStaffPassword(staff.password),
});

export const login = async (
  req: express.Request,
  res: express.Response
): Promise<void> => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      res.status(400).json({
        success: false,
        message: "Username and password are required",
      });
      return;
    }

    if (username === ADMIN_USERNAME) {
      const isPasswordValid = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
      if (!isPasswordValid) {
        res.status(401).json({ success: false, message: "Invalid credentials" });
        return;
      }

      const token = signToken({
        username: ADMIN_USERNAME,
        name: "Admin",
        role: "admin",
      });

      setAuthCookie(res, token);
      res.status(200).json({
        success: true,
        message: "Login successful",
        token,
        user: { username: ADMIN_USERNAME, role: "admin" },
      });
      return;
    }

    if (username.toLowerCase() === TEST_DOCTOR_USERNAME) {
      const doctor = await prisma.staff.findFirst({
        where: { id: TEST_DOCTOR_STAFF_ID, deleted: false },
      });

      if (!doctor) {
        res.status(404).json({
          success: false,
          message: "Test doctor staff record not found",
        });
        return;
      }

      const isPasswordValid = await bcrypt.compare(
        password,
        doctor.password || TEST_DOCTOR_PASSWORD_HASH
      );
      if (!isPasswordValid) {
        res.status(401).json({ success: false, message: "Invalid credentials" });
        return;
      }

      const userPayload = await getStaffUserPayload(doctor, "doctor");
      const token = signToken(userPayload);

      setAuthCookie(res, token);
      res.status(200).json({
        success: true,
        message: "Login successful",
        token,
        user: userPayload,
      });
      return;
    }

    const staffMembers = await prisma.staff.findMany({ where: { deleted: false } });
    const usernameLower = String(username).toLowerCase();
    const matchingStaff = staffMembers.find((staff) => {
      const nameMatch = staff.name.toLowerCase() === usernameLower;
      const emailMatch = staff.email?.toLowerCase() === usernameLower;
      const portalRole = getStaffPortalRole(staff.role);
      return (nameMatch || emailMatch) && Boolean(portalRole);
    });

    if (matchingStaff) {
      const portalRole = getStaffPortalRole(matchingStaff.role);
      const fallbackPasswordHash =
        portalRole === "receptionist" ? RECEPTIONIST_PASSWORD_HASH : DOCTOR_PASSWORD_HASH;
      const isPasswordValid = matchingStaff.password
        ? await bcrypt.compare(password, matchingStaff.password)
        : await bcrypt.compare(password, fallbackPasswordHash);

      if (!isPasswordValid) {
        res.status(401).json({ success: false, message: "Invalid credentials" });
        return;
      }

      const userPayload = await getStaffUserPayload(matchingStaff, portalRole);
      const token = signToken(userPayload);

      setAuthCookie(res, token);
      res.status(200).json({
        success: true,
        message: "Login successful",
        token,
        user: userPayload,
      });
      return;
    }

    const patients = await prisma.patient.findMany({ where: { deleted: false } });
    const patient = patients.find(
      (candidate) =>
        candidate.email?.toLowerCase() === usernameLower || candidate.phone === username
    );

    if (patient) {
      let isPasswordValid = false;

      if (!patient.password) {
        isPasswordValid = await bcrypt.compare(password, PATIENT_PASSWORD_HASH);
        if (isPasswordValid) {
          await prisma.patient.update({
            where: { id: patient.id },
            data: { password: PATIENT_PASSWORD_HASH, updatedAt: new Date() },
          });
        }
      } else {
        isPasswordValid = await bcrypt.compare(password, patient.password);
      }

      if (!isPasswordValid) {
        res.status(401).json({ success: false, message: "Invalid credentials" });
        return;
      }

      const token = signToken({
        id: patient.id,
        username: patient.email,
        name: patient.name,
        email: patient.email,
        role: "patient",
        patientId: patient.id,
      });

      setAuthCookie(res, token);
      res.status(200).json({
        success: true,
        message: "Login successful",
        token,
        user: {
          username: patient.name,
          role: "patient",
          patientId: patient.id,
        },
      });
      return;
    }

    res.status(401).json({ success: false, message: "Invalid credentials" });
  } catch (error) {
    console.error("[AUTH] Login error:", error);
    res.status(500).json({
      success: false,
      message: "An error occurred during login",
    });
  }
};

export const logout = (
  req: express.Request,
  res: express.Response
): void => {
  try {
    res.clearCookie("authToken", {
      httpOnly: true,
      secure: IS_PRODUCTION,
      sameSite: AUTH_COOKIE_SAME_SITE,
      path: "/",
    });

    res.status(200).json({
      success: true,
      message: "Logout successful",
    });
  } catch (error) {
    console.error("[AUTH] Logout error:", error);
    res.status(500).json({
      success: false,
      message: "An error occurred during logout",
    });
  }
};

export const verifyToken = async (
  req: express.Request,
  res: express.Response
): Promise<void> => {
  try {
    const token = req.cookies.authToken || req.headers.authorization?.split(" ")[1];

    if (!token) {
      res.status(401).json({
        success: false,
        message: "No token provided",
      });
      return;
    }

    const decoded = jwt.verify(token, JWT_SECRET) as any;
    let user = decoded;

    if (isStaffRole(decoded?.role) && decoded?.staffId) {
      const staff = await prisma.staff.findFirst({
        where: { id: String(decoded.staffId), deleted: false },
      });

      if (staff) {
        user = {
          ...decoded,
          username: staff.name,
          name: staff.name,
          staffId: staff.id,
          mustChangePassword: await isUsingDefaultStaffPassword(staff.password),
        };
      }
    }

    res.status(200).json({
      success: true,
      message: "Token is valid",
      user,
    });
  } catch (error) {
    console.error("[AUTH] Token verification error:", error);
    res.status(401).json({
      success: false,
      message: "Invalid or expired token",
    });
  }
};

export const changePassword = async (
  req: express.Request,
  res: express.Response
): Promise<void> => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const user = (req as any).user || {};
    const role = String(user.role || "").toLowerCase();

    if (!currentPassword || !newPassword) {
      res.status(400).json({
        success: false,
        message: "Current password and new password are required",
      });
      return;
    }

    if (String(newPassword).length < 6) {
      res.status(400).json({
        success: false,
        message: "New password must be at least 6 characters",
      });
      return;
    }

    if (role === "admin") {
      const isCurrentPasswordValid = await bcrypt.compare(currentPassword, ADMIN_PASSWORD_HASH);
      if (!isCurrentPasswordValid) {
        res.status(401).json({ success: false, message: "Current password is incorrect" });
        return;
      }

      const nextHash = await bcrypt.hash(newPassword, 10);
      ADMIN_PASSWORD_HASH = nextHash;
      await writeAuthSettings({
        ...readAuthSettings(),
        adminPasswordHash: nextHash,
      });

      res.status(200).json({ success: true, message: "Password changed successfully" });
      return;
    }

    if (role === "receptionist" || role === "doctor") {
      const staffId = String(user.staffId || "");
      if (!staffId) {
        res.status(400).json({ success: false, message: "Staff account is missing" });
        return;
      }

      const staff = await prisma.staff.findFirst({ where: { id: staffId, deleted: false } });
      if (!staff) {
        res.status(404).json({ success: false, message: "Staff account not found" });
        return;
      }

      if (newPassword === DEFAULT_STAFF_PASSWORD) {
        res.status(400).json({ success: false, message: "Please choose a new password different from the default password" });
        return;
      }

      const passwordHash = staff.password || (role === "doctor" ? DOCTOR_PASSWORD_HASH : RECEPTIONIST_PASSWORD_HASH);
      const isCurrentPasswordValid = await bcrypt.compare(currentPassword, passwordHash);
      if (!isCurrentPasswordValid) {
        res.status(401).json({ success: false, message: "Current password is incorrect" });
        return;
      }

      const updatedStaff = await prisma.staff.update({
        where: { id: staffId },
        data: {
          password: await bcrypt.hash(newPassword, 10),
          updatedAt: new Date(),
        },
      });

      const userPayload = await getStaffUserPayload(updatedStaff, role);
      const token = signToken(userPayload);
      setAuthCookie(res, token);

      res.status(200).json({
        success: true,
        message: "Password changed successfully",
        token,
        user: userPayload,
      });
      return;
    }

    res.status(403).json({ success: false, message: "Password changes are only available for internal staff accounts" });
  } catch (error) {
    console.error("[AUTH] Change password error:", error);
    res.status(500).json({
      success: false,
      message: "An error occurred while changing password",
    });
  }
};

export const hashPassword = async (password: string): Promise<string> => {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
};
