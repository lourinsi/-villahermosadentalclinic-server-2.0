import express from "express";
import { createPayment, getPaymentById, getPaymentsByAppointment, getPaymentsByPatient, updatePayment, deletePayment, restorePayment } from "../controllers/paymentController";
import { requireAuth } from "../middleware/authMiddleware";

const router = express.Router();

// Debug middleware for payment routes
router.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.log(`[PAYMENT ROUTE] ${req.method} ${req.path}`);
  next();
});

// Payments for an appointment - must come before /:id routes
router.get("/appointment/:id", requireAuth, getPaymentsByAppointment);

// Payments for a patient - must come before /:id routes
router.get("/patient/:id", requireAuth, getPaymentsByPatient);

// Create payment (generic)
router.post("/", requireAuth, createPayment);

// Restore soft-deleted payment
router.post("/:id/restore", requireAuth, restorePayment);

// Fetch a single payment
router.get("/:id", requireAuth, getPaymentById);

// Update payment
router.put("/:id", requireAuth, updatePayment);

// Delete payment
router.delete("/:id", requireAuth, deletePayment);

export default router;
