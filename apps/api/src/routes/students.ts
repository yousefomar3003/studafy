import { HTTPException } from "hono/http-exception";

import { createOpenApiRoute, OpenAPIHono, z } from "../openapi/registry";

import {
  createStudentBodySchema,
  listStudentsQuerySchema,
  studentListResponseSchema,
  studentSchema,
} from "./students.schema";

import type { Student } from "./students.schema";
import type { AppEnv } from "../middleware/requestId";

// ---------------------------------------------------------------------------
// Route definitions — every route is wrapped with `createOpenApiRoute` so the
// RFC 9457 problem+json error envelope (400, 401, 403, 404, 429, 500) is
// automatically documented unless the handler explicitly defines a replacement.
// ---------------------------------------------------------------------------

const listStudents = createOpenApiRoute({
  method: "get",
  path: "/api/students",
  tags: ["Students"],
  summary: "List students",
  description: "Returns a paginated list of students, optionally filtered by grade level.",
  request: { query: listStudentsQuerySchema },
  responses: {
    200: {
      content: { "application/json": { schema: studentListResponseSchema } },
      description: "Paginated list of students.",
    },
  },
});

const getStudent = createOpenApiRoute({
  method: "get",
  path: "/api/students/{id}",
  tags: ["Students"],
  summary: "Get a student by ID",
  description: "Returns a single student entity.",
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: studentSchema } },
      description: "The requested student.",
    },
  },
});

const createStudent = createOpenApiRoute({
  method: "post",
  path: "/api/students",
  tags: ["Students"],
  summary: "Create a new student",
  description: "Creates a new student entity and returns it.",
  request: { body: { content: { "application/json": { schema: createStudentBodySchema } } } },
  responses: {
    201: {
      content: { "application/json": { schema: studentSchema } },
      description: "The newly created student.",
    },
  },
});

// ---------------------------------------------------------------------------
// Route handlers — registered on the Hono app. These are in-memory stubs for
// demonstration; replace with real database queries when implementing the
// students domain.
// ---------------------------------------------------------------------------

const STUDENTS: Student[] = [
  {
    id: "550e8400-e29b-41d4-a716-446655440000",
    firstName: "Alice",
    lastName: "Johnson",
    email: "alice.johnson@studafy.example.com",
    gradeLevel: 10,
    createdAt: "2025-09-01T08:00:00Z",
  },
];

export function studentRoutes() {
  const routes = new OpenAPIHono<AppEnv>();

  routes.openapi(listStudents, (c) => {
    const { limit, cursor, gradeLevel } = c.req.valid("query");

    let filtered = STUDENTS;
    if (gradeLevel !== undefined) {
      filtered = filtered.filter((s) => s.gradeLevel === gradeLevel);
    }

    if (cursor) {
      const idx = filtered.findIndex((s) => s.id === cursor);
      if (idx !== -1) filtered = filtered.slice(idx + 1);
    }

    const page = filtered.slice(0, limit);
    const nextCursor = page.length === limit ? page[page.length - 1]!.id : null;

    return c.json({ data: page, nextCursor }, 200);
  });

  routes.openapi(getStudent, (c) => {
    const { id } = c.req.valid("param");
    const student = STUDENTS.find((s) => s.id === id);

    if (!student) {
      throw new HTTPException(404, { message: "Student not found" });
    }

    return c.json(student, 200);
  });

  routes.openapi(createStudent, (c) => {
    const body = c.req.valid("json");

    const student: Student = {
      id: crypto.randomUUID(),
      ...body,
      createdAt: new Date().toISOString(),
    };

    STUDENTS.push(student);
    return c.json(student, 201);
  });

  return routes;
}
