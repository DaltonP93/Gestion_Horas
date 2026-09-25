/** strictId.test.js — validación única de ids enteros positivos. */
const { parsePositiveId, isAbsent } = require('../src/utils/strictId');

describe('parsePositiveId', () => {
  test.each([
    [1, 1], [100, 100], ['1', 1], ['100', 100],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
  ])('válido %p → %p', (v, out) => expect(parsePositiveId(v)).toBe(out));

  test.each([
    ['1e2'], ['0x10'], ['0b1'], ['0o7'], ['1.5'], [1.5], ['1.0'], ['10abc'], ['abc'],
    [' 100'], ['100 '], ['+100'], ['007'], ['0'], [0], ['-1'], [-1], [-0],
    ['9007199254740993'], [9007199254740992], [Infinity], [NaN],
    [true], [false], [[100]], [['100']], [{ id: 100 }], [null], [undefined], [''],
  ])('inválido %p → null', (v) => expect(parsePositiveId(v)).toBeNull());
});

describe('isAbsent', () => {
  test.each([[undefined, true], [null, true], ['', true], ['0', false], [0, false], [[], false]])(
    '%p → %p', (v, out) => expect(isAbsent(v)).toBe(out),
  );
});
