/** Loopback-only guard for routes that receive or mutate credentials. */
export function isLoopbackAddress(address: string | undefined): boolean {
  const value = (address ?? "").toLowerCase();
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}
