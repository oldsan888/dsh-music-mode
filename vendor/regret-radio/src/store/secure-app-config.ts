import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../config.js";
import { deleteAppConfig, readAppConfig, writeAppConfig } from "./app-config.js";
import { getDb } from "./sqlite.js";

const PREFIX = "enc:v1:";

function keyBytes(masterKey: string): Buffer | null {
  return /^[a-f0-9]{64}$/i.test(masterKey) ? Buffer.from(masterKey, "hex") : null;
}

/** Whether runtime credentials can be encrypted without an additional service. */
export function isRuntimeSecretStorageAvailable(): boolean {
  return keyBytes(config.security.runtimeConfigMasterKey) !== null;
}

export function encryptRuntimeConfig(plainText: string, masterKey: string): string {
  const key = keyBytes(masterKey);
  if (!key) throw new Error("RUNTIME_CONFIG_MASTER_KEY 必须是 64 位十六进制字符串");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

export function decryptRuntimeConfig(payload: string, masterKey: string): string | null {
  const key = keyBytes(masterKey);
  if (!key || !payload.startsWith(PREFIX)) return null;
  const parts = payload.split(":");
  if (parts.length !== 5) return null;
  try {
    const iv = Buffer.from(parts[2], "base64url");
    const tag = Buffer.from(parts[3], "base64url");
    const ciphertext = Buffer.from(parts[4], "base64url");
    // Buffer's decoder is deliberately permissive; require canonical encoding
    // so appended or malformed bytes cannot be silently accepted.
    if (
      iv.toString("base64url") !== parts[2] ||
      tag.toString("base64url") !== parts[3] ||
      ciphertext.toString("base64url") !== parts[4]
    ) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Read encrypted data only. Legacy plaintext is intentionally not trusted. */
type Db = ReturnType<typeof getDb>;

export function readSecureAppConfig(key: string, db?: Db): string | null {
  const raw = readAppConfig(key, db);
  return raw ? decryptRuntimeConfig(raw, config.security.runtimeConfigMasterKey) : null;
}

export function writeSecureAppConfig(key: string, value: string, db?: Db): void {
  writeAppConfig(key, encryptRuntimeConfig(value, config.security.runtimeConfigMasterKey), db);
}

export function deleteSecureAppConfig(key: string, db?: Db): void {
  deleteAppConfig(key, db);
}
