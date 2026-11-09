/** The control-plane host never discovers models over the network. */
import { expect, it } from 'vitest'
import { Config, plainOptions, resolveAdapterOptions } from '../src/config.ts'

it('never follows the network model listing', () => {
  expect(resolveAdapterOptions({})).not.toHaveProperty('listing')
  expect(resolveAdapterOptions(plainOptions(Config({})))).not.toHaveProperty('listing')
  expect(resolveAdapterOptions({ models: [{ id: 'custom' }] })).not.toHaveProperty('listing')
  expect(resolveAdapterOptions({ baseURL: 'https://api.deepseek.com/anthropic/v1' })).not.toHaveProperty('listing')
})
