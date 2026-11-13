import type { AttendanceMatrixRow, AttendanceMetadata, StudentAttendanceProfile } from "../types";

const STUDENTS = [
  ["11111111-1111-4111-8111-111111111111", "Amina Hassan", "ST-1001", "present", 4],
  ["22222222-2222-4222-8222-222222222222", "Omar Saleh", "ST-1002", "absent", 14],
  ["33333333-3333-4333-8333-333333333333", "Lina Nasser", "ST-1003", "late", 10],
  ["44444444-4444-4444-8444-444444444444", "Yousef Ali", "ST-1004", "excused", 10],
] as const;

export const attendanceMetadataFixture: AttendanceMetadata = {
  grades: ["9", "10"],
  sections: [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "9-A", grade: "9" },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "10-B", grade: "10" },
  ],
};

export const attendanceMatrixFixture: AttendanceMatrixRow[] = Array.from(
  { length: 108 },
  (_, index) => {
    const source = STUDENTS[index % STUDENTS.length];
    const [baseId, baseName, admission, status, absentPercent] = source;
    const suffix = String(index + 1).padStart(3, "0");
    const grade = index % 2 === 0 ? "9" : "10";
    const sectionId =
      grade === "9"
        ? attendanceMetadataFixture.sections[0]!.id
        : attendanceMetadataFixture.sections[1]!.id;
    return {
      recordId: `${baseId.slice(0, -3)}${suffix}`,
      studentId: `${baseId.slice(0, -3)}${suffix}`,
      studentName: index < STUDENTS.length ? baseName : `${baseName} ${suffix}`,
      admissionNumber: `${admission}-${suffix}`,
      classId: sectionId,
      classCode: grade === "9" ? "G9-A" : "G10-B",
      grade,
      sectionId,
      sectionName: grade === "9" ? "9-A" : "10-B",
      sessionDate: "2026-08-18",
      status,
      minutesLate: status === "late" ? 12 : null,
      absentPercent,
      excusedPercent: status === "excused" ? 12 : 2,
    };
  },
);

export async function fetchAttendanceMatrixFixture(): Promise<AttendanceMatrixRow[]> {
  return attendanceMatrixFixture;
}

export async function fetchAttendanceMetadataFixture(): Promise<AttendanceMetadata> {
  return attendanceMetadataFixture;
}

export async function fetchStudentProfileFixture(
  studentId: string,
): Promise<StudentAttendanceProfile | null> {
  const row = attendanceMatrixFixture.find((item) => item.studentId === studentId);
  if (!row) return null;
  return {
    studentId: row.studentId,
    studentName: row.studentName,
    admissionNumber: row.admissionNumber,
    classCode: row.classCode,
    attendancePercent: 100 - row.absentPercent,
    timeline: [
      {
        recordId: row.recordId,
        date: row.sessionDate,
        status: row.status,
        minutesLate: row.minutesLate,
        reason: null,
        version: 1,
        outOfWindow: false,
      },
      {
        recordId: `${row.recordId.slice(0, -3)}900`,
        date: "2026-08-17",
        status: "present",
        minutesLate: null,
        reason: null,
        version: 1,
        outOfWindow: false,
      },
    ],
  };
}
