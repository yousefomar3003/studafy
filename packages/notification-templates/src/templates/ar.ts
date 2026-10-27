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
  [NOTIFICATION_TYPES.DIRECT_MESSAGE]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "رسالة جديدة من {senderName}",
    [NOTIFICATION_CHANNELS.PUSH]: "{senderName}: {preview}",
    [NOTIFICATION_CHANNELS.EMAIL]: 'أرسل لك {senderName} رسالة: "{preview}"',
  },
  [NOTIFICATION_TYPES.FEE_INVOICE_ISSUED]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "فاتورة جديدة لـ {studentName}: {amount}",
    [NOTIFICATION_CHANNELS.PUSH]: "فاتورة لـ {studentName}: {amount}، تستحق في {dueDate}",
    [NOTIFICATION_CHANNELS.EMAIL]:
      "صدرت فاتورة جديدة بقيمة {amount} لـ {studentName}، وتستحق في {dueDate}.",
  },
  [NOTIFICATION_TYPES.FEE_PAYMENT_RECEIVED]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "تم استلام دفعة لـ {studentName}: {amount}",
    [NOTIFICATION_CHANNELS.PUSH]: "شكرًا لك — استلمنا {amount} عن {studentName}",
    [NOTIFICATION_CHANNELS.EMAIL]:
      "استلمنا دفعتك بقيمة {amount} عن {studentName}. رقم الإيصال: {receiptNumber}.",
  },
  [NOTIFICATION_TYPES.FEE_PAYMENT_REMINDER]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "تذكير: رسوم مدرسية متأخرة بقيمة {amount}",
    [NOTIFICATION_CHANNELS.PUSH]: "تذكير بالرسوم المدرسية: {amount} متأخرة",
    [NOTIFICATION_CHANNELS.EMAIL]:
      "عائلة {familyName} الكريمة، نذكّركم بأن رسومًا مدرسية بقيمة {amount} متأخرة في {overdueCount} فاتورة. يرجى التواصل مع القسم المالي في المدرسة إذا كنتم قد دفعتم بالفعل.",
  },
  [NOTIFICATION_TYPES.FEE_STATEMENT]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "كشف حساب الرسوم لعائلتكم: {outstanding} مستحقة",
    [NOTIFICATION_CHANNELS.PUSH]: "كشف حساب الرسوم: {outstanding} مستحقة",
    [NOTIFICATION_CHANNELS.EMAIL]:
      "عائلة {familyName} الكريمة، إليكم كشف حساب الرسوم لعدد {childCount} من الأبناء. الرصيد المستحق {outstanding}. افتحوا تطبيق Studafy للاطلاع على التفاصيل.",
  },
  [NOTIFICATION_TYPES.LICENSE_SEAT_APPLE_RENEWAL]: {
    [NOTIFICATION_CHANNELS.IN_APP]:
      "أصبحت {schoolName} تغطي اشتراكك في Studafy. لتجنّب الدفع مرتين، أوقف التجديد من جهاز iPhone: الإعدادات > اسمك > الاشتراكات > Studafy > إلغاء الاشتراك. يبقى وصولك حتى {periodEnd}، ويستمر مقعد المدرسة بعد ذلك.",
    [NOTIFICATION_CHANNELS.PUSH]: "أصبحت {schoolName} تغطي Studafy: أوقف تجديد اشتراك App Store",
    [NOTIFICATION_CHANNELS.EMAIL]:
      "منحتك {schoolName} مقعداً في Studafy يغطي اشتراكك في App Store. لا تسمح Apple لنا بإيقاف تجديده نيابةً عنك، لذا لتجنّب الدفع مرتين يُرجى إيقافه: افتح الإعدادات في جهاز iPhone، ثم اضغط على اسمك، ثم الاشتراكات، ثم Studafy، ثم إلغاء الاشتراك. يبقى وصولك حتى {periodEnd}، ويستمر مقعد المدرسة بعد ذلك.",
  },
  [NOTIFICATION_TYPES.LICENSE_EXPIRING]: {
    [NOTIFICATION_CHANNELS.IN_APP]:
      "ينتهي ترخيص Studafy الخاص بـ {schoolName} في {endsAt}، بعد {daysLeft} يوماً. جدّدوه لتبقى مقاعده مغطاة.",
    [NOTIFICATION_CHANNELS.PUSH]: "{schoolName}: ينتهي ترخيص Studafy بعد {daysLeft} يوماً",
    [NOTIFICATION_CHANNELS.EMAIL]:
      "ينتهي ترخيص Studafy الخاص بـ {schoolName} في {endsAt}، بعد {daysLeft} يوماً. عند انتهائه يفقد كل من يشغل أحد مقاعده الميزات التي يغطيها. تواصلوا مع Studafy لتجديده أو تمديده.",
  },
  [NOTIFICATION_TYPES.LICENSE_INVOICE_DUE]: {
    [NOTIFICATION_CHANNELS.IN_APP]:
      "تستحق اليوم ({dueDate}) الفاتورة {invoiceNumber} لترخيص Studafy الخاص بـ {schoolName}. الرصيد: {balance}.",
    [NOTIFICATION_CHANNELS.PUSH]: "تستحق اليوم فاتورة Studafy رقم {invoiceNumber}: {balance}",
    [NOTIFICATION_CHANNELS.EMAIL]:
      "تستحق اليوم، {dueDate}، الفاتورة {invoiceNumber} لترخيص Studafy الخاص بـ {schoolName}، والمبلغ المستحق {balance}. يُرجى الدفع بتحويل بنكي مع ذكر مرجع الدفع المطبوع على الفاتورة، ورفع الإيصال في Studafy.",
  },
  [NOTIFICATION_TYPES.LICENSE_INVOICE_OVERDUE]: {
    [NOTIFICATION_CHANNELS.IN_APP]:
      "تأخّر سداد الفاتورة {invoiceNumber} لترخيص Studafy الخاص بـ {schoolName} (كانت مستحقة في {dueDate}). الرصيد: {balance}.",
    [NOTIFICATION_CHANNELS.PUSH]: "تأخّر سداد فاتورة Studafy رقم {invoiceNumber}: {balance}",
    [NOTIFICATION_CHANNELS.EMAIL]:
      "كانت الفاتورة {invoiceNumber} لترخيص Studafy الخاص بـ {schoolName} مستحقة في {dueDate} وما زال {balance} غير مسدد. يُرجى الدفع بتحويل بنكي مع ذكر مرجع الدفع المطبوع على الفاتورة، ورفع الإيصال في Studafy.",
  },
  [NOTIFICATION_TYPES.LICENSE_RECEIPT_UPLOADED]: {
    [NOTIFICATION_CHANNELS.IN_APP]:
      "رفعت {schoolName} إيصال تحويل للفاتورة {invoiceNumber}. طابقه مع دفعة.",
    [NOTIFICATION_CHANNELS.PUSH]: "رفعت {schoolName} إيصالاً للفاتورة {invoiceNumber}",
    [NOTIFICATION_CHANNELS.EMAIL]:
      "رفعت {schoolName} إيصال تحويل بنكي للفاتورة {invoiceNumber}. سجّل الدفعة وطابق الإيصال معها في لوحة التراخيص.",
  },
} as const satisfies LocaleTemplateSet;
