import fs from "fs";
import path from "path";

export type QuestionnaireQuestion = {
  id: string;
  text: string;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
};

const DATA_DIR = path.resolve(process.cwd(), "data");
const QUESTIONS_FILE = path.join(DATA_DIR, "questionnaire-questions.json");
const BASELINE_QUESTION_TIMESTAMP = "2026-07-02T00:00:00.000Z";

const BASELINE_QUESTIONNAIRE_QUESTION_TEXTS = [
  ["baseline_physician_information", "Physician information: Name of Physician, specialty if applicable, office address, and office number."],
  ["baseline_good_health", "Are you in good health?"],
  ["baseline_under_medical_treatment", "Are you under medical treatment now? If so, what is the condition being treated?"],
  ["baseline_serious_illness_or_operation", "Have you ever had serious illness or surgical operation? If so, what illness or operation?"],
  ["baseline_hospitalized", "Have you ever been hospitalized? If so, when and why?"],
  ["baseline_medication", "Are you taking any prescription/non-prescription medication? If so, please specify."],
  ["baseline_tobacco", "Do you use tobacco products?"],
  ["baseline_alcohol_or_drugs", "Do you use alcohol, cocaine or other dangerous drugs?"],
  ["baseline_allergy_local_anesthetic", "Are you allergic to Local Anesthetic (ex. Lidocaine)?"],
  ["baseline_allergy_penicillin_antibiotics", "Are you allergic to Penicillin / Antibiotics?"],
  ["baseline_allergy_sulfa", "Are you allergic to Sulfa drugs?"],
  ["baseline_allergy_aspirin", "Are you allergic to Aspirin?"],
  ["baseline_allergy_latex", "Are you allergic to Latex?"],
  ["baseline_allergy_others", "Do you have any other allergies?"],
  ["baseline_bleeding_time", "Bleeding Time"],
  ["baseline_pregnant", "For women only: Are you pregnant?"],
  ["baseline_nursing", "For women only: Are you nursing?"],
  ["baseline_birth_control", "For women only: Are you taking birth control pills?"],
  ["baseline_blood_type", "Blood Type"],
  ["baseline_blood_pressure", "Blood Pressure"],
  ["baseline_condition_high_blood_pressure", "Have you had High Blood Pressure?"],
  ["baseline_condition_low_blood_pressure", "Have you had Low Blood Pressure?"],
  ["baseline_condition_epilepsy_convulsions", "Have you had Epilepsy / Convulsions?"],
  ["baseline_condition_aids_hiv", "Have you had AIDS or HIV Infection?"],
  ["baseline_condition_sexually_transmitted_disease", "Have you had a Sexually Transmitted disease?"],
  ["baseline_condition_stomach_troubles_ulcers", "Have you had Stomach Troubles / Ulcers?"],
  ["baseline_condition_fainting_seizure", "Have you had Fainting Seizure?"],
  ["baseline_condition_rapid_weight_loss", "Have you had Rapid Weight Loss?"],
  ["baseline_condition_radiation_therapy", "Have you had Radiation Therapy?"],
  ["baseline_condition_joint_replacement_implant", "Have you had Joint Replacement / Implant?"],
  ["baseline_condition_heart_surgery", "Have you had Heart Surgery?"],
  ["baseline_condition_heart_attack", "Have you had a Heart Attack?"],
  ["baseline_condition_thyroid_problem", "Have you had a Thyroid Problem?"],
  ["baseline_condition_heart_disease", "Have you had Heart Disease?"],
  ["baseline_condition_heart_murmur", "Have you had a Heart Murmur?"],
  ["baseline_condition_hepatitis_liver_disease", "Have you had Hepatitis / Liver Disease?"],
  ["baseline_condition_rheumatic_fever", "Have you had Rheumatic Fever?"],
  ["baseline_condition_hay_fever_allergies", "Have you had Hay Fever / Allergies?"],
  ["baseline_condition_respiratory_problems", "Have you had Respiratory Problems?"],
  ["baseline_condition_hepatitis_jaundice", "Have you had Hepatitis / Jaundice?"],
  ["baseline_condition_tuberculosis", "Have you had Tuberculosis?"],
  ["baseline_condition_swollen_ankles", "Have you had Swollen ankles?"],
  ["baseline_condition_kidney_disease", "Have you had Kidney disease?"],
  ["baseline_condition_diabetes", "Have you had Diabetes?"],
  ["baseline_condition_chest_pain", "Have you had Chest pain?"],
  ["baseline_condition_stroke", "Have you had a Stroke?"],
  ["baseline_condition_cancer_tumors", "Have you had Cancer / Tumors?"],
  ["baseline_condition_anemia", "Have you had Anemia?"],
  ["baseline_condition_angina", "Have you had Angina?"],
  ["baseline_condition_asthma", "Have you had Asthma?"],
  ["baseline_condition_emphysema", "Have you had Emphysema?"],
  ["baseline_condition_bleeding_problems", "Have you had Bleeding Problems?"],
  ["baseline_condition_blood_diseases", "Have you had Blood Diseases?"],
  ["baseline_condition_head_injuries", "Have you had Head Injuries?"],
  ["baseline_condition_arthritis_rheumatism", "Have you had Arthritis / Rheumatism?"],
  ["baseline_condition_other", "Have you had any other medical condition?"],
] as const;

const normalizeText = (value: unknown) =>
  String(value || "").trim().replace(/\s+/g, " ");

