/**
 * Object-storage key rotation (#400) — public surface for the certmanager service.
 */

export {
  RotatingStorageClient,
  InMemoryStorageObjectStore,
  isAuthError,
  AUTH_ERROR_PATTERN,
} from "./rotatingClient.js";
export type {
  StorageObjectStore,
  StorageOperation,
} from "./rotatingClient.js";

export {
  StorageRotationService,
  StorageRotationScheduler,
  DEFAULT_ROTATION_DAYS,
  DEFAULT_GRACE_PERIOD_MS,
  DAY_MS,
} from "./rotationService.js";
export type {
  StorageKeyProvider,
  RotationServiceOptions,
  RotateResult,
  CompleteRotationResult,
} from "./rotationService.js";
