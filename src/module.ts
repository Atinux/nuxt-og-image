import { readFile, writeFile } from 'node:fs/promises'
import type { NitroRouteRules } from 'nitropack'
import {
  addComponent,
  addImports,
  addServerHandler,
  addTemplate,
  createResolver,
  defineNuxtModule,
} from '@nuxt/kit'
import { execa } from 'execa'
import chalk from 'chalk'
import defu from 'defu'
import { createRouter as createRadixRouter, toRouteMatcher } from 'radix3'
import { joinURL } from 'ufo'
import { relative } from 'pathe'
import type { Browser } from 'playwright-core'
import { tinyws } from 'tinyws'
import sirv from 'sirv'
import type { SatoriOptions } from 'satori'
import { copy, mkdirp, pathExists } from 'fs-extra'
import { provider } from 'std-env'
import createBrowser from './runtime/nitro/providers/browser/node'
import { screenshot } from './runtime/browserUtil'
import type { OgImageOptions, ScreenshotOptions } from './types'
import { setupPlaygroundRPC } from './rpc'
import { exposeModuleConfig } from './nuxt-utils'
import { extractOgImageOptions, stripOgImageOptions } from './utils'

export interface ModuleOptions {
  /**
   * The hostname of your website.
   */
  host: string
  defaults: OgImageOptions
  fonts: `${string}:${number}`[]
  satoriOptions: Partial<SatoriOptions>
  forcePrerender: boolean
  satoriProvider: boolean
  browserProvider: boolean
}

