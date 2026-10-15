import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { copyProductionDependencies, productionDependencyPaths } from './runtime-dependencies.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim()
if (execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: projectRoot, encoding: 'utf8' }).trim()) {
  throw new Error('Commit the reviewed source before packaging so the app has a recoverable source version.')
}
const electronApp = join(projectRoot, 'node_modules/electron/dist/Electron.app')
const outputAppRelative = 'release/seamo-ai-r1-darwin-arm64/Seamo AI R1.app'
const outputArgument = process.argv.indexOf('--output-dir')
if (outputArgument >= 0 && !process.argv[outputArgument + 1]) throw new Error('--output-dir requires a path')
const outputApp = outputArgument >= 0
  ? join(resolve(process.argv[outputArgument + 1]), 'Seamo AI R1.app')
  : join(projectRoot, outputAppRelative)
const outputDir = dirname(outputApp)
const resourcesDir = join(outputApp, 'Contents/Resources')
const appDir = join(resourcesDir, 'app')
const macOsDir = join(outputApp, 'Contents/MacOS')
const frameworkResourcesDir = join(
  outputApp,
  'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources'
)

const requiredRuntimeModules = Object.keys(JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')).dependencies)
const productionDependencies = productionDependencyPaths(projectRoot)
const requiredChromiumResourceFiles = ['icudtl.dat']
const microphoneUsageDescription = 'Seamo AI R1 需要使用麦克风来完成语音对话。'

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
copyProductionDependencies(appDir, productionDependencies)
writeFileSync(join(appDir, 'build-info.json'), JSON.stringify({ sourceCommit, builtAt: new Date().toISOString(),
  channel: 'development-preview', signing: 'local-ad-hoc', notarized: false,
  assetReleaseId: JSON.parse(readFileSync(join(projectRoot, 'r1-assets/asset-manifest.json'), 'utf8')).releaseId,
  productionPackages: productionDependencies.length }, null, 2))
const packagedRequire = createRequire(join(appDir, 'package.json'))
const canonicalModules = realpathSync(join(appDir, 'node_modules'))
for (const moduleName of requiredRuntimeModules) {
  if (!packagedRequire.resolve(moduleName).startsWith(`${canonicalModules}/`)) {
    throw new Error(`Runtime dependency resolved outside the app: ${moduleName}`)
  }
}

copyRequiredChromiumResources()
patchInfoPlist()
renameMainExecutable()
signForLocalDevelopment()

console.log(`Packaged macOS app: ${outputApp}`)
