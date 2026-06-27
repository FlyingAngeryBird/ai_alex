import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

const projectRoot = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist-electron/main',
      rollupOptions: {
        input: {
          index: resolve(projectRoot, 'electron/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist-electron/preload',
      rollupOptions: {
        input: {
          index: resolve(projectRoot, 'electron/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    plugins: [vue()],
    build: {
      outDir: 'dist-electron/renderer'
    },
    resolve: {
      alias: {
        '@': resolve(projectRoot, 'src')
      }
    }
  }
})
