import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

// Served by virvi-server at <site>/docs (apps/server/src/app.ts). A self-hosted install can build with its own DOCS_SITE.
export default defineConfig({
  site: process.env.DOCS_SITE || 'https://virvi.io',
  base: '/docs',
  integrations: [
    starlight({
      title: 'Virvi Docs',
      description: 'Virvi documentation: run Virvi, build scenes with it, and extend it. Agents: start at /docs/llms.txt.',
      // The navy wordmark on the light theme, the white one on the dark theme.
      logo: { light: './src/assets/virvi-logo-dark.svg', dark: './src/assets/virvi-logo-light.svg', alt: 'Virvi', replacesTitle: true },
      favicon: '/favicon.svg',
      social: {
        github: 'https://github.com/virvi-xr/virvi',
      },
      sidebar: [
        {
          label: 'Getting Started',
          autogenerate: { directory: 'getting-started' },
        },
        {
          label: 'Using Virvi with an AI agent',
          autogenerate: { directory: 'agents' },
        },
        {
          label: 'Dashboard',
          autogenerate: { directory: 'dashboard' },
        },
        {
          label: 'SDK',
          autogenerate: { directory: 'sdk' },
        },
        {
          label: 'Custom Features',
          autogenerate: { directory: 'custom-features' },
        },
        {
          label: 'API',
          autogenerate: { directory: 'api' },
        },
        {
          label: 'Security',
          autogenerate: { directory: 'security' },
        },
        {
          label: 'Self-Hosting',
          autogenerate: { directory: 'self-hosting' },
        },
        { label: 'Privacy', link: '/docs/privacy/' },
      ],
    }),
  ],
})
