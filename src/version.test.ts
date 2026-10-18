import { describe, expect, test } from 'bun:test'
import { compareVersions, parseVersion } from './version'

describe('versions', () => {
  test('strict X.Y.Z only', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3])
    expect(parseVersion(' 0.13.24 ')).toEqual([0, 13, 24])
    for (const bad of ['v1.2.3', '1.2', '1.2.3-beta.1', 'nightly', '1.2.3.4', '']) expect(parseVersion(bad)).toBeNull()
  })
  test('ordering, numerically per part', () => {
    expect(compareVersions('0.13.24', '0.13.25')).toBeLessThan(0)
    expect(compareVersions('0.13.25', '0.13.24')).toBeGreaterThan(0)
    expect(compareVersions('0.2.0', '0.13.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('nightly', '0.0.1')).toBeLessThan(0)
  })
})
