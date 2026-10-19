/**
 * PUTs `file`'s bytes directly to a pre-signed S3 URL.
 * Not a TanStack mutation, and not routed through `api`: the URL is already fully authorized and
 * points outside this app's own API, so there is no typed client call to wrap here.
 */
export async function uploadFileToPresignedUrl(uploadUrl: string, file: File): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: "PUT",
    body: file,
    headers: file.type ? { "Content-Type": file.type } : undefined,
  });
  if (!response.ok) {
    throw new Error(`Upload failed (${response.status}).`);
  }
}