const createBaselineQuestions = (): QuestionnaireQuestion[] =>
  BASELINE_QUESTIONNAIRE_QUESTION_TEXTS.map(([id, text]) => ({
    id,
    text,
    isActive: true,
    createdAt: BASELINE_QUESTION_TIMESTAMP,
    updatedAt: BASELINE_QUESTION_TIMESTAMP,
  }));

const normalizeQuestion = (question: Partial<QuestionnaireQuestion>, fallbackId: string): QuestionnaireQuestion => {
  const text = normalizeText(question.text);

  return {
    id: normalizeText(question.id) || fallbackId,
    text,
    isActive: question.isActive !== false,
    createdAt: question.createdAt,
    updatedAt: question.updatedAt,
  };
};

const readQuestionsFromDisk = (): QuestionnaireQuestion[] => {
  try {
    if (!fs.existsSync(QUESTIONS_FILE)) return createBaselineQuestions();
    const parsed = JSON.parse(fs.readFileSync(QUESTIONS_FILE, "utf8"));
    if (!Array.isArray(parsed)) return createBaselineQuestions();

    const seen = new Set<string>();
    const questions = parsed
      .map((question, index) => normalizeQuestion(question, `question_${index}`))
      .filter((question) => {
        if (!question.id || !question.text || seen.has(question.id)) return false;
        seen.add(question.id);
        return true;
      });

    return questions.length > 0 ? questions : createBaselineQuestions();
  } catch (error) {
    console.warn("[QUESTIONNAIRE QUESTIONS] Failed to read questions:", error);
    return createBaselineQuestions();
  }
};

let questionCache = readQuestionsFromDisk();
let questionCacheMtimeMs = (() => {
  try {
    return fs.statSync(QUESTIONS_FILE).mtimeMs;
  } catch {
    return null;
  }
})();

const getQuestionsFileMtimeMs = () => {
  try {
    return fs.statSync(QUESTIONS_FILE).mtimeMs;
  } catch {
    return null;
  }
};

const refreshQuestionsFromDiskIfChanged = () => {
  const currentMtimeMs = getQuestionsFileMtimeMs();
  if (currentMtimeMs === questionCacheMtimeMs) return;

  questionCache = readQuestionsFromDisk();
  questionCacheMtimeMs = currentMtimeMs;
};

const persistQuestions = async () => {
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
  await fs.promises.writeFile(QUESTIONS_FILE, JSON.stringify(questionCache, null, 2), "utf8");
  questionCacheMtimeMs = getQuestionsFileMtimeMs();
};

const createQuestionId = () => `question_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

export const getQuestionnaireQuestions = (includeInactive = false) => {
  refreshQuestionsFromDiskIfChanged();
  return questionCache
    .filter((question) => includeInactive || question.isActive)
    .map((question) => ({ ...question }));
};

export const createQuestionnaireQuestion = async (input: Partial<QuestionnaireQuestion>) => {
  refreshQuestionsFromDiskIfChanged();

  const text = normalizeText(input.text);
  if (!text) throw new Error("Question text is required");

  const duplicate = questionCache.find((question) => question.text.toLowerCase() === text.toLowerCase());
  if (duplicate) throw new Error("A question with this text already exists");

  const now = new Date().toISOString();
  const question = normalizeQuestion(
    {
      ...input,
      id: createQuestionId(),
      text,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    },
    createQuestionId()
  );

  questionCache = [...questionCache, question];
  await persistQuestions();
  return { ...question };
};

export const seedBaselineQuestionnaireQuestions = async () => {
  refreshQuestionsFromDiskIfChanged();

  const existingTexts = new Set(questionCache.map((question) => normalizeText(question.text).toLowerCase()));
  const missingQuestions = createBaselineQuestions().filter(
    (question) => !existingTexts.has(normalizeText(question.text).toLowerCase())
  );

  if (missingQuestions.length > 0) {
    questionCache = [...missingQuestions, ...questionCache];
    await persistQuestions();
  }

  return {
    added: missingQuestions.map((question) => ({ ...question })),
    questions: getQuestionnaireQuestions(true),
  };
};

export const updateQuestionnaireQuestion = async (
  id: string,
  input: Partial<QuestionnaireQuestion>
) => {
  refreshQuestionsFromDiskIfChanged();

  const index = questionCache.findIndex((question) => question.id === id);
  if (index < 0) throw new Error("Question not found");

  const text = normalizeText(input.text || questionCache[index].text);
  if (!text) throw new Error("Question text is required");

  const duplicate = questionCache.find(
    (question) => question.id !== id && question.text.toLowerCase() === text.toLowerCase()
  );
  if (duplicate) throw new Error("A question with this text already exists");

  const updated = normalizeQuestion(
    {
      ...questionCache[index],
      ...input,
      id,
      text,
      updatedAt: new Date().toISOString(),
    },
    id
  );

  questionCache = [
    ...questionCache.slice(0, index),
    updated,
    ...questionCache.slice(index + 1),
  ];
  await persistQuestions();
  return { ...updated };
};

export const deleteQuestionnaireQuestion = async (id: string) => {
  refreshQuestionsFromDiskIfChanged();

  const index = questionCache.findIndex((question) => question.id === id);
  if (index < 0) throw new Error("Question not found");

  const [deleted] = questionCache.splice(index, 1);
  await persistQuestions();
  return { ...deleted };
};
