import type { ScanReport } from './model.js';

// Escape terminal controls and line separators from all package-controlled text.
export function safeText(value: string): string {
  return JSON.stringify(value).slice(1, -1).replace(/[\u007f-\u009f\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function renderReport(report: ScanReport): string {
  const lines = [
    `DevProtect: ${safeText(report.package.name)}@${safeText(report.package.version)}`,
    `Target: ${safeText(report.target)}`,
    `Inventoried files: ${report.files.length}`,
    `Static indicators: ${report.findings.length} (not proof of malicious behavior)`,
    'Coverage: incomplete',
  ];
  for (const finding of report.findings) lines.push(`  ${safeText(finding.file)}${finding.line === undefined ? '' : `:${finding.line}`} [${finding.rule}] ${safeText(finding.evidence)} — ${finding.explanation}`);
  for (const script of report.scripts) lines.push(`  Script ${safeText(script.name)}: not run — ${safeText(script.command)}`);
  for (const gap of report.coverage.gaps) lines.push(`  Coverage [${gap.stage}]${gap.file ? ` ${safeText(gap.file)}:` : ''} ${gap.reason}`);
  return lines.join('\n');
}
