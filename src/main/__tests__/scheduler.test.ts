import { describe, test, expect } from 'vitest';
import { isValidTime } from '../prefs-validators';
import { timeToCron } from '../scheduler';

describe('isValidTime', () => {
  test.each(['00:00', '01:30', '12:00', '23:59', '09:05'])(
    'accepts HH:MM %s',
    (s) => expect(isValidTime(s)).toBe(true)
  );

  test.each(['00:00:00', '12:30:45', '23:59:59'])(
    'accepts HH:MM:SS %s',
    (s) => expect(isValidTime(s)).toBe(true)
  );

  test.each(['', '24:00', '12:60', '1:30', '12:5', '12-30', 'abc', null, undefined, 12])(
    'rejects %p',
    (s) => expect(isValidTime(s as unknown)).toBe(false)
  );
});

describe('timeToCron', () => {
  test('midnight', () => {
    expect(timeToCron('00:00')).toBe('0 0 * * *');
  });

  test('noon', () => {
    expect(timeToCron('12:00')).toBe('0 12 * * *');
  });

  test('3:22 PM', () => {
    expect(timeToCron('15:22')).toBe('22 15 * * *');
  });

  test('11:59 PM', () => {
    expect(timeToCron('23:59')).toBe('59 23 * * *');
  });

  test('HH:MM:SS input — seconds ignored', () => {
    expect(timeToCron('15:22:30')).toBe('22 15 * * *');
  });

  test('throws on bad input', () => {
    expect(() => timeToCron('25:00')).toThrow(/Invalid time/);
    expect(() => timeToCron('not-a-time')).toThrow(/Invalid time/);
    expect(() => timeToCron('')).toThrow(/Invalid time/);
  });
});