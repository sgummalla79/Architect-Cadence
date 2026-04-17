import { collectIndices, LogicParseError, parseLogic } from '../logic-parser';

describe('parseLogic — success cases', () => {
  test('single index', () => {
    expect(parseLogic('1')).toEqual({ type: 'index', value: 1 });
  });

  test('multi-digit index', () => {
    expect(parseLogic('42')).toEqual({ type: 'index', value: 42 });
  });

  test('simple AND', () => {
    expect(parseLogic('1 AND 2')).toEqual({
      type: 'and',
      left: { type: 'index', value: 1 },
      right: { type: 'index', value: 2 },
    });
  });

  test('simple OR', () => {
    expect(parseLogic('1 OR 2')).toEqual({
      type: 'or',
      left: { type: 'index', value: 1 },
      right: { type: 'index', value: 2 },
    });
  });

  test('chained AND is left-associative', () => {
    expect(parseLogic('1 AND 2 AND 3')).toEqual({
      type: 'and',
      left: {
        type: 'and',
        left: { type: 'index', value: 1 },
        right: { type: 'index', value: 2 },
      },
      right: { type: 'index', value: 3 },
    });
  });

  test('AND binds tighter than OR', () => {
    // "1 AND 2 OR 3" → (1 AND 2) OR 3
    expect(parseLogic('1 AND 2 OR 3')).toEqual({
      type: 'or',
      left: {
        type: 'and',
        left: { type: 'index', value: 1 },
        right: { type: 'index', value: 2 },
      },
      right: { type: 'index', value: 3 },
    });
  });

  test('OR then AND — AND still binds tighter', () => {
    // "1 OR 2 AND 3" → 1 OR (2 AND 3)
    expect(parseLogic('1 OR 2 AND 3')).toEqual({
      type: 'or',
      left: { type: 'index', value: 1 },
      right: {
        type: 'and',
        left: { type: 'index', value: 2 },
        right: { type: 'index', value: 3 },
      },
    });
  });

  test('parentheses override precedence', () => {
    // "1 AND (2 OR 3)"
    expect(parseLogic('1 AND (2 OR 3)')).toEqual({
      type: 'and',
      left: { type: 'index', value: 1 },
      right: {
        type: 'or',
        left: { type: 'index', value: 2 },
        right: { type: 'index', value: 3 },
      },
    });
  });

  test('nested parentheses', () => {
    // "(1 OR 2) AND (3 OR 4)"
    expect(parseLogic('(1 OR 2) AND (3 OR 4)')).toEqual({
      type: 'and',
      left: {
        type: 'or',
        left: { type: 'index', value: 1 },
        right: { type: 'index', value: 2 },
      },
      right: {
        type: 'or',
        left: { type: 'index', value: 3 },
        right: { type: 'index', value: 4 },
      },
    });
  });

  test('case insensitive keywords', () => {
    const expected = {
      type: 'and',
      left: { type: 'index', value: 1 },
      right: { type: 'index', value: 2 },
    };
    expect(parseLogic('1 and 2')).toEqual(expected);
    expect(parseLogic('1 AnD 2')).toEqual(expected);
  });

  test('extra whitespace is OK', () => {
    expect(parseLogic('   1   AND   2   ')).toEqual({
      type: 'and',
      left: { type: 'index', value: 1 },
      right: { type: 'index', value: 2 },
    });
  });

  test('redundant parens are OK', () => {
    expect(parseLogic('((1))')).toEqual({ type: 'index', value: 1 });
  });
});

describe('parseLogic — error cases', () => {
  test('empty string throws', () => {
    expect(() => parseLogic('')).toThrow(LogicParseError);
    expect(() => parseLogic('   ')).toThrow(LogicParseError);
  });

  test('unbalanced parens throw', () => {
    expect(() => parseLogic('(1 AND 2')).toThrow(LogicParseError);
    expect(() => parseLogic('1 AND 2)')).toThrow(LogicParseError);
    expect(() => parseLogic('((1)')).toThrow(LogicParseError);
  });

  test('missing operator throws', () => {
    expect(() => parseLogic('1 2')).toThrow(LogicParseError);
    expect(() => parseLogic('1 AND 2 3')).toThrow(LogicParseError);
  });

  test('trailing operator throws', () => {
    expect(() => parseLogic('1 AND')).toThrow(LogicParseError);
    expect(() => parseLogic('1 OR')).toThrow(LogicParseError);
  });

  test('leading operator throws', () => {
    expect(() => parseLogic('AND 1')).toThrow(LogicParseError);
  });

  test('unknown word throws', () => {
    expect(() => parseLogic('1 XOR 2')).toThrow(LogicParseError);
    expect(() => parseLogic('1 NOT 2')).toThrow(LogicParseError);
  });

  test('unexpected character throws', () => {
    expect(() => parseLogic('1 & 2')).toThrow(LogicParseError);
    expect(() => parseLogic('1 + 2')).toThrow(LogicParseError);
  });

  test('empty parens throw', () => {
    expect(() => parseLogic('()')).toThrow(LogicParseError);
    expect(() => parseLogic('1 AND ()')).toThrow(LogicParseError);
  });
});

describe('collectIndices', () => {
  test('single index', () => {
    expect(collectIndices(parseLogic('3'))).toEqual([3]);
  });

  test('flat AND', () => {
    expect(collectIndices(parseLogic('1 AND 2 AND 5'))).toEqual([1, 2, 5]);
  });

  test('nested expression', () => {
    expect(collectIndices(parseLogic('1 AND (2 OR 3)'))).toEqual([1, 2, 3]);
  });

  test('duplicates are preserved', () => {
    expect(collectIndices(parseLogic('1 AND 1'))).toEqual([1, 1]);
  });
});