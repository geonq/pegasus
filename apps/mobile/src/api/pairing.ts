import type { Pairing } from "./types";

/**
 * Reads the link in the QR code Pegasus shows in Settings › Phone:
 * `pegasus://pair?v=1&url=http://100.x.y.z:47219&token=…&name=PC`.
 * Plain string parsing: React Native's URL does not handle custom schemes or searchParams fully.
 * Anything else is refused with a reason people can act on.
 */
export function parsePairingLink(text: string): Pairing {
  const match = /^pegasus:\/\/pair\/?\?(.*)$/u.exec(text.trim());
  if (!match) throw new Error("That is not a Pegasus pairing code.");
  const params = new Map<string, string>();
  for (const part of (match[1] ?? "").split("&")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    try {
      params.set(part.slice(0, eq), decodeURIComponent(part.slice(eq + 1).replace(/\+/gu, " ")));
    } catch {
      throw new Error("That is not a Pegasus pairing code.");
    }
  }
  if (params.get("v") !== "1") {
    throw new Error("This pairing code is from a newer Pegasus. Update the app.");
  }
  const address = /^(https?):\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(?::(\d{1,5}))?\/?$/u.exec(
    params.get("url") ?? "",
  );
  if (!address) throw new Error("The pairing code has no valid address.");
  const token = params.get("token") ?? "";
  if (!/^[A-Za-z0-9._~-]{32,256}$/u.test(token)) {
    throw new Error("The pairing code has no valid key.");
  }
  const [, scheme, host, port] = address;
  return {
    url: `${scheme}://${host}${port ? `:${port}` : ""}`,
    token,
    hostName: (params.get("name") ?? "").slice(0, 64) || (host ?? ""),
  };
}
