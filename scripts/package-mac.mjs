import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electronApp = join(projectRoot, 'node_modules/electron/dist/Electron.app')
const outputAppRelative = 'release/seamo-ai-r1-darwin-arm64/Seamo AI R1.app'
const outputApp = join(projectRoot, outputAppRelative)
const outputDir = dirname(outputApp)
const resourcesDir = join(outputApp, 'Contents/Resources')
const appDir = join(resourcesDir, 'app')
const macOsDir = join(outputApp, 'Contents/MacOS')
const frameworkResourcesDir = join(
  outputApp,
  'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources'
)

const requiredRuntimeModules = ['dotenv', 'ws']
const requiredChromiumResourceFiles = ['icudtl.dat']
const microphoneUsageDescription = 'Seamo AI R1 需要使用麦克风来完成语音对话。'

function copyRequiredModule(name) {
  const source = join(projectRoot, 'node_modules', name)
  const target = join(appDir, 'node_modules', name)

  if (!existsSync(source)) {
    throw new Error(`Missing runtime dependency: ${name}`)
  }

  cpSync(source, target, {
    dereference: true,
    recursive: true
  })
}

function copyRequiredChromiumResources() {
  for (const filename of requiredChromiumResourceFiles) {
    const source = join(frameworkResourcesDir, filename)

    if (!existsSync(source)) {
      throw new Error(`Missing Electron runtime resource: ${filename}`)
    }

    cpSync(source, join(resourcesDir, filename))
  }
}

function renameMainExecutable() {
  const electronExecutable = join(macOsDir, 'Electron')
  const seamoExecutable = join(macOsDir, 'Seamo AI R1')

  if (!existsSync(electronExecutable)) {
    throw new Error('Electron executable was not found in the packaged app.')
  }

  if (existsSync(seamoExecutable)) {
    rmSync(seamoExecutable, {
      force: true
    })
  }

  renameSync(electronExecutable, seamoExecutable)
}

function patchInfoPlist() {
  const plistPath = join(outputApp, 'Contents/Info.plist')
  let plist = readFileSync(plistPath, 'utf8')

  plist = plist
    .replace(/<string>Electron<\/string>/g, '<string>Seamo AI R1</string>')
    .replace(/<string>com\.github\.Electron<\/string>/g, '<string>com.seamo.ai.r1</string>')

  if (plist.includes('NSMicrophoneUsageDescription')) {
    plist = plist.replace(
      /(<key>NSMicrophoneUsageDescription<\/key>\s*<string>)([^<]*)(<\/string>)/,
      `$1${microphoneUsageDescription}$3`
    )
  } else {
    plist = plist.replace(
      '</dict>',
      [
        '  <key>NSMicrophoneUsageDescription</key>',
        `  <string>${microphoneUsageDescription}</string>`,
        '</dict>'
      ].join('\n')
    )
  }

  writeFileSync(plistPath, plist)
}

function signForLocalDevelopment() {
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', outputApp], {
    stdio: 'inherit'
  })
}

if (!existsSync(electronApp)) {
  throw new Error('Electron.app was not found. Run npm install first.')
}

rmSync(outputApp, {
  force: true,
  recursive: true
})
mkdirSync(outputDir, {
  recursive: true
})

cpSync(electronApp, outputApp, {
  recursive: true,
  verbatimSymlinks: true
})
rmSync(appDir, {
  force: true,
  recursive: true
})
mkdirSync(join(appDir, 'node_modules'), {
  recursive: true
})

cpSync(join(projectRoot, 'dist-electron'), join(appDir, 'dist-electron'), {
  dereference: true,
  recursive: true
})
cpSync(join(projectRoot, 'package.json'), join(appDir, 'package.json'))
cpSync(join(projectRoot, 'r1-assets'), join(appDir, 'r1-assets'), {
  dereference: true,
  recursive: true
})
for (const moduleName of requiredRuntimeModules) {
  copyRequiredModule(moduleName)
}

copyRequiredChromiumResources()
patchInfoPlist()
renameMainExecutable()
signForLocalDevelopment()

console.log(`Packaged macOS app: ${outputApp}`)
