# Locale Catalog Structure

This document describes the structure and guidelines for translation files used in the Studafy API.

## Directory Structure

```
/apps/api/src/locales/
├── en.json    # English translations
└── ar.json    # Arabic translations
```

## Translation File Format

Translation files are JSON objects mapping error codes to localized messages:

```json
{
  "ERROR_CODE_1": "Localized message for ERROR_CODE_1",
  "ERROR_CODE_2": "Localized message for ERROR_CODE_2"
}
```

### Key Requirements

1. **Key Format**: Keys must match error codes from `@studafy/constants` exactly
2. **Key Consistency**: All locale files must have identical keys
3. **Value Format**: Values are plain strings (no interpolation, no HTML)
4. **Encoding**: UTF-8 encoding without BOM

## Supported Locales

| Locale Code | Language | Direction |
| ----------- | -------- | --------- |
| `en`        | English  | LTR       |
| `ar`        | Arabic   | RTL       |

## Adding a New Locale

1. Create a new JSON file in `/apps/api/src/locales/` with the locale code as filename
2. Copy all keys from `en.json` as the base
3. Translate all values to the target language
4. Update the `SupportedLocale` type in `middleware/locale.ts`
5. Add the locale to the `catalogs` object in `middleware/locale.ts`
6. Add tests for the new locale in `middleware/locale.test.ts`

### Example: Adding French (fr)

1. Create `fr.json`:

```json
{
  "AUTH_INVALID_CREDENTIALS": "Identifiants invalides",
  "AUTH_TOKEN_EXPIRED": "Le jeton d'authentification a expiré",
  ...
}
```

2. Update `middleware/locale.ts`:

```typescript
import fr from "../locales/fr.json";

export type SupportedLocale = "en" | "ar" | "fr";

const catalogs: Record<SupportedLocale, TranslationCatalog> = {
  en: en as TranslationCatalog,
  ar: ar as TranslationCatalog,
  fr: fr as TranslationCatalog,
};
```

3. Add tests:

```typescript
test("returns French message for AUTH_INVALID_CREDENTIALS", () => {
  const message = getLocalizedMessage(ERROR_CODES.AUTH_INVALID_CREDENTIALS, "fr");
  expect(message).toBe("Identifiants invalides");
});
```

## Translation Guidelines

### Message Style

- Use clear, concise language
- Avoid technical jargon
- Use present tense
- Be consistent with terminology across all messages

### Arabic Translations

- Use Modern Standard Arabic (MSA)
- Avoid dialectal variations
- Ensure proper RTL formatting
- Test with Arabic-speaking users when possible

### Error Message Structure

Error messages should be:

- **Concise**: One line, no sentences
- **Clear**: Immediately understandable
- **Actionable**: Suggest what the user should do (when applicable)
- **Neutral**: Avoid blame or emotional language

### Examples

| Error Code                 | English                        | Arabic                      |
| -------------------------- | ------------------------------ | --------------------------- |
| `AUTH_INVALID_CREDENTIALS` | "Invalid credentials provided" | "بيانات الاعتماد غير صالحة" |
| `RESOURCE_NOT_FOUND`       | "Resource not found"           | "لم يتم العثور على المورد"  |
| `VALIDATION_FAILED`        | "Validation failed"            | "فشل التحقق من الصحة"       |

## Fallback Behavior

When a locale is not supported or a translation is missing:

1. **Unsupported Locale**: Falls back to English (`en`)
2. **Missing Translation**: Falls back to English translation for the same error code
3. **Missing Error Code**: Returns the error code itself as the message

## ERPNext Integration

The `Accept-Language` header is forwarded to ERPNext to receive translated system errors:

```typescript
// Forward original header value
const acceptLanguage = c.req.header("Accept-Language");
await erpNextClient.get("/api/resource/Student", {
  acceptLanguage,
});
```

This ensures ERPNext returns error messages in the same language as the API response.

## Testing Translations

### Unit Tests

```typescript
describe("getLocalizedMessage", () => {
  test("returns correct translation for each locale", () => {
    const errorCodes = Object.values(ERROR_CODES);
    for (const code of errorCodes) {
      const enMessage = getLocalizedMessage(code, "en");
      const arMessage = getLocalizedMessage(code, "ar");
      expect(enMessage).toBeTruthy();
      expect(arMessage).toBeTruthy();
      expect(enMessage).not.toBe(arMessage);
    }
  });
});
```

### Integration Tests

```typescript
describe("locale middleware integration", () => {
  test("returns localized error message based on Accept-Language", async () => {
    const res = await app.request("/nonexistent", {
      headers: { "Accept-Language": "ar" },
    });
    const body = await res.json();
    expect(body.detail).toContain("لم يتم العثور على المورد");
  });
});
```

## Adding New Error Codes

When adding a new error code to `@studafy/constants`:

1. Add the error code to `ERROR_CODES` in `packages/constants/src/errors.ts`
2. Add translations for all supported locales
3. Update the error mapping in `middleware/errorHandler.ts` if needed
4. Add tests for the new error code

## Performance Considerations

- Translation catalogs are loaded at module initialization (not per request)
- Lookups are O(1) using object property access
- No runtime parsing or compilation of translations
- Minimal memory overhead (catalogs are small JSON objects)
