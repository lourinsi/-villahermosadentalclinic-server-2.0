export interface Appointment {
  id?: string;
  patientId: string;
  patientName: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  type: number; // Index referring to APPOINTMENT_TYPES array
  customType?: string; // Used when type is 'Other'
  price?: number;
  discount?: number; // numeric amount discounted from price
  doctor: string;
  doctorId?: string;
  doctorName?: string;
  doctorProfile?: string | null;
  doctorProfilePicture?: string | null;
  duration?: number; // in minutes
  notes?: string;
  treatmentNotes?: string;
  toothNumbers?: string;
  serviceType?: string;
  // Status is flexible to accept any value from the JSON configuration
  status?: string;
  cancellationReason?: string; // Reason why appointment was cancelled (e.g., "Another appointment was scheduled for this time slot")
  paymentStatus?: "paid" | "unpaid" | "overdue" | "half-paid" | "over-paid";
  paymentMethod?: string; // Payment method (e.g., 'cash', 'card', 'check')
  paymentDate?: string; // Date the payment was actually made (YYYY-MM-DD)
  balance?: number;
  totalPaid?: number;
  patientFirstName?: string | null;
  patientLastName?: string | null;
  patientEmail?: string | null;
  patientPhone?: string | null;
  patientProfile?: string | null;
  patientProfilePicture?: string | null;
  patientDateOfBirth?: string | null;
  patientDob?: string | null;
  patientBirthDate?: string | null;
  patientBirthday?: string | null;
  profilePicture?: string | null;
  patient?: {
    id?: string;
    name?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
    phone?: string | null;
    profilePicture?: string | null;
    profilePictureUrl?: string | null;
    dateOfBirth?: string | null;
    dob?: string | null;
  };
  // Deprecated: transactions are now stored in payments collection. Keep for backward compat only.
  transactions?: {
    id: string;
    amount: number;
    method?: string;
    date?: string;
    transactionId?: string;
    notes?: string;
    status?: string;
  }[];
  createdAt?: Date;
  updatedAt?: Date;
  deleted?: boolean;
  deletedAt?: Date | null;
}

export interface ApiResponse<T> {
  success: boolean;
  message: string;
  meta?: any;
  data?: T;
  error?: string;
}
