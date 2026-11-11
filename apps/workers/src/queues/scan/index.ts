export { materialScanFailedListener, processMaterialScan } from "./scan-material.worker";
export {
  isUploadScanJob,
  processUploadScan,
  uploadScanFailedListener,
  UPLOAD_SCAN_TARGET_SPECS,
} from "./scan-upload.worker";
export {
  scanStream,
  parseClamdResponse,
  ClamdScanError,
  CLAMD_STARTUP_WAIT_MS,
  pingClamd,
  waitForClamd,
} from "./clamd";
export { createScanS3 } from "./s3";
export type { ClamdConfig, ScanVerdict } from "./clamd";
export type { ScanS3Client } from "./s3";
