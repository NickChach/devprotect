export interface Finding {
  rule: string;
  kind: 'static';
  file: string;
  line?: number;
  evidence: string;
  explanation: string;
}

export interface CoverageGap {
  stage: 'inventory' | 'static' | 'dependencies' | 'simulation' | 'advisories';
  reason: string;
  file?: string;
}

export interface ScanReport {
  schemaVersion: 1;
  target: string;
  package: { name: string; version: string; source: 'local-directory' };
  files: { path: string; bytes: number; sha256: string }[];
  scripts: { name: string; command: string; status: 'not-run' }[];
  findings: Finding[];
  coverage: { status: 'incomplete'; gaps: CoverageGap[] };
}
