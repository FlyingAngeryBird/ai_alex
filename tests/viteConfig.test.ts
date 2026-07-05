import { describe, expect, it } from 'vitest'
import viteConfig from '../vite.config'

describe('desktop renderer build config', () => {
  it('uses relative asset URLs so Electron can load the built UI from file://', () => {
    expect(viteConfig).toMatchObject({
      base: './'
    })
  })
})
