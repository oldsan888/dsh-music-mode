import { config } from "../config.js";
import { isLoopbackAddress } from "./loopback.js";

/**
 * Diagnostic logs are intentionally unavailable by default.  When a developer
 * opts in, direct backend access must still originate from loopback.
 */
export function canAccessDebugLog(
  remoteAddress: string | undefined,
  enabled = config.log.debugEndpoint,
): boolean {
  return enabled && isLoopbackAddress(remoteAddress);
}
