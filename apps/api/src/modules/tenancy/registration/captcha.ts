const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

interface TurnstileResponse {
  success: boolean;
  "error-codes"?: string[];
}

/**
 * Verify a Cloudflare Turnstile captcha token against the siteverify endpoint.
 *
 * Returns `true` when:
 * - `secretKey` is absent (development mode — captcha is skipped)
 * - The token is valid and Turnstile reports success
 *
 * Returns `false` when the token is invalid or the remote call fails.
 *
 * @see https://developers.cloudflare.com/turnstile/troubleshooting/testing/
 */
export async function verifyCaptcha(
  token: string,
  secretKey: string | undefined,
  remoteIp?: string,
): Promise<boolean> {
  if (!secretKey) return true;

  try {
    const body = new URLSearchParams({
      secret: secretKey,
      response: token,
      ...(remoteIp ? { remoteip: remoteIp } : {}),
    });

    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) return false;

    const data = (await res.json()) as TurnstileResponse;
    return data.success === true;
  } catch {
    return false;
  }
}
