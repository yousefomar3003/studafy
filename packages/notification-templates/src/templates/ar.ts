import { NOTIFICATION_TYPES } from "@studafy/constants";

import { NOTIFICATION_CHANNELS } from "../types";

import type { LocaleTemplateSet } from "./types";

export const AR_TEMPLATES = {
  [NOTIFICATION_TYPES.ASSIGNMENT_DUE_SOON]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "موعد تسليم {assignmentName} هو {dueDate}",
    [NOTIFICATION_CHANNELS.PUSH]: "{courseName} — {assignmentName} مستحق في {dueDate}",
    [NOTIFICATION_CHANNELS.EMAIL]:
      "الواجب {assignmentName} في مادة {courseName} مستحق في {dueDate}. يرجى التسليم قبل الموعد النهائي.",
  },
  [NOTIFICATION_TYPES.GRADE_POSTED]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "تم نشر درجة {assignmentName}: {grade}",
    [NOTIFICATION_CHANNELS.PUSH]: "الدرجة: {grade} في {assignmentName}",
    [NOTIFICATION_CHANNELS.EMAIL]: "تم نشر درجتك في {assignmentName} لمادة {courseName}: {grade}.",
  },
  [NOTIFICATION_TYPES.ENROLLMENT_APPROVED]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "تم تسجيلك في {courseName}",
    [NOTIFICATION_CHANNELS.PUSH]: "مسجل في {courseName}",
    [NOTIFICATION_CHANNELS.EMAIL]: "تمت الموافقة على تسجيلك في {courseName}.",
  },
  [NOTIFICATION_TYPES.COURSE_PUBLISHED]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "مادة {courseName} متاحة الآن",
    [NOTIFICATION_CHANNELS.PUSH]: "مادة جديدة: {courseName}",
    [NOTIFICATION_CHANNELS.EMAIL]: "مادة جديدة متاحة الآن: {courseName}.",
  },
  [NOTIFICATION_TYPES.DISCUSSION_REPLY]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "رد جديد من {replierName} في {discussionTitle}",
    [NOTIFICATION_CHANNELS.PUSH]: "{replierName} رد على {discussionTitle}",
    [NOTIFICATION_CHANNELS.EMAIL]:
      'قام {replierName} بالرد على "{discussionTitle}" في مادة {courseName}.',
  },
  [NOTIFICATION_TYPES.STUDY_GROUP_INVITE]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "{inviterName} يدعوك للانضمام إلى {groupName}",
    [NOTIFICATION_CHANNELS.PUSH]: "دعوة مجموعة دراسة: {groupName}",
    [NOTIFICATION_CHANNELS.EMAIL]:
      'قام {inviterName} بدعوتك للانضمام إلى مجموعة الدراسة "{groupName}".',
  },
  [NOTIFICATION_TYPES.CERTIFICATE_ISSUED]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "تم إصدار شهادة لـ {courseName}",
    [NOTIFICATION_CHANNELS.PUSH]: "شهادة: {courseName}",
    [NOTIFICATION_CHANNELS.EMAIL]: "شهادتك لمادة {courseName} متاحة الآن.",
  },
  [NOTIFICATION_TYPES.SUPPORT_MESSAGE]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "{subject}",
    [NOTIFICATION_CHANNELS.PUSH]: "رسالة جديدة: {subject}",
    [NOTIFICATION_CHANNELS.EMAIL]: "لديك رسالة دعم جديدة بخصوص: {subject}.",
  },
  [NOTIFICATION_TYPES.ATTENDANCE_ALERT]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "تنبيه حضور لـ {courseName} في {date}",
    [NOTIFICATION_CHANNELS.PUSH]: "تنبيه: {courseName} — {date}",
    [NOTIFICATION_CHANNELS.EMAIL]: "هذا تنبيه حضور لمادة {courseName}. تم تسجيل غيابات في {date}.",
  },
  [NOTIFICATION_TYPES.ADMIN_ANNOUNCEMENT]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "{title}",
    [NOTIFICATION_CHANNELS.PUSH]: "إعلان: {title}",
    [NOTIFICATION_CHANNELS.EMAIL]: "{title}\n\n{summary}",
  },
  [NOTIFICATION_TYPES.ANNOUNCEMENT]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "{title}",
    [NOTIFICATION_CHANNELS.PUSH]: "إعلان: {title}",
    [NOTIFICATION_CHANNELS.EMAIL]: "{title}\n\n{summary}",
  },
  [NOTIFICATION_TYPES.MATERIAL_SCAN_QUARANTINED]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "تم حظر {fileName} بسبب فحص مكافحة الفيروسات",
    [NOTIFICATION_CHANNELS.PUSH]: "تم حظر التحميل: {fileName}",
    [NOTIFICATION_CHANNELS.EMAIL]: 'تم حظر ملف "{fileName}" لأنه مصاب بـ {virus}. لن يتم نشره.',
  },
  [NOTIFICATION_TYPES.MATERIAL_SCAN_FAILED]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "تعذر فحص {fileName}",
    [NOTIFICATION_CHANNELS.PUSH]: "لم يتم فحص التحميل: {fileName}",
    [NOTIFICATION_CHANNELS.EMAIL]: 'تعذر فحص ملف "{fileName}" ولم يتم نشره. يرجى إعادة تحميله.',
  },
  [NOTIFICATION_TYPES.MATERIAL_OCR_LOW_CONFIDENCE]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "يتطلب {fileName} مراجعة سريعة",
    [NOTIFICATION_CHANNELS.PUSH]: "مراجعة مطلوبة: {fileName}",
    [NOTIFICATION_CHANNELS.EMAIL]:
      'تم تحويل ملف "{fileName}" تلقائيًا، لكن الصفحات التالية كانت صعبة القراءة: {pages}. يرجى مراجعتها.',
  },
  [NOTIFICATION_TYPES.MATERIAL_INGESTED]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "{fileName} جاهز للبحث الذكي",
    [NOTIFICATION_CHANNELS.PUSH]: "جاهز للبحث: {fileName}",
    [NOTIFICATION_CHANNELS.EMAIL]: 'انتهت معالجة ملف "{fileName}" وأصبح قابلاً للبحث الآن.',
  },
  [NOTIFICATION_TYPES.MATERIAL_INGEST_FAILED]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "تعذر جعل {fileName} قابلاً للبحث",
    [NOTIFICATION_CHANNELS.PUSH]: "فشلت المعالجة: {fileName}",
    [NOTIFICATION_CHANNELS.EMAIL]:
      'تعذرت معالجة ملف "{fileName}" وهو غير قابل للبحث. يمكنك المحاولة مرة أخرى من صفحة الملف.',
  },
} as const satisfies LocaleTemplateSet;
