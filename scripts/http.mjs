import { spawnSync } from "node:child_process";

export function request(method, url, body, headers = {}) {
  const args = ["-s", "-i", "-X", method.toUpperCase(), url];
  for (const [key, value] of Object.entries(headers)) {
    args.push("-H", `${key}: ${value}`);
  }
  if (body !== undefined) {
    args.push("-H", "content-type: application/json", "-d", JSON.stringify(body));
  }

  const result = spawnSync("curl", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`curl failed for ${method} ${url}: ${result.stderr || result.stdout}`);
  }

  const raw = result.stdout;
  const [headerBlock, ...bodyParts] = raw.split(/\r?\n\r?\n/);
  const statusMatch = headerBlock.match(/HTTP\/\S+\s+(\d+)/);
  const status = statusMatch ? Number(statusMatch[1]) : 0;
  const responseBody = bodyParts.join("\n\n").trim();
  let json = undefined;
  if (responseBody) {
    try {
      json = JSON.parse(responseBody);
    } catch {
      json = responseBody;
    }
  }

  return { status, body: json, raw };
}

export function assert(condition, message, detail) {
  if (!condition) {
    const suffix = detail === undefined ? "" : `\n${JSON.stringify(detail, null, 2)}`;
    throw new Error(`${message}${suffix}`);
  }
}
