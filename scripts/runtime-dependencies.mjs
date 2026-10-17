import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

/** Use npm's installed production graph, including transitive and nested versions. */
export function productionDependencyPaths(projectRoot) {
  const output = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['ls', '--all', '--omit=dev', '--parseable'], { cwd: projectRoot, encoding: 'utf8', timeout: 30000 })
  return [...new Set(output.trim().split(/\r?\n/).filter(path => path && path !== projectRoot))].map(path => {
    const destination = relative(projectRoot, path)
    if (isAbsolute(destination) || !destination.startsWith(`node_modules${sep}`) || destination.split(sep).includes('..')) {
      throw new Error('Production dependency is outside node_modules')
    }
    return { source: path, destination }
  }).sort((left, right) => left.destination.length - right.destination.length)
}

export function copyProductionDependencies(appDir, dependencies) {
  for (const dependency of dependencies) {
    const target = join(appDir, dependency.destination)
    mkdirSync(dirname(target), { recursive: true })
    // Nested packages are copied from the graph at their own exact installed paths.
    cpSync(dependency.source, target, { dereference: true, recursive: true,
      filter: path => !relative(dependency.source, path).split(sep).includes('node_modules') })
  }
}
