import test from 'node:test'
import assert from 'node:assert/strict'
import { waitReasonLabel } from '../src/session/wait-reason.ts'

test('known admission codes become plain-language lines', () => {
  assert.match(waitReasonLabel('memory_budget_exceeded'), /memory/i)
  assert.match(waitReasonLabel('waiting_for_running_task'), /running task/i)
  assert.match(waitReasonLabel('behind_queue'), /ahead/i)
})

test('unknown codes fall back and empty reasons stay empty', () => {
  assert.equal(waitReasonLabel('something_new'), 'Waiting to start')
  assert.equal(waitReasonLabel(null), null)
  assert.equal(waitReasonLabel(undefined), null)
})
