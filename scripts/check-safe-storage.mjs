// Run with Electron, never Node. This probe only reports safe booleans/error stages;
// it does not write the vault, show decrypted values or invoke a model/network API.
import { app, safeStorage } from 'electron'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const argument = process.argv.indexOf('--vault')
if (argument < 0 || !process.argv[argument + 1]) throw new Error('--vault requires an existing encrypted file')
const encrypted = readFileSync(process.argv[argument + 1])
const directory = mkdtempSync(join(tmpdir(), 'seamo-storage-probe-'))
app.setName('Seamo AI R1')
app.setPath('userData', directory)
const result = { electron: process.versions.electron, bytes: encrypted.length, legacyFormat: encrypted.subarray(0, 3).equals(Buffer.from('v10')) }
const valid = (text) => {
  const value = JSON.parse(text)
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
const timeout = setTimeout(() => { console.log(JSON.stringify({ ...result, timedOut: true })); rmSync(directory, { recursive: true, force: true }); app.exit(2) }, 15000)
void app.whenReady().then(async () => {
  console.log(JSON.stringify({ stage: 'ready', ...result }))
  try {
    result.asyncAvailable = await safeStorage.isAsyncEncryptionAvailable()
    if (result.asyncAvailable) {
      try { result.asyncVaultReadable = valid((await safeStorage.decryptStringAsync(encrypted)).result) }
      catch { result.asyncVaultReadable = false }
    }
    console.log(JSON.stringify(result))
  } catch {
    console.log(JSON.stringify({ ...result, storageError: true }))
  } finally {
    clearTimeout(timeout)
    app.quit()
    rmSync(directory, { recursive: true, force: true })
  }
})
