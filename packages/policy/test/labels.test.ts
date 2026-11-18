import { describe, expect, it } from 'vitest';
import { TOOL_FAMILY_NOUNS, TOOL_POLICIES, toolLabels, toolNoun } from '../src/index';

describe('run 3: friendly tool labels', () => {
  it('every tool family has a plain noun', () => {
    for (const tool of Object.keys(TOOL_POLICIES)) {
      expect(TOOL_FAMILY_NOUNS[tool.split('.')[0]!], tool).toBeTruthy();
      expect(toolNoun(tool)).not.toContain('.');
    }
  });
  it('labels never contain the raw tool id', () => {
    for (const tool of Object.keys(TOOL_POLICIES)) {
      const l = toolLabels(tool, 'Do a thing');
      expect(l.running).not.toContain(tool);
      expect(l.done).not.toContain(tool);
      expect(l.running.length).toBeGreaterThan(0);
    }
  });
  it('reads say "Checked …"', () => {
    expect(toolLabels('tasks.search').done).toBe('Checked your tasks');
    expect(toolLabels('tasks.search').running).toBe('Checking your tasks');
  });
});
