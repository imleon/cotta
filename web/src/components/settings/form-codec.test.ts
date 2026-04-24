import { describe, expect, it } from 'vitest'
import { rowsToRecord, rowsToStringRecord, type KvRow } from './form-codec'

describe('settings form codec', () => {
  it('keeps env rows as literal strings instead of JSON coercion', () => {
    const rows: KvRow[] = [
      { key: 'PORT', value: '3000' },
      { key: 'ENABLED', value: 'true' },
      { key: 'RAW_JSON', value: '{"a":1}' },
    ]

    expect(rowsToStringRecord(rows)).toEqual({
      PORT: '3000',
      ENABLED: 'true',
      RAW_JSON: '{"a":1}',
    })
  })

  it('still allows generic record rows to round-trip JSON values', () => {
    const rows: KvRow[] = [
      { key: 'number', value: '123' },
      { key: 'flag', value: 'true' },
      { key: 'object', value: '{"a":1}' },
    ]

    expect(rowsToRecord(rows)).toEqual({
      number: 123,
      flag: true,
      object: { a: 1 },
    })
  })
})
