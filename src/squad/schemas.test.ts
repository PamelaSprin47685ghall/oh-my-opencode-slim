import { describe, expect, test } from 'bun:test';
import {
  DagDesignSchema,
  GlobalPlanSchema,
  NodeExecSchema,
  ReviewSchema,
  schemaForStage,
} from './schemas';

describe('GlobalPlanSchema edge cases', () => {
  test('rejects extra fields', () => {
    const result = GlobalPlanSchema.safeParse({
      size: 'S',
      planMarkdown: 'Plan',
      extraField: 'should fail',
    });
    expect(result.success).toBe(false);
  });

  test('whitespace-only planMarkdown fails validation', () => {
    const result = GlobalPlanSchema.safeParse({
      size: 'M',
      planMarkdown: '   ',
    });
    expect(result.success).toBe(false);
  });

  test('rejects invalid size values', () => {
    const invalid = [
      's',
      'm',
      'l',
      'XL',
      'small',
      'MEDIUM',
      1,
      null,
      undefined,
    ];
    for (const size of invalid) {
      const result = GlobalPlanSchema.safeParse({
        size,
        planMarkdown: 'Plan',
      });
      expect(result.success).toBe(false);
    }
  });
});

describe('ReviewSchema transform edge cases', () => {
  test('transforms various empty values to null', () => {
    const emptyValues = ['', '  ', '\t', '\n', '   \n  \t  '];
    for (const val of emptyValues) {
      const result = ReviewSchema.safeParse({ feedbackMarkdown: val });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.feedbackMarkdown).toBe(null);
      }
    }
  });

  test('preserves whitespace in non-empty feedback', () => {
    const result = ReviewSchema.safeParse({
      feedbackMarkdown: '  needs work  ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.feedbackMarkdown).toBe('  needs work  ');
    }
  });

  test('handles undefined vs null vs missing', () => {
    const r1 = ReviewSchema.safeParse({ feedbackMarkdown: undefined });
    const r2 = ReviewSchema.safeParse({ feedbackMarkdown: null });
    const r3 = ReviewSchema.safeParse({});

    expect(r1.success && r1.data.feedbackMarkdown).toBe(null);
    expect(r2.success && r2.data.feedbackMarkdown).toBe(null);
    expect(r3.success && r3.data.feedbackMarkdown).toBe(null);
  });

  test('rejects generic agent_report fields (reportMarkdown/title)', () => {
    const result = ReviewSchema.safeParse({
      reportMarkdown: 'reject reason',
      title: 'Review',
    });
    expect(result.success).toBe(false);
  });

  test('rejects extra fields alongside feedbackMarkdown', () => {
    const result = ReviewSchema.safeParse({
      feedbackMarkdown: 'needs work',
      extraField: 'should fail',
    });
    expect(result.success).toBe(false);
  });
});

describe('DagDesignSchema validation', () => {
  test('detects cycles in edges', () => {
    const result = DagDesignSchema.safeParse({
      nodes: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
      edges: [
        { parent: 'a', child: 'b' },
        { parent: 'b', child: 'c' },
        { parent: 'c', child: 'a' },
      ],
    });
    expect(result.success).toBe(false);
  });

  test('rejects edge with unknown parent', () => {
    const result = DagDesignSchema.safeParse({
      nodes: [{ name: 'a' }],
      edges: [{ parent: 'unknown', child: 'a' }],
    });
    expect(result.success).toBe(false);
  });

  test('rejects edge with unknown child', () => {
    const result = DagDesignSchema.safeParse({
      nodes: [{ name: 'a' }],
      edges: [{ parent: 'a', child: 'unknown' }],
    });
    expect(result.success).toBe(false);
  });

  test('rejects duplicate node names', () => {
    const result = DagDesignSchema.safeParse({
      nodes: [{ name: 'a' }, { name: 'b' }, { name: 'a' }],
      edges: [],
    });
    expect(result.success).toBe(false);
  });

  test('rejects self-loop', () => {
    const result = DagDesignSchema.safeParse({
      nodes: [{ name: 'a' }],
      edges: [{ parent: 'a', child: 'a' }],
    });
    expect(result.success).toBe(false);
  });

  test('accepts empty edges', () => {
    const result = DagDesignSchema.safeParse({
      nodes: [{ name: 'a' }, { name: 'b' }],
      edges: [],
    });
    expect(result.success).toBe(true);
  });

  test('rejects extra fields in nodes', () => {
    const result = DagDesignSchema.safeParse({
      nodes: [{ name: 'a', extra: 'field' }],
      edges: [],
    });
    expect(result.success).toBe(false);
  });

  test('rejects extra fields in edges', () => {
    const result = DagDesignSchema.safeParse({
      nodes: [{ name: 'a' }, { name: 'b' }],
      edges: [{ parent: 'a', child: 'b', weight: 1 }],
    });
    expect(result.success).toBe(false);
  });

  test('rejects empty node name', () => {
    const result = DagDesignSchema.safeParse({
      nodes: [{ name: '' }],
      edges: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('NodeExecSchema affectedFiles validation', () => {
  test('rejects non-array affectedFiles', () => {
    const result = NodeExecSchema.safeParse({
      reportMarkdown: 'Done',
      affectedFiles: 'not-an-array',
    });
    expect(result.success).toBe(false);
  });

  test('rejects affectedFiles with non-string elements', () => {
    const result = NodeExecSchema.safeParse({
      reportMarkdown: 'Done',
      affectedFiles: ['valid.ts', 123, 'another.ts'],
    });
    expect(result.success).toBe(false);
  });

  test('accepts empty array', () => {
    const result = NodeExecSchema.safeParse({
      reportMarkdown: 'Done',
      affectedFiles: [],
    });
    expect(result.success).toBe(true);
  });

  test('rejects extra fields', () => {
    const result = NodeExecSchema.safeParse({
      reportMarkdown: 'Done',
      affectedFiles: [],
      extraField: 'fail',
    });
    expect(result.success).toBe(false);
  });
});

describe('schemaForStage error handling', () => {
  test('throws on unknown stage', () => {
    expect(() => schemaForStage('unknown_stage')).toThrow();
    expect(() => schemaForStage('')).toThrow();
    expect(() => schemaForStage('GLOBAL_PLAN')).toThrow();
  });
});
