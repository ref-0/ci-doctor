// The guide, served on ci-doctor.ref0.dev by the site's Worker through its GUIDE binding: static assets only,
// no Worker code, and no domain or workers.dev URL of its own. Build it with
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
    workersDev: false,
    previewUrls: false,
  },
});
