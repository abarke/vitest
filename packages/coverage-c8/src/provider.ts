import { existsSync, promises as fs } from 'fs'
import _url from 'url'
import type { Profiler } from 'inspector'
import { extname, resolve } from 'pathe'
import c from 'picocolors'
import { provider } from 'std-env'
import type { RawSourceMap } from 'vite-node'
import { coverageConfigDefaults } from 'vitest/config'
// eslint-disable-next-line no-restricted-imports
import type { AfterSuiteRunMeta, CoverageC8Options, CoverageProvider, ReportContext, ResolvedCoverageOptions } from 'vitest'
import type { Vitest } from 'vitest/node'
import type { Report } from 'c8'
// @ts-expect-error missing types
import createReport from 'c8/lib/report.js'
// @ts-expect-error missing types
import { checkCoverages } from 'c8/lib/commands/check-coverage.js'

type Options = ResolvedCoverageOptions<'c8'>

export class C8CoverageProvider implements CoverageProvider {
  name = 'c8'

  ctx!: Vitest
  options!: Options
  coverages: Profiler.TakePreciseCoverageReturnType[] = []

  initialize(ctx: Vitest) {
    this.ctx = ctx
    this.options = resolveC8Options(ctx.config.coverage, ctx.config.root)
  }

  resolveOptions() {
    return this.options
  }

  async clean(clean = true) {
    if (clean && existsSync(this.options.reportsDirectory))
      await fs.rm(this.options.reportsDirectory, { recursive: true, force: true, maxRetries: 10 })

    this.coverages = []
  }

  onAfterSuiteRun({ coverage }: AfterSuiteRunMeta) {
    this.coverages.push(coverage as Profiler.TakePreciseCoverageReturnType)
  }

  async reportCoverage({ allTestsRun }: ReportContext = {}) {
    if (provider === 'stackblitz')
      this.ctx.logger.log(c.blue(' % ') + c.yellow('@vitest/coverage-c8 does not work on Stackblitz. Report will be empty.'))

    const options: ConstructorParameters<typeof Report>[0] = {
      ...this.options,
      all: this.options.all && allTestsRun,
    }

    const report = createReport(options)

    // Overwrite C8's loader as results are in memory instead of file system
    report._loadReports = () => this.coverages

    interface MapAndSource { map: RawSourceMap; source: string | undefined }
    type SourceMapMeta = { url: string; filepath: string } & MapAndSource

    // add source maps
    const sourceMapMeta: Record<SourceMapMeta['url'], MapAndSource> = {}
    const extensions = Array.isArray(this.options.extension) ? this.options.extension : [this.options.extension]

    const entries = Array
      .from(this.ctx.vitenode.fetchCache.entries())
      .filter(entry => report._shouldInstrument(entry[0]))
      .map(([file, { result }]) => {
        if (!result.map)
          return null

        const filepath = file.split('?')[0]
        const url = _url.pathToFileURL(filepath).href
        const extension = extname(file) || extname(url)

        return {
          filepath,
          url,
          extension,
          map: result.map,
          source: result.code,
        }
      })
      .filter((entry) => {
        if (!entry)
          return false

        if (!extensions.includes(entry.extension))
          return false

        // Mappings and sourcesContent are needed for C8 to work
        return (
          entry.map.mappings.length > 0
          && entry.map.sourcesContent
          && entry.map.sourcesContent.length > 0
          && entry.map.sourcesContent[0]
          && entry.map.sourcesContent[0].length > 0
        )
      }) as SourceMapMeta[]

    await Promise.all(entries.map(async ({ url, source, map, filepath }) => {
      if (url in sourceMapMeta)
        return

      let code: string | undefined
      try {
        code = (await fs.readFile(filepath)).toString()
      }
      catch { }

      // Vite does not report full path in sourcemap sources
      // so use an actual file path
      const sources = [url]

      sourceMapMeta[url] = {
        source,
        map: {
          sourcesContent: code ? [code] : undefined,
          ...map,
          sources,
        },
      }
    }))

    // This is a magic number. It corresponds to the amount of code
    // that we add in packages/vite-node/src/client.ts:114 (vm.runInThisContext)
    // TODO: Include our transformations in sourcemaps
    const offset = 185

    report._getSourceMap = (coverage: Profiler.ScriptCoverage) => {
      const path = _url.pathToFileURL(coverage.url.split('?')[0]).href
      const data = sourceMapMeta[path]

      if (!data)
        return {}

      return {
        sourceMap: {
          sourcemap: data.map,
        },
        source: Array(offset).fill('.').join('') + data.source,
      }
    }

    await report.run()
    await checkCoverages(options, report)
  }
}

function resolveC8Options(options: CoverageC8Options, root: string): Options {
  const reportsDirectory = resolve(root, options.reportsDirectory || coverageConfigDefaults.reportsDirectory)
  const reporter = options.reporter || coverageConfigDefaults.reporter

  const resolved: Options = {
    ...coverageConfigDefaults,

    // Provider specific defaults
    excludeNodeModules: true,
    allowExternal: false,

    // User's options
    ...options,

    // Resolved fields
    provider: 'c8',
    reporter: Array.isArray(reporter) ? reporter : [reporter],
    reportsDirectory,
  }

  if (options['100']) {
    resolved.lines = 100
    resolved.functions = 100
    resolved.branches = 100
    resolved.statements = 100
  }

  return resolved
}
