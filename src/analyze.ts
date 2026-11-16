import { parse } from '@babel/parser';
import type { Finding } from './model.js';

export function inspectText(file: string, text: string, line?: number): Finding[] {
  const findings: Finding[] = [];
  const rules = [
    ['credential-reference', /(?:\.npmrc|\.aws[\\/]|\.ssh[\\/]|NPM_TOKEN|NODE_AUTH_TOKEN|AWS_SECRET_ACCESS_KEY)/i, 'References a credential-related path or variable.'],
    ['network-destination', /https?:\/\/[^\s'"`<>]+/i, 'Contains a network destination; no request was executed.'],
  ] as const;
  for (const [rule, pattern, explanation] of rules) {
    const match = pattern.exec(text);
    if (match) findings.push({ rule, kind: 'static', file, ...(line === undefined ? {} : { line }), evidence: match[0].slice(0, 240), explanation });
  }
  return findings;
}

// Iterative AST traversal avoids adding a traversal dependency and call-stack growth.
export function analyzeSource(file: string, source: string): Finding[] {
  const ast = parse(source, {
    sourceType: 'unambiguous',
    plugins: [...(/\.[cm]?tsx?$/.test(file) ? ['typescript' as const] : []), ...(/\.[jt]sx$/.test(file) ? ['jsx' as const] : [])],
  });
  const pending: unknown[] = [ast];
  const findings: Finding[] = [];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) { pending.push(...value); continue; }
    const node = value as Record<string, unknown>;
    const line = (node.loc as { start?: { line?: number } } | undefined)?.start?.line ?? 1;
    if (node.type === 'StringLiteral' && typeof node.value === 'string') {
      findings.push(...inspectText(file, node.value, line));
      if (['child_process', 'node:child_process'].includes(node.value)) {
        findings.push({ rule: 'process-module-reference', kind: 'static', file, line, evidence: node.value, explanation: 'References process-launching APIs; execution was not established.' });
      }
    }
    if (node.type === 'TemplateElement') {
      const raw = (node.value as { raw?: string } | undefined)?.raw;
      if (raw) findings.push(...inspectText(file, raw, line));
    }
    for (const [key, child] of Object.entries(node)) {
      if (!['loc', 'tokens', 'comments', 'leadingComments', 'trailingComments', 'innerComments', 'extra'].includes(key)) pending.push(child);
    }
  }
  return findings.sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || a.rule.localeCompare(b.rule));
}