const PATH = '/__nuxt_og_image__'
const PATH_ENTRY = `${PATH}/entry`
const PATH_PLAYGROUND = `${PATH}/client`

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: 'nuxt-og-image',
    compatibility: {
      nuxt: '^3.1.0',
      bridge: false,
    },
    configKey: 'ogImage',
  },
  defaults(nuxt) {
    return {
      // when we run `nuxi generate` we need to force prerendering
      forcePrerender: !nuxt.options.dev && nuxt.options._generate,
      host: nuxt.options.runtimeConfig.public?.siteUrl,
      defaults: {
        component: 'OgImageBasic',
        width: 1200,
        height: 630,
      },
      satoriProvider: true,
      browserProvider: true,
      fonts: [],
      satoriOptions: {},
    }
  },
  async setup(config, nuxt) {
    const { resolve } = createResolver(import.meta.url)

    // default font is inter
    if (!config.fonts.length)
      config.fonts = ['Inter:400', 'Inter:700']

    const distResolve = (p: string) => {
      const cwd = resolve('.')
      if (cwd.endsWith('/dist'))
        return resolve(p)
      return resolve(`../dist/${p}`)
    }

    nuxt.options.experimental.componentIslands = true

    // paths.d.ts
    addTemplate({
      filename: 'nuxt-og-image.d.ts',
      getContents: () => {
        return `// Generated by nuxt-og-image
interface NuxtOgImageNitroRules {
  ogImage?: false | Record<string, any>
}
declare module 'nitropack' {
  interface NitroRouteRules extends NuxtOgImageNitroRules {}
  interface NitroRouteConfig extends NuxtOgImageNitroRules {}
}
export {}
`
      },
    })

    nuxt.hooks.hook('prepare:types', ({ references }) => {
      references.push({ path: resolve(nuxt.options.buildDir, 'nuxt-og-image.d.ts') })
    })

    addServerHandler({
      lazy: true,
      handler: resolve('./runtime/nitro/middleware/og.png'),
    })

    ;['html', 'options', 'svg', 'vnode', 'font']
      .forEach((type) => {
        addServerHandler({
          lazy: true,
          route: `/api/og-image-${type}`,
          handler: resolve(`./runtime/nitro/routes/${type}`),
        })
      })

    // @ts-expect-error untyped
    nuxt.hook('devtools:customTabs', (iframeTabs) => {
      iframeTabs.push({
        name: 'ogimage',
        title: 'OG Image',
        icon: 'carbon:image-search',
        view: {
          type: 'iframe',
          src: '/__nuxt_og_image__/client/',
        },
      })
    })

    // Setup playground. Only available in development
    if (nuxt.options.dev) {
      const playgroundDir = distResolve('./client')
      const {
        middleware: rpcMiddleware,
      } = setupPlaygroundRPC(nuxt, config)
      nuxt.hook('vite:serverCreated', async (server) => {
        server.middlewares.use(PATH_ENTRY, tinyws() as any)
        server.middlewares.use(PATH_ENTRY, rpcMiddleware as any)
        // serve the front end in production
        if (await pathExists(playgroundDir))
          server.middlewares.use(PATH_PLAYGROUND, sirv(playgroundDir, { single: true, dev: true }))
      })
      // allow /__og_image__ to be proxied
      addServerHandler({
        handler: resolve('./runtime/nitro/middleware/playground'),
      })
    }

    ['defineOgImageDynamic', 'defineOgImageStatic', 'defineOgImageScreenshot']
      .forEach((name) => {
        addImports({
          name,
          from: resolve('./runtime/composables/defineOgImage'),
        })
      })

    await addComponent({
      name: 'OgImageBasic',
      filePath: resolve('./runtime/components/OgImageBasic.island.vue'),
      global: true,
      island: true,
    })

    ;['OgImageStatic', 'OgImageDynamic', 'OgImageScreenshot']
      .forEach((name) => {
        addComponent({
          name,
          filePath: resolve(`./runtime/components/${name}`),
          island: true,
        })
      })

    const runtimeDir = resolve('./runtime')
    nuxt.options.build.transpile.push(runtimeDir)

    // get public dir
    const moduleAssetDir = resolve('./runtime/public-assets')
    const assetDirs = [
      resolve(nuxt.options.rootDir, nuxt.options.dir.public),
      moduleAssetDir,
    ]

    // add config to app and nitro
    exposeModuleConfig('nuxt-og-image', { ...config, assetDirs })

    const nitroPreset: string = process.env.NITRO_PRESET || nuxt.options.nitro.preset as string
    const isWebWorkerEnv = process.env.NODE_ENV !== 'development' && (provider === 'stackblitz' || ['cloudflare', 'vercel-edge', 'netlify-edge', 'lambda'].includes(nitroPreset))

    nuxt.hooks.hook('nitro:config', async (nitroConfig) => {
      nitroConfig.externals = defu(nitroConfig.externals || {}, {
        inline: [runtimeDir],
      })

      nitroConfig.publicAssets = nitroConfig.publicAssets || []
      nitroConfig.publicAssets.push({ dir: moduleAssetDir, maxAge: 31536000 })

      const providerPath = `${runtimeDir}/nitro/providers`

      if (config.browserProvider) {
        nitroConfig.virtual!['#nuxt-og-image/browser'] = `
export default async function() {
 return (process.env.prerender || process.env.dev === 'true') ? await import('${providerPath}/browser/node').then(m => m.default) : () => {}
}
`
      }

      if (config.satoriProvider) {
        nitroConfig.virtual!['#nuxt-og-image/satori'] = isWebWorkerEnv
          // edge envs
          ? `export default async function() {
  return (process.env.prerender || process.env.dev === 'true') ? await import('${providerPath}/satori/webworker').then(m => m.default) : await import('${providerPath}/satori/webworker').then(m => m.default)
}`
          // node envs
          : `import node from '${providerPath}/satori/node';
export default function() {
 return node
}
`

        nitroConfig.virtual!['#nuxt-og-image/svg2png'] = `export default async function() {
 return await import('${providerPath}/svg2png/universal').then(m => m.default)
}`
      }

      nitroConfig.virtual!['#nuxt-og-image/provider'] = `
      export async function useProvider(provider) {
        if (provider === 'satori')
          return ${config.satoriProvider ? `await import('${relative(nuxt.options.rootDir, resolve('./runtime/nitro/renderers/satori'))}').then(m => m.default)` : null}
        if (provider === 'browser')
          return (process.env.prerender || process.env.dev) ? ${config.browserProvider ? `await import('${relative(nuxt.options.rootDir, resolve('./runtime/nitro/renderers/browser'))}').then(m => m.default)` : null} : null
      }
      `
    })

    nuxt.hooks.hook('nitro:init', async (nitro) => {
      let screenshotQueue: OgImageOptions[] = []

      nitro.hooks.hook('compiled', async (_nitro) => {
        if (_nitro.options.preset === 'cloudflare' || _nitro.options.preset === 'vercel-edge') {
          await copy(resolve('./runtime/public-assets/inter-latin-ext-400-normal.woff'), resolve(_nitro.options.output.publicDir, 'inter-latin-ext-400-normal.woff'))
          await copy(resolve('./runtime/public-assets/inter-latin-ext-700-normal.woff'), resolve(_nitro.options.output.publicDir, 'inter-latin-ext-700-normal.woff'))
          await copy(resolve('./runtime/public-assets/svg2png.wasm'), resolve(_nitro.options.output.serverDir, 'svg2png.wasm'))
          await copy(resolve('./runtime/public-assets/yoga.wasm'), resolve(_nitro.options.output.serverDir, 'yoga.wasm'))
          // need to replace the token in index.mjs
          const indexFile = resolve(_nitro.options.output.serverDir, 'index.mjs')
          if (await pathExists(indexFile)) {
            const indexContents = await readFile(indexFile, 'utf-8')
            await writeFile(indexFile, indexContents
              .replace('"/* NUXT_OG_IMAGE_SVG2PNG_WASM */"', 'import("./svg2png.wasm").then(m => m.default || m)')
              .replace('"/* NUXT_OG_IMAGE_YOGA_WASM */"', 'import("./yoga.wasm").then(m => m.default || m)')
              .replace('.cwd(),', '?.cwd || "/",'),
            )
          }
        }
      })

      const _routeRulesMatcher = toRouteMatcher(
        createRadixRouter({ routes: nitro.options.routeRules }),
      )

      nitro.hooks.hook('prerender:generate', async (ctx) => {
        // avoid scanning files and the og:image route itself
        if (ctx.route.includes('.') || ctx.route.endsWith('__og_image__/html'))
          return

        const html = ctx.contents

        // we need valid _contents to scan for ogImage options and know the route is good
        if (!html)
          return

        const extractedOptions = extractOgImageOptions(html)
        ctx.contents = stripOgImageOptions(html)
        const routeRules: NitroRouteRules = defu({}, ..._routeRulesMatcher.matchAll(ctx.route).reverse())
        if (!extractedOptions || routeRules.ogImage === false)
          return

        const options: OgImageOptions = {
          path: ctx.route,
          ...extractedOptions,
          ...(routeRules.ogImage || {}),
          ctx,
        }

        // if we're running `nuxi generate` we pre-render everything (including dynamic)
        if ((nuxt.options._generate || options.static) && options.provider === 'browser')
          screenshotQueue.push(options)
      })

      if (nuxt.options.dev)
        return

      const captureScreenshots = async () => {
        if (screenshotQueue.length === 0)
          return

        const previewProcess = execa('npx', ['serve', nitro.options.output.publicDir])
        let browser: Browser | null = null
        try {
          previewProcess.stderr?.pipe(process.stderr)
          // wait until we get a message which says "Accepting connections"
          const host = (await new Promise<string>((resolve) => {
            previewProcess.stdout?.on('data', (data) => {
              if (data.includes('Accepting connections at')) {
                // get the url from data and return it as the promise
                resolve(data.toString().split('Accepting connections at ')[1])
              }
            })
          })).trim()
          browser = await createBrowser()
          if (browser) {
            nitro.logger.info(`Pre-rendering ${screenshotQueue.length} og:image screenshots...`)
            for (const k in screenshotQueue) {
              const entry = screenshotQueue[k]
              const start = Date.now()
              let hasError = false
              const dirname = joinURL(nitro.options.output.publicDir, `${entry.ctx.fileName.replace('index.html', '')}__og_image__/`)
              const filename = joinURL(dirname, '/og.png')
              try {
                const imgBuffer = await screenshot(browser, `${host}${entry.path}`, {
                  ...(config.defaults as ScreenshotOptions || {}),
                  ...(entry || {}),
                })
                try {
                  await mkdirp(dirname)
                }
                catch (e) {}
                await writeFile(filename, imgBuffer)
              }
              catch (e) {
                hasError = true
                console.error(e)
              }
              const generateTimeMS = Date.now() - start
              nitro.logger.log(chalk[hasError ? 'red' : 'gray'](
                `  ${Number(k) === screenshotQueue.length - 1 ? '└─' : '├─'} ${relative(nitro.options.output.publicDir, filename)} (${generateTimeMS}ms) ${Math.round((Number(k) + 1) / (screenshotQueue.length) * 100)}%`,
              ))
            }
          }
          else {
            nitro.logger.log(chalk.red('Failed to create a browser to create og:images.'))
          }
        }
        catch (e) {
          console.error(e)
        }
        finally {
          await browser?.close()
          previewProcess.kill()
        }
        screenshotQueue = []
      }

      // SSR mode
      nitro.hooks.hook('rollup:before', async () => {
        await captureScreenshots()
      })

      // SSG mode
      nitro.hooks.hook('close', async () => {
        await captureScreenshots()
      })
    })
  },
})
