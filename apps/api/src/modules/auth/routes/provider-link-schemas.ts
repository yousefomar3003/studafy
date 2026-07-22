import { z } from "@hono/zod-openapi";

// ---------------------------------------------------------------------------
// Path params
// ---------------------------------------------------------------------------

export const providerPathParams = z
  .object({
    provider: z.enum(["microsoft", "google"]).openapi({
      param: { name: "provider", in: "path" },
      description: "The OAuth provider to link or unlink.",
      example: "google",
    }),
  })
  .openapi("ProviderPathParams");

export const adminProviderPathParams = z
  .object({
    userId: z
      .string()
      .uuid()
      .openapi({
        param: { name: "userId", in: "path" },
        description: "The target user's id.",
      }),
    provider: z.enum(["microsoft", "google"]).openapi({
      param: { name: "provider", in: "path" },
      description: "The OAuth provider to unlink.",
    }),
  })
  .openapi("AdminProviderPathParams");

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export const linkStartBodySchema = z
  .object({
    provider: z.enum(["microsoft", "google"]).openapi({
      description: "The OAuth provider to link.",
      example: "google",
    }),
  })
  .openapi("LinkProviderStartRequest");

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export const linkedProviderSchema = z
  .object({
    provider: z.string().openapi({ description: "Provider identifier.", example: "microsoft" }),
    linked_at: z.iso.datetime().openapi({ description: "When the provider was linked." }),
  })
  .openapi("LinkedProvider");

export const listProvidersResponseSchema = z
  .object({
    providers: z.array(linkedProviderSchema).openapi({
      description: "All OAuth providers linked to this account.",
    }),
  })
  .openapi("ListLinkedProvidersResponse");

export const linkStartResponseSchema = z
  .object({
    redirect_url: z
      .string()
      .url()
      .openapi({ description: "Redirect the user's browser to this URL to complete linking." }),
  })
  .openapi("LinkProviderStartResponse");

export const unlinkResponseSchema = z
  .object({
    provider: z.string().openapi({ description: "The provider that was unlinked." }),
  })
  .openapi("UnlinkProviderResponse");
