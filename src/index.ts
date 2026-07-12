import express, { Express } from "express";
import cors from "cors";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

const app: Express = express();
const PORT = process.env.PORT || 3001;
const APPOINTMENT_LIFECYCLE_SYNC_INTERVAL_MS = 60 * 1000;

const configuredOrigins = [
  process.env.FRONTEND_URL,
  ...(process.env.FRONTEND_URLS || "").split(","),
]
  .map((origin) => origin?.trim().replace(/\/+$/, ""))
  .filter((origin): origin is string => Boolean(origin));

const allowedOrigins = new Set([
  "http://localhost:3000",
  "https://villahermosadentalclinic.vercel.app",
  "https://villahermosadentalclinic-client-2-0.vercel.app",
  ...configuredOrigins,
]);

const vercelDeploymentOrigin =
  /^https:\/\/villahermosadentalclinic(?:-[a-z0-9-]+)?-lourinsis-projects\.vercel\.app$/;

const corsOptions: cors.CorsOptions = {
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin) || vercelDeploymentOrigin.test(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error(`CORS blocked origin: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 200,
};

// Middleware
app.use(cors(corsOptions));

// Explicitly handle preflight requests
app.options(/.*/, cors(corsOptions));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Manual cookie parser (Express doesn't parse cookies by default)
app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
  const cookies: { [key: string]: string } = {};
  if (req.headers.cookie) {
    req.headers.cookie.split(';').forEach((cookie) => {
      const [name, value] = cookie.trim().split('=');
      if (name && value) {
        cookies[name] = decodeURIComponent(value);
      }
    });
  }
  (req as any).cookies = cookies;
  next();
});

// Request logging middleware
app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.log(`[REQUEST] ${req.method} ${req.path}`);
  next();
});

import patientRoutes from "./routes/patientRoutes";
import appointmentRoutes from "./routes/appointmentRoutes";
import appointmentTypesRoutes from "./routes/appointmentTypes";
import financeRoutes from "./routes/financeRoutes";
import paymentRoutes from "./routes/paymentRoutes";
import paymentMethodRoutes from "./routes/paymentMethodRoutes";
import staffRoutes from "./routes/staffRoutes";
import inventoryRoutes from "./routes/inventoryRoutes";
import authRoutes from "./routes/authRoutes";
import messageRoutes from "./routes/messageRoutes";
import notificationRoutes from "./routes/notificationRoutes";
import statusesRoutes from "./routes/statuses";
import { initializeAuth } from "./controllers/authController";
import questionnaireRoutes from './routes/questionnaires';
import questionnaireQuestionRoutes from "./routes/questionnaireQuestions";
import { syncPastAppointmentsToTbd } from "./utils/appointmentStatusLifecycle";

// Routes
console.log('[ROUTES] Registering API routes...');
app.use("/api/auth", authRoutes);
app.use("/api/patients", patientRoutes);
app.use("/api/questionnaires", questionnaireRoutes);
app.use("/api/questionnaire-questions", questionnaireQuestionRoutes);
app.use("/api/appointments", appointmentRoutes);
app.use("/api/appointment-types", appointmentTypesRoutes);
app.use("/api/finance", financeRoutes);
app.use("/api/staff", staffRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/payment-methods", paymentMethodRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/statuses", statusesRoutes);
console.log('[ROUTES] All routes registered successfully');

// app.get("/users", (req,res)=>{
//   res.send("Hello World")
// })

// Lightweight, unauthenticated readiness endpoint. Keep the API-prefixed path
// as a compatibility alias for existing deployment checks and clients.
const healthCheck = (_req: express.Request, res: express.Response): void => {
  res.setHeader("Cache-Control", "no-store");
  res.status(204).end();
};

app.get("/health", healthCheck);
app.get("/api/health", healthCheck);

// 404 handler
app.use((req: express.Request, res: express.Response) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

// Start server
(async () => {
  try {
    // Initialize authentication (hash password)
    await initializeAuth();
    await syncPastAppointmentsToTbd();
    setInterval(() => {
      syncPastAppointmentsToTbd().catch((error) => {
        console.error("[APPOINTMENT LIFECYCLE] Sync failed:", error);
      });
    }, APPOINTMENT_LIFECYCLE_SYNC_INTERVAL_MS);

    app.listen(PORT, () => {
      console.log(`Server is running on http://localhost:${PORT}`);
      console.log(`Allowed frontend origins: ${Array.from(allowedOrigins).join(", ")}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
})();
