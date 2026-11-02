# Error Taxonomy

This document maps domain error codes from `@studafy/constants` to HTTP status codes and describes the RFC 9457 error envelope structure.

## RFC 9457 Problem Details

All error responses follow the RFC 9457 specification with the `application/problem+json` content type.

### Response Structure

```json
{
  "type": "about:blank",
  "title": "Forbidden",
  "status": 403,
  "detail": "Access denied",
  "instance": "/api/resource/123",
  "code": "AUTHZ_FORBIDDEN",
  "request_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

| Field        | Type    | Description                                                         |
| ------------ | ------- | ------------------------------------------------------------------- |
| `type`       | string  | URI reference identifying the problem type (default: "about:blank") |
| `title`      | string  | Human-readable status description                                   |
| `status`     | integer | HTTP status code                                                    |
| `detail`     | string  | Localized human-readable explanation (optional)                     |
| `instance`   | string  | URI reference identifying the specific occurrence (optional)        |
| `code`       | string  | Machine-readable error code from `@studafy/constants`               |
| `request_id` | UUID    | Unique identifier linking to log lines and audit trail              |

## Error Code Mapping

### Authentication Errors (401 Unauthorized)

| Error Code                 | HTTP Status | Description                              |
| -------------------------- | ----------- | ---------------------------------------- |
| `AUTH_INVALID_CREDENTIALS` | 401         | Caller identity could not be established |
| `AUTH_TOKEN_EXPIRED`       | 401         | Authentication token has expired         |
| `AUTH_TOKEN_INVALID`       | 401         | Token is malformed or invalid            |
| `AUTH_SESSION_NOT_FOUND`   | 401         | No session found                         |

### Authorization Errors (403 Forbidden)

| Error Code                   | HTTP Status | Description                          |
| ---------------------------- | ----------- | ------------------------------------ |
| `AUTHZ_FORBIDDEN`            | 403         | Caller is known but not permitted    |
| `AUTHZ_ROLE_NOT_FOUND`       | 403         | Referenced role does not exist       |
| `AUTHZ_PERMISSION_NOT_FOUND` | 403         | Referenced permission does not exist |

### Validation Errors (400 Bad Request)

| Error Code                          | HTTP Status | Description              |
| ----------------------------------- | ----------- | ------------------------ |
| `VALIDATION_FAILED`                 | 400         | Input was malformed      |
| `VALIDATION_REQUIRED_FIELD_MISSING` | 400         | Required field is absent |

### Resource Errors (404 Not Found)

| Error Code                 | HTTP Status | Description                          |
| -------------------------- | ----------- | ------------------------------------ |
| `RESOURCE_NOT_FOUND`       | 404         | Entity does not exist or was removed |
| `RESOURCE_ALREADY_DELETED` | 404         | Entity was already deleted           |

### Conflict Errors (409 Conflict)

| Error Code                 | HTTP Status | Description                                   |
| -------------------------- | ----------- | --------------------------------------------- |
| `CONFLICT_DUPLICATE_ENTRY` | 409         | Request contradicts current state (duplicate) |
| `CONFLICT_STATE_MISMATCH`  | 409         | Request contradicts current state             |

### Rate Limiting (429 Too Many Requests)

| Error Code            | HTTP Status | Description       |
| --------------------- | ----------- | ----------------- |
| `RATE_LIMIT_EXCEEDED` | 429         | Too many requests |

### Server Errors (500 Internal Server Error)

| Error Code       | HTTP Status | Description                  |
| ---------------- | ----------- | ---------------------------- |
| `INTERNAL_ERROR` | 500         | Uncategorized server failure |

## Security Considerations

### Error Message Leaking

- **4xx errors**: Safe to echo to the client (authored in this codebase)
- **5xx errors**: Never leak internal details (stack traces, dependency names, database queries)
- **Unknown errors**: Return generic "Internal Server Error" with no details

### Request ID

- Generated server-side using `crypto.randomUUID()` (CSPRNG-backed v4 UUID)
- Never trust client-provided `X-Request-Id` headers
- Links error responses to server-side log lines
- Used for audit trail correlation

## Localization

Error messages are localized based on the `Accept-Language` header:

| Locale | Language | Example         |
| ------ | -------- | --------------- |
| `en`   | English  | "Access denied" |
| `ar`   | Arabic   | "تم رفض الوصول" |

See [Locale Catalog Structure](./locale-catalog-structure.md) for translation guidelines.
