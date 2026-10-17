import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { viteSingleFile } from 'vite-plugin-singlefile'

const root = fileURLToPath(new URL('.', import.meta.url))
const project = resolve(root, '../../..')

export default defineConfig({
  root,
  base: './',
  plugins: [vue(), viteSingleFile()],
  resolve: {
    alias: { '@': resolve(project, 'src') },
    dedupe: ['vue', 'three']
  },
  server: {
    host: '127.0.0.1',
    port: 59431,
    strictPort: true,
    fs: { allow: [project] }
  },
  build: { outDir: 'dist', emptyOutDir: true }
})
