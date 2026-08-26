import assert from 'node:assert/strict'
import test from 'node:test'
import { createDubePanelPusher } from '../src/client/music-panel-bridge.ts'

const nodes = [
  { kind: 'user', seq: 1, content: [{ type: 'text', text: 'hello' }] },
  { kind: 'assistant', seq: 2, turn: 1, blocks: [{ kind: 'text', text: 'world' }] },
]

test('panel pusher replays the full snapshot after an iframe reload reset', () => {
  const batches: unknown[][] = []
  const pusher = createDubePanelPusher((events) => {
    batches.push(events)
    return true
  })

  assert.equal(pusher.push(nodes), 2)
  assert.equal(pusher.push(nodes), 0)

  pusher.reset()
  assert.equal(pusher.push(nodes), 2)
  assert.equal(batches.length, 2)
})

test('panel pusher can reset before a new session whose seq starts lower', () => {
  const batches: unknown[][] = []
  const pusher = createDubePanelPusher((events) => {
    batches.push(events)
    return true
  })

  assert.equal(pusher.push([{ ...nodes[0], seq: 50 }]), 1)
  pusher.reset()
  assert.equal(pusher.push(nodes), 2)
  assert.equal(batches.length, 2)
})
