import express from "express";
import { changePassword, login, logout, verifyToken, register } from "../controllers/authController";
import { requireAuth, requireRole } from "../middleware/authMiddleware";

const router = express.Router();

// Authentication routes
router.post("/login", login);
router.post("/logout", logout);
router.get("/verify", verifyToken);
router.post("/register", register);
router.post("/change-password", requireAuth, requireRole(["admin", "doctor", "receptionist"]), changePassword);

export default router;
