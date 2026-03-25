// src/utils/sanitizer.ts

const SECRET_PATTERNS = [
  /(?:api[_-]?key|token|password|secret|credential)['":\s]*[=:]\s*['"]?[\w\-./+=]{8,}['"]?/gi,
  /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g,
  /\bghp_[\w]{36}\b/g,
  /\bsk-ant-[\w-]+\b/g,
  /\bxoxb-[\w-]+\b/g,
];

export function sanitizeLogSamples(samples: string[]): string[] {
  return samples.map((sample) => {
    let sanitized = sample;
    for (const pattern of SECRET_PATTERNS) {
      sanitized = sanitized.replace(pattern, "[REDACTED]");
    }
    return sanitized.substring(0, 2000);
  });
}
