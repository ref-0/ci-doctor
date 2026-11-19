// The guide on ci-doctor.ref0.dev: static assets only, no Worker code. Build it with
// `node scripts/site/build.ts`, then deploy from this folder with `cf deploy ../../dist/site`, as README.md says.
import { defineConfig } from 'cf/config';

export default defineConfig({
  worker: {
    name: 'ci-doctor-guide',
    compatibilityDate: '2026-11-01',
    assets: {
      // /guide/scripts/local redirects to /guide/scripts/local/, which serves that folder's index.html.
      htmlHandling: 'auto-trailing-slash',
      notFoundHandling: 'none',
    },
    // The whole host. When the score site's Worker takes ci-doctor.ref0.dev, it serves this build at the same
    // paths, and this Worker goes.
    domains: ['ci-doctor.ref0.dev'],
    workersDev: false,
    previewUrls: false,
  },
});
