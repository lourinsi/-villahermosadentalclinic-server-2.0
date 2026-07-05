import { Router } from "express";
import {
  createFinanceRecord,
  getAllFinanceRecords,
  getFinanceRecordById,
  updateFinanceRecord,
  deleteFinanceRecord,
  getRevenue,
  getExpenseBreakdown,
  getDetailedExpenses,
  createDetailedExpense,
  updateDetailedExpense,
  deleteDetailedExpense,
  payDetailedExpense,
  getFinanceHistoryLogs,
  getRecurringExpenses,
  getPayroll,
  processPayroll,
  addPayrollBonus,
  configurePayrollEntry,
  payPayrollEntry,
  unpayPayrollEntry,
  getRecentTransactions,
} from "../controllers/financeController";
import { requireAuth } from "../middleware/authMiddleware";

const router = Router();

// Apply requireAuth to all finance routes
router.use(requireAuth);

// POST - Add new finance record
router.post("/", createFinanceRecord);

// GET - Get all finance records
router.get("/", getAllFinanceRecords);

// GET - Get revenue data - MORE SPECIFIC ROUTE FIRST
router.get("/revenue", getRevenue);

// GET - Get expense breakdown - MORE SPECIFIC ROUTE FIRST
router.get("/expense-breakdown", getExpenseBreakdown);

// GET - Get finance history logs
router.get("/history/:entityType", getFinanceHistoryLogs);
router.get("/history/:entityType/:entityId", getFinanceHistoryLogs);

// GET - Get detailed expenses - MORE SPECIFIC ROUTE FIRST
router.get("/detailed-expenses", getDetailedExpenses);

// POST - Add new detailed expense
router.post("/detailed-expenses", createDetailedExpense);

// PUT - Update detailed expense
router.put("/detailed-expenses/:id", updateDetailedExpense);

// PATCH - Update detailed expense
router.patch("/detailed-expenses/:id", updateDetailedExpense);

// POST - Mark a detailed expense paid
router.post("/detailed-expenses/:id/pay", payDetailedExpense);

// DELETE - Soft delete detailed expense and reverse linked stock if needed
router.delete("/detailed-expenses/:id", deleteDetailedExpense);

// GET - Get recurring expenses - MORE SPECIFIC ROUTE FIRST
router.get("/recurring-expenses", getRecurringExpenses);

// POST - Create missing monthly payroll records
router.post("/payroll/process", processPayroll);

// POST - Add a staff bonus for the selected payroll month
router.post("/payroll/:id/bonus", addPayrollBonus);

// PUT - Configure a staff member's payroll salary and monthly adjustment
router.put("/payroll/:id/configure", configurePayrollEntry);

// POST - Mark a staff member's payroll entry paid
router.post("/payroll/:id/pay", payPayrollEntry);

// POST - Reverse a staff member's payroll payment back to pending
router.post("/payroll/:id/unpay", unpayPayrollEntry);

// GET - Get payroll data - MORE SPECIFIC ROUTE FIRST
router.get("/payroll", getPayroll);

// GET - Get recent transactions - MORE SPECIFIC ROUTE FIRST
router.get("/recent-transactions", getRecentTransactions);

// GET - Get finance record by ID - GENERAL ROUTE LAST
router.get("/:id", getFinanceRecordById);

// PUT - Update finance record
router.put("/:id", updateFinanceRecord);

// DELETE - Soft delete finance record
router.delete("/:id", deleteFinanceRecord);


export default router;
