import test from 'node:test'
import assert from 'node:assert/strict'
import { workSummary, workedForLabel } from '../src/session/work-summary.ts'

const ev = (id, text, at, notable = false) => ({ id, actor: 'claude', text, at, notable })

test('duration spans the first to the last timestamp and steps count non-notable events', () => {
  const summary = workSummary([
    ev(1, 'Goal created', '2026-10-07T01:00:00.000Z', true),
    ev(2, 'Action started', '2026-10-07T01:00:02.000Z'),
    ev(3, 'Action finished', '2026-10-07T01:00:17.000Z'),
  ])
  assert.deepEqual({ seconds: summary.seconds, steps: summary.steps }, { seconds: 17, steps: 2 })
})

test('an empty or untimed timeline has no summary', () => {
  assert.equal(workSummary([]), null)
  assert.equal(workSummary([ev(1, 'x', undefined)]), null)
  assert.equal(workSummary([ev(1, 'x', 'not a date')]), null)
})

test('labels read as seconds, minutes and singular steps', () => {
  assert.equal(workedForLabel({ seconds: 5, steps: 1, events: [] }), 'Worked for 5s · 1 step')
  assert.equal(workedForLabel({ seconds: 125, steps: 4, events: [] }), 'Worked for 2m 5s · 4 steps')
})
