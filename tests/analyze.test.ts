import { expect, it } from 'vitest';
import { analyzeSource } from '../src/analyze.js';

it('supports TSX and template literals while avoiding comment-only references', () => {
  const findings = analyzeSource('example.tsx', '// https://comment.invalid\nconst x: string = `https://collector.invalid/${value}`; const y = <div/>;');
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ rule: 'network-destination', line: 2 });
});

it('surfaces parse errors to the coordinator', () => {
  expect(() => analyzeSource('broken.js', 'let =')).toThrow();
});
