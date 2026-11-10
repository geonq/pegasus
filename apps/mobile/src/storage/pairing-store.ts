import * as SecureStore from "expo-secure-store";
import type { Pairing } from "../api/types";

/** The pairing (address + this phone's key) lives in the iOS Keychain, this device only. */
const KEY = "pegasus.pairing.v1";

export async function loadPairing(): Promise<Pairing | null> {
  const raw = await SecureStore.getItemAsync(KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Pairing>;
    if (typeof value.url === "string" && typeof value.token === "string") {
      return { url: value.url, token: value.token, hostName: value.hostName ?? value.url };
    }
  } catch {
    // Unreadable: treat as unpaired so the person can pair again.
  }
  return null;
}

export function savePairing(pairing: Pairing): Promise<void> {
  return SecureStore.setItemAsync(KEY, JSON.stringify(pairing), {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
}

export function forgetPairing(): Promise<void> {
  return SecureStore.deleteItemAsync(KEY);
}
